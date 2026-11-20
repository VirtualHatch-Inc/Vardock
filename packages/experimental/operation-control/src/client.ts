/** Agent Host client for a separately launched operation authority. */
import { request } from 'node:http'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  brokerConnectionsSchema, businessActionsSchema, businessOperationsSchema, businessOperationStatusSchema, businessRecordsSchema,
  exportedFileSchema, failureSchema, fileReceiptDigest, MAX_FILE_WIRE_BYTES,
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_SOCKET_PATH_BYTES, OperationControlError,
  operationGrantBudgetSchema, operationOverviewSchema, operationReceiptsSchema, reviewWaitSchema, statusSchema, workInputPath,
  type BrokerConnections, type BrokerConnectionUpdate, type BusinessActions, type BusinessOperations, type BusinessOperationStatus,
  type BusinessRecords, type BusinessResolution,
  type ExportedFile, type FileProposal, type FileTransferReceipt,
  type OperationApprovalDecision, type OperationGrantBudget, type OperationGrantUpdate,
  type OperationId, type OperationOverview, type OperationProposal, type OperationReceipts, type OperationStatus, type WorkId,
} from './protocol.ts'

export { DEFAULT_MAX_FILE_BYTES, MAX_FILE_TRANSFER_BYTES, MAX_WORK_INPUTS, OperationControlError, WorkPrincipalId, workInputPath } from './protocol.ts'
export type {
  BrokerConnections, BrokerConnectionUpdate,
  BusinessOperations, BusinessOperationStatus, BusinessRecords, BusinessResolution, OperationApprovalDecision, OperationApprovalReview,
  OperationGrantBudget, OperationGrantUpdate, OperationId, OperationOutcome, OperationOverview, OperationProposal, OperationStatus,
  ExportedFile, FileOutcome, FileProposal, FileTransferReceipt, WorkDelegation, WorkGrant, WorkId, WorkInputFile, WorkPermissions,
} from './protocol.ts'

/** Transport settings for the operation authority client. */
export interface OperationControlClientOptions {
  /** Unix socket owned by the authority. */
  readonly socketPath: string
  /** Total request lifetime in milliseconds. */
  readonly timeoutMs?: number
  /** Upper bound on encoded request bytes. */
  readonly maxRequestBytes?: number
}

/** Proposes and executes operations through a configured Unix socket. */
export class OperationControlClient {
  /** @param options - operator-selected authority socket and transport limits. */
  constructor(private readonly options: OperationControlClientOptions) {
    const { socketPath, timeoutMs = 120_000, maxRequestBytes = MAX_REQUEST_BYTES } = options
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS ||
      !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 256 || maxRequestBytes > MAX_REQUEST_BYTES) {
      throw new OperationControlError('bad-config', 'Configure an absolute operation socket path and bounded request limits.')
    }
  }

  /**
   * Reserve the operation and obtain its approval review or admission evidence.
   * @param proposal - exact command or projected model request and Host-selected idempotency key.
   * @param signal - client wait cancellation. An admitted operation remains queryable.
   * @returns the current status for the request key.
   */
  propose(proposal: OperationProposal, signal?: AbortSignal): Promise<OperationStatus> {
    return this.sendStatus('file' in proposal ? 'propose-file' : 'propose', proposal, undefined, signal)
  }

  /**
   * Execute one exact transfer and verify the returned witness receipt.
   * @param proposal - Stable transfer key, worker Session, and exact input or export request.
   * @param signal - Cancels the client wait. A reserved transfer can be recovered with the same proposal.
   * @returns Witnessed transfer metadata. A file export's bytes require a separate read.
   */
  async transferFile(proposal: FileProposal, signal?: AbortSignal): Promise<FileTransferReceipt> {
    let status = await this.propose(proposal, signal)
    signal?.throwIfAborted()
    if (status.state === 'issued') status = await this.execute(status.id, signal)
    else if (status.state === 'running' || status.state === 'pending-outcome-evidence') status = await this.status(status.id, signal)
    signal?.throwIfAborted()
    const { id, state, outcome, receipt } = status
    if (state !== 'settled') {
      throw new OperationControlError(outcome?.kind === 'unknown' ? outcome.code : 'file-not-settled',
        'The file transfer is unconfirmed. Inspect its operation before retrying.', id)
    }
    const { file } = proposal
    const matches = file.kind === 'import'
      ? outcome?.kind === 'file-imported' && outcome.path === workInputPath(file.source) &&
        outcome.digest === file.source.attachmentId && outcome.bytes === file.source.bytes && isDeepStrictEqual(outcome.source, file.source)
      : outcome?.kind === 'file-exported' && outcome.path === file.path && outcome.targetSessionId === file.targetSessionId
    if (!matches || (outcome?.kind !== 'file-imported' && outcome?.kind !== 'file-exported') || outcome.workId !== file.workId ||
      receipt?.id !== `${id}-outcome` || receipt.digest !== fileReceiptDigest(id, outcome)) {
      throw new OperationControlError('file-mismatch', 'The authority reply does not match the requested file transfer.', id)
    }
    return { operationId: id, outcome, receipt }
  }

  /**
   * Read an existing export through the current disclosure grant and verify its exact bytes.
   * @param operationId - Operation that created the export snapshot.
   * @param signal - Cancels the client wait independently of the retained snapshot.
   * @returns The witnessed export and canonical Base64 bytes.
   */
  readExportedFile(operationId: OperationId, signal?: AbortSignal): Promise<ExportedFile> {
    return this.send('read-export', { id: operationId }, operationId, (value) => {
      const exported = exportedFileSchema.parse(value)
      if (exported.operationId !== operationId) throw new Error('The exported file has a different operation ID')
      return exported
    }, signal)
  }

  /**
   * Record a human decision through a client connected to the privileged approval socket.
   * @param decision - The decision and exact binding returned for review.
   * @param signal - Cancels the wait. A decision may already have committed.
   * @returns The current status after applying the decision and attempting to retain its evidence.
   */
  decide(decision: OperationApprovalDecision, signal?: AbortSignal): Promise<OperationStatus> {
    return this.sendStatus('decide', decision, decision.id, signal)
  }

  /**
   * Read the grant settings through the privileged approval socket, including after expiry.
   * @param signal - Cancels the client wait.
   * @returns The current limits, reservations, revision required to update the limits, and witness receipt of the
   *   configuration record of the authority's start.
   * @throws With `configuration-evidence-unavailable` until the witness confirms that record, or on transport failure.
   */
  grant(signal?: AbortSignal): Promise<OperationGrantBudget> {
    return this.send('grant-settings', {}, undefined, value => operationGrantBudgetSchema.parse(value), signal)
  }

  /**
   * Set the grant's limits through the privileged approval socket. A witnessed change takes effect on commit.
   * @param update - The revision last read by the owner and the desired budget and expiry.
   * @param signal - Cancels the client wait. Read the settings again to resolve an interrupted wait.
   * @returns The effective grant settings and its edit revision.
   * @throws On a stale revision, an update already in progress, unavailable evidence, or transport failure.
   */
  updateGrant(update: OperationGrantUpdate, signal?: AbortSignal): Promise<OperationGrantBudget> {
    return this.send('update-grant', update, undefined, (value) => {
      const budget = operationGrantBudgetSchema.parse(value)
      if (budget.maxOperations !== update.maxOperations || budget.expiresAt !== update.expiresAt) {
        throw new Error('The grant update reply has different limits')
      }
      return budget
    }, signal)
  }

  /**
   * Read the witness receipts the authority holds for some operations through the privileged approval socket.
   * The read changes no record and requests no evidence.
   * @param ids - Up to {@link MAX_RECEIPT_LOOKUP} operation IDs.
   * @param signal - Cancels the client wait.
   * @returns The receipts of each operation the authority has; an operation it lacks is absent.
   */
  receipts(ids: readonly OperationId[], signal?: AbortSignal): Promise<OperationReceipts> {
    return this.send('operation-receipts', { ids }, undefined, value => operationReceiptsSchema.parse(value), signal)
  }

  /**
   * Read one page of business records across every Session through the privileged approval socket, newest first.
   * The read changes no record and requests no evidence.
   * @param after - Cursor from the preceding page, when reading older records.
   * @param signal - Cancels the client wait.
   * @returns Up to {@link MAX_BUSINESS_RECORDS} records with each exact request body, and a cursor when older ones exist.
   */
  businessRecords(after?: OperationId, signal?: AbortSignal): Promise<BusinessRecords> {
    return this.send('business-records', { after }, undefined, value => businessRecordsSchema.parse(value), signal)
  }

  /**
   * Record the owner's checked outcome on the approval socket, effective only after witness confirmation.
   * @param resolution - Retained operation and the outcome the owner determined.
   * @param signal - Cancels the wait; reread records if the reply is lost.
   * @returns The operation with its witnessed completion, or unconfirmed when the witness is unavailable.
   */
  resolveBusiness(resolution: BusinessResolution, signal?: AbortSignal): Promise<BusinessOperationStatus> {
    return this.send('resolve-business', resolution, resolution.id, (value) => {
      const status = businessOperationStatusSchema.parse(value)
      if (status.id !== resolution.id) throw new Error('Business status has a different operation ID')
      return status
    }, signal)
  }

  /**
   * List permitted broker actions and their credential state through the privileged approval socket.
   * @param signal - Cancels the client wait.
   * @returns Each permitted action with whether a credential is stored, never the value.
   */
  brokerConnections(signal?: AbortSignal): Promise<BrokerConnections> {
    return this.send('broker-connections', {}, undefined, value => brokerConnectionsSchema.parse(value), signal)
  }

  /**
   * Change one connection through the privileged approval socket: its stored bearer token, or a permitted action's unattended rules.
   * @param update - Target and its replacement token or `null` to remove the stored one, or an action's complete
   *   rule list with the grant revision last read.
   * @param signal - Cancels the client wait. Read the connections again to resolve an interrupted wait.
   * @returns The connections after the change, never a credential value.
   * @throws When the action is not permitted, the token is invalid, the revision is stale, or the authority has no connection settings.
   */
  setBrokerConnection(update: BrokerConnectionUpdate, signal?: AbortSignal): Promise<BrokerConnections> {
    return this.send('set-broker-connection', update, undefined, value => brokerConnectionsSchema.parse(value), signal)
  }

  /**
   * Consume an issued operation once, or read its existing settlement.
   * @param id - authority-issued operation ID.
   * @param signal - client wait cancellation. Use cancel to request server cancellation.
   * @returns the latest operation status.
   */
  execute(id: OperationId, signal?: AbortSignal): Promise<OperationStatus> {
    return this.sendStatus('execute', { id }, id, signal)
  }

  /**
   * Wait for a business request made by the given shell execution.
   * @param parentId - The parent shell operation being executed.
   * @param signal - Cancels this wait independently of the parent.
   * @returns The pending child review, or undefined when the authority's wait ends without one.
   * @throws `broker-parent-inactive` when the parent is no longer eligible for review.
   */
  waitReview(parentId: OperationId, signal?: AbortSignal): Promise<OperationStatus | undefined> {
    return this.send('wait-review', { id: parentId }, parentId, (value) => {
      const { review } = reviewWaitSchema.parse(value)
      if (review !== undefined) {
        const details = review.review
        if (details === undefined || !('business' in details) || details.business.parentId !== parentId) {
          throw new Error('The review is not for this parent execution')
        }
      }
      return review
    }, signal)
  }

  /**
   * Read a prior operation and retry any pending admission, revocation, or outcome evidence.
   * @param id - authority-issued operation ID.
   * @param signal - client wait cancellation. Use cancel to request server cancellation.
   * @returns the latest operation status.
   */
  status(id: OperationId, signal?: AbortSignal): Promise<OperationStatus> {
    return this.sendStatus('status', { id }, id, signal)
  }

  /**
   * Inspect the shared grant and retained status without advancing any operation or contacting external services.
   * @param sessionId - Trusted Session whose operations are summarized.
   * @param signal - Cancels the client wait.
   * @param workId - Limit operation counts to one assignment when supplied.
   * @returns Current grant budget and a payload-free summary, available after expiry.
   */
  overview(sessionId: SessionId, signal?: AbortSignal, workId?: WorkId): Promise<OperationOverview> {
    return this.send('overview', { sessionId, workId }, undefined, (value) => {
      const overview = operationOverviewSchema.parse(value)
      if (overview.sessionId !== sessionId || overview.workId !== workId) throw new Error('Operation overview has a different scope')
      return overview
    }, signal)
  }

  /**
   * List the broker actions the Assistant grant permits without contacting any business service.
   * @param signal - Cancels the client wait.
   * @returns Each permitted action with its provider's usage text, in ascending action ID order.
   */
  businessActions(signal?: AbortSignal): Promise<BusinessActions> {
    return this.send('business-actions', {}, undefined, value => businessActionsSchema.parse(value), signal)
  }

  /**
   * Inspect recent business operations without contacting any business service.
   * @param sessionId - Trusted identity of the Session that submitted the requests.
   * @param signal - Cancels the client wait.
   * @param after - Cursor from the preceding page, when reading older operations.
   * @param workId - Limit the page and cursor to one assignment when supplied.
   * @returns A bounded Session-bound page with dispatch and business completion reported separately.
   */
  businessOperations(sessionId: SessionId, signal?: AbortSignal, after?: OperationId, workId?: WorkId): Promise<BusinessOperations> {
    return this.send('business-operations', { sessionId, after, workId }, undefined, (value) => {
      const page = businessOperationsSchema.parse(value)
      if (page.sessionId !== sessionId || page.workId !== workId) throw new Error('Business operation list has a different scope')
      return page
    }, signal)
  }

  /**
   * Check the business service once or seal a retained lookup observation.
   * @param sessionId - Trusted identity of the Session that submitted the original request.
   * @param id - Original operation ID in the specified Session.
   * @param signal - Cancels the client wait. An accepted lookup can still complete.
   * @param workId - Require the original operation to belong to this assignment when supplied.
   * @returns Original dispatch and independent business completion with any witness receipts.
   */
  reconcile(sessionId: SessionId, id: OperationId, signal?: AbortSignal, workId?: WorkId): Promise<BusinessOperationStatus> {
    return this.send('reconcile', { sessionId, id, workId }, id, (value) => {
      const status = businessOperationStatusSchema.parse(value)
      if (status.id !== id || status.sessionId !== sessionId) throw new Error('Business status has a different operation or Session ID')
      return status
    }, signal)
  }

  /**
   * Withdraw a pending review or unconsumed permit, or request cancellation of a running operation.
   * @param id - authority-issued operation ID.
   * @param signal - client wait cancellation. Use cancel to request server cancellation.
   * @returns the latest operation status.
   */
  cancel(id: OperationId, signal?: AbortSignal): Promise<OperationStatus> {
    return this.sendStatus('cancel', { id }, id, signal)
  }

  private sendStatus(
    action: string,
    input: OperationProposal | OperationApprovalDecision | { id: OperationId },
    id: OperationId | undefined,
    signal?: AbortSignal,
  ): Promise<OperationStatus> {
    return this.send(action, input, id, (value) => {
      const status = statusSchema.parse(value)
      if (id !== undefined && status.id !== id) throw new Error('Operation response has a different operation ID')
      return status
    }, signal)
  }

  private async send<T>(
    action: string,
    input: object,
    id: OperationId | undefined,
    decode: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = Buffer.from(JSON.stringify(input))
    const requestLimit = action === 'propose-file' ? MAX_FILE_WIRE_BYTES : this.options.maxRequestBytes ?? MAX_REQUEST_BYTES
    const responseLimit = action === 'read-export' ? MAX_FILE_WIRE_BYTES : MAX_RESPONSE_BYTES
    if (body.length > requestLimit) {
      throw new OperationControlError('request-too-large', 'The operation request exceeds the byte limit.', id)
    }
    using limit = deadline(signal, this.options.timeoutMs ?? 120_000, 'operation-control-timeout')
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = request({
          method: 'POST',
          socketPath: this.options.socketPath,
          path: '/' + action,
          agent: false,
          signal: limit.signal,
          headers: {
            'content-type': 'application/json', 'content-length': body.length,
            ...(action === 'propose-file' ? { connection: 'keep-alive' } : {}),
          },
        }, (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('error', reject)
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > responseLimit) {
              response.destroy(new Error('Operation authority response exceeds the byte limit'))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (response.statusCode === 200) {
                resolve(decode(value))
              } else {
                const failure = failureSchema.parse(value)
                if (id !== undefined && failure.operationId !== undefined && failure.operationId !== id) {
                  throw new Error('Operation failure has a different operation ID')
                }
                reject(new OperationControlError(failure.code, failure.message, failure.operationId ?? id))
              }
            } catch (error: unknown) {
              reject(new Error('The authority returned an invalid response', { cause: error }))
            }
          })
        })
        req.on('error', reject)
        req.end(body)
      })
    } catch (error: unknown) {
      if (error instanceof OperationControlError) throw error
      throw new OperationControlError('authority-unavailable', 'Operation authority reply is unavailable. Query the operation before continuing.', id, { cause: error })
    }
  }
}
