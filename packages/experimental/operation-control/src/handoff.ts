/** Host service for durable release of Assistant handoffs. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { OperationControlClient, OperationControlError } from './client.ts'
import {
  handoffOutcome, handoffReceiptDigest, WITNESS_WAITING_MESSAGE, type ExportedFile, type FileProposal, type FileTransferReceipt,
  type BrokerConnections, type BrokerConnectionUpdate, type BusinessResolution, type BusinessRecords,
  type BusinessOperations, type BusinessOperationStatus, type OperationGrantBudget, type OperationGrantUpdate,
  type OperationId, type OperationOverview, type OperationStatus,
  type WorkDelegation, type WorkGrant, type WorkId,
} from './protocol.ts'

export { OperationControlError } from './client.ts'
export {
  DEFAULT_MAX_FILE_BYTES, MAX_FILE_TRANSFER_BYTES, MAX_WORK_INPUTS,
  workGrantSchema, workInputFileSchema, workInputPath, workPermissionsSchema, WorkPrincipalId,
} from './protocol.ts'
export type {
  BrokerConnections, BrokerConnectionUpdate, BusinessResolution, BusinessRecords,
  BusinessOperations, BusinessOperationStatus, ExportedFile, FileOutcome, FileProposal, FileTransferReceipt,
  OperationGrantBudget, OperationGrantUpdate, OperationId, OperationOverview,
  WorkDelegation, WorkGrant, WorkId, WorkInputFile, WorkPermissions,
} from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    handoffControl: HandoffControl
  }
}

interface HandoffPayload {
  /** Stable Host-selected identity of one logical handoff within its kind and source Session. */
  readonly key: string
  readonly sessionId: SessionId
  readonly targetSessionId: SessionId
  /** Serialized payload applied by the Host. */
  readonly content: string
}

/** The exact handoff the Host intends to apply after a durable release. */
export type HandoffRequest = HandoffPayload & (
  | { readonly kind: 'delegation'; readonly delegation: WorkDelegation }
  | { readonly kind: 'delivery' }
)

/** A durably witnessed release the Host may apply while the grant is current. */
export interface HandoffRelease {
  readonly operationId: OperationId
  readonly receipt: {
    readonly id: string
    readonly digest: string
  }
  /** Resolved work grant on a delegation release. */
  readonly work?: WorkGrant
}

/** Service Definition for authorizing and witnessing Assistant handoffs. */
export abstract class HandoffControl extends Service {
  constructor(ctx: Context) {
    super(ctx, 'handoffControl')
  }

  /**
   * Release the exact handoff for the Host to apply. The Host owns application and deduplication of its effects.
   * @param request - Host-owned key, source and target Sessions, and exact payload.
   * @param signal - Cancels the Host wait. An authority release may already have committed.
   * @returns The release identity, independent outcome receipt, and resolved grant for a delegation.
   * @throws If release is denied, unavailable, or unconfirmed.
   */
  abstract release(request: HandoffRequest, signal?: AbortSignal): Promise<HandoffRelease>

  /**
   * Execute a witnessed file transfer under the active work grant.
   * @param _proposal - Exact file transfer request.
   * @param _signal - Cancels the Host wait. A reservation may already have committed.
   * @returns Exact transfer metadata and its independent receipt.
   * @throws If the provider lacks transfers, or the authority denies or cannot confirm this transfer.
   */
  transferFile(_proposal: FileProposal, _signal?: AbortSignal): Promise<FileTransferReceipt> {
    return Promise.reject(new OperationControlError('file-unavailable', 'The work authority does not provide file transfers.'))
  }

  /**
   * Read a verified export if its disclosure is still authorized.
   * @param operationId - The retained export operation.
   * @param _signal - Cancels the Host wait.
   * @returns The snapshot and its witness receipt.
   * @throws If the provider lacks transfers, or the snapshot is unavailable or no longer authorized.
   */
  readExportedFile(operationId: OperationId, _signal?: AbortSignal): Promise<ExportedFile> {
    return Promise.reject(new OperationControlError('file-unavailable', 'The work authority does not provide file transfers.', operationId))
  }

  /**
   * Inspect the authority's grant and operation counts without dispatch or witness writes.
   * @param _sessionId - Trusted Session selected by the Host.
   * @param _signal - Cancels the Host wait.
   * @param _workId - Limit operation counts to one assignment when supplied.
   * @returns Current grant budget and a payload-free summary, available after expiry.
   * @throws If the provider lacks status reads or the authority is unavailable.
   */
  overview(_sessionId: SessionId, _signal?: AbortSignal, _workId?: WorkId): Promise<OperationOverview> {
    return Promise.reject(new OperationControlError('authority-unavailable', 'The work authority does not provide operation summaries.'))
  }

  /**
   * Read editable grant settings. The caller must authorize the owner before calling.
   * @param _signal - Cancels the Host wait.
   * @returns The current grant and edit revision, including after expiry.
   * @throws If this provider lacks owner access or the authority is unavailable.
   */
  grantSettings(_signal?: AbortSignal): Promise<OperationGrantBudget> {
    return Promise.reject(new OperationControlError('grant-settings-unavailable', 'The work authority does not provide grant settings.'))
  }

  /**
   * Edit the witnessed limits through the owner channel. The caller must authorize the owner before calling.
   * @param _update - The revision last read by the owner and the desired budget and expiry.
   * @param _signal - Cancels the Host wait. The caller can read the current settings to resolve an interrupted wait.
   * @returns The effective grant settings and its edit revision.
   * @throws If owner access is unavailable, the update is stale or concurrent, or the authority cannot confirm the change.
   */
  updateGrant(_update: OperationGrantUpdate, _signal?: AbortSignal): Promise<OperationGrantBudget> {
    return Promise.reject(new OperationControlError('grant-settings-unavailable', 'The work authority does not provide grant settings.'))
  }

  /**
   * List permitted broker actions and their credential state. The caller must authorize the owner before calling.
   * @param _signal - Cancels the Host wait.
   * @returns Each permitted action with whether a credential is stored, never the value.
   * @throws If this provider lacks owner access or the authority has no connection settings.
   */
  brokerConnections(_signal?: AbortSignal): Promise<BrokerConnections> {
    return Promise.reject(new OperationControlError('broker-unavailable', 'The work authority does not provide connection settings.'))
  }

  /**
   * Change one connection through the owner channel: its stored bearer token, or a permitted action's unattended rules.
   * The caller must authorize the owner before calling.
   * @param _update - Target and its replacement token or `null` to remove the stored one, or an action's complete
   *   rule list with the grant revision last read.
   * @param _signal - Cancels the Host wait. The caller can read the connections to resolve an interrupted wait.
   * @returns The connections after the change, never a credential value.
   * @throws If owner access is unavailable, the action is not permitted, the token is invalid, or the revision is stale.
   */
  setBrokerConnection(_update: BrokerConnectionUpdate, _signal?: AbortSignal): Promise<BrokerConnections> {
    return Promise.reject(new OperationControlError('broker-unavailable', 'The work authority does not provide connection settings.'))
  }

  /**
   * Read one page of business records across every Session, newest first. The caller must authorize the owner before calling.
   * @param _after - Cursor from the preceding page when supplied.
   * @param _signal - Cancels the Host wait.
   * @returns Each record's status and exact request body, and a cursor when older records exist.
   * @throws If this provider lacks owner access or the authority is unavailable.
   */
  businessRecords(_after?: OperationId, _signal?: AbortSignal): Promise<BusinessRecords> {
    return Promise.reject(new OperationControlError('authority-unavailable', 'The work authority does not provide business records.'))
  }

  /**
   * Record an owner-checked business outcome. The caller must authorize the owner before calling.
   * @param _resolution - Retained operation and the outcome the owner determined.
   * @param _signal - Cancels the Host wait; reread records if the reply is lost.
   * @returns The operation with witnessed completion, or unconfirmed without a witness receipt.
   * @throws If owner access is unavailable or the operation is not unresolved.
   */
  resolveBusiness(_resolution: BusinessResolution, _signal?: AbortSignal): Promise<BusinessOperationStatus> {
    return Promise.reject(new OperationControlError('authority-unavailable', 'The work authority does not provide owner outcome determinations.'))
  }

  /**
   * Read sanitized business status from the authority without contacting the business service.
   * @param _sessionId - Trusted Session selected by the Host.
   * @param _signal - Cancels the Host wait.
   * @param _after - Cursor from the preceding page when supplied.
   * @param _workId - Limit the page and cursor to one assignment when supplied.
   * @returns The bounded page of dispatch outcomes and independently witnessed business status.
   * @throws If the provider lacks business status reads or the authority is unavailable.
   */
  businessOperations(_sessionId: SessionId, _signal?: AbortSignal, _after?: OperationId, _workId?: WorkId): Promise<BusinessOperations> {
    return Promise.reject(new OperationControlError('authority-unavailable', 'The work authority does not provide business status.'))
  }

  /**
   * Request a read-only business lookup or seal an existing observation.
   * @param _sessionId - Trusted Session selected by the Host.
   * @param id - Original business operation identity.
   * @param _signal - Cancels the Host wait. An accepted lookup can still complete.
   * @param _workId - Require the original operation to belong to this assignment when supplied.
   * @returns The dispatch outcome and independently witnessed business status.
   * @throws If the provider lacks reconciliation, or the lookup is unavailable or unauthorized.
   */
  reconcile(_sessionId: SessionId, id: OperationId, _signal?: AbortSignal, _workId?: WorkId): Promise<BusinessOperationStatus> {
    return Promise.reject(new OperationControlError('broker-reconciliation-unavailable', 'The work authority does not provide business status lookups.', id))
  }
}

/** Host connection to the operation authority. */
export interface Config {
  /** Unix socket granted to the Host's operating-system account. */
  readonly socketPath: string
  /** Separate Unix socket for authenticated owner grant settings. Omit to disable edits through the Host. */
  readonly approvalSocketPath?: string | undefined
  /** Maximum time to await each authority response. */
  readonly timeoutMs?: number
}

/** Release Assistant handoffs through the separately launched operation authority. */
export default class UnixHandoffControl extends HandoffControl {
  static Config: z<Config> = z.object({
    socketPath: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
    approvalSocketPath: z.union([z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(), z.const(undefined)]),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  })

  private readonly client: OperationControlClient
  private readonly ownerClient: OperationControlClient | undefined
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = UnixHandoffControl.Config(config)
    const { approvalSocketPath, socketPath, timeoutMs } = resolved
    if (approvalSocketPath === socketPath) throw new Error('Handoff control requires a separate approval socket for grant settings')
    this.client = new OperationControlClient(resolved)
    if (approvalSocketPath !== undefined) {
      this.ownerClient = new OperationControlClient({ socketPath: approvalSocketPath, ...timeoutMs === undefined ? {} : { timeoutMs } })
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Handoff control was unloaded'))
      await Promise.allSettled(this.active)
    }, 'handoff-control.stop')
  }

  override release(request: HandoffRequest, signal?: AbortSignal): Promise<HandoffRelease> {
    return this.track(signal, lifetime => this.requestRelease(request, lifetime))
  }

  override transferFile(proposal: FileProposal, signal?: AbortSignal): Promise<FileTransferReceipt> {
    return this.track(signal, lifetime => this.client.transferFile(proposal, lifetime))
  }

  override readExportedFile(operationId: OperationId, signal?: AbortSignal): Promise<ExportedFile> {
    return this.track(signal, lifetime => this.client.readExportedFile(operationId, lifetime))
  }

  override overview(sessionId: SessionId, signal?: AbortSignal, workId?: WorkId): Promise<OperationOverview> {
    return this.track(signal, lifetime => this.client.overview(sessionId, lifetime, workId))
  }

  override grantSettings(signal?: AbortSignal): Promise<OperationGrantBudget> {
    const client = this.ownerClient
    return client === undefined ? super.grantSettings(signal) : this.track(signal, lifetime => client.grant(lifetime))
  }

  override updateGrant(update: OperationGrantUpdate, signal?: AbortSignal): Promise<OperationGrantBudget> {
    const client = this.ownerClient
    return client === undefined ? super.updateGrant(update, signal) : this.track(signal, lifetime => client.updateGrant(update, lifetime))
  }

  override brokerConnections(signal?: AbortSignal): Promise<BrokerConnections> {
    const client = this.ownerClient
    return client === undefined ? super.brokerConnections(signal) : this.track(signal, lifetime => client.brokerConnections(lifetime))
  }

  override setBrokerConnection(update: BrokerConnectionUpdate, signal?: AbortSignal): Promise<BrokerConnections> {
    const client = this.ownerClient
    return client === undefined ? super.setBrokerConnection(update, signal)
      : this.track(signal, lifetime => client.setBrokerConnection(update, lifetime))
  }

  override businessRecords(after?: OperationId, signal?: AbortSignal): Promise<BusinessRecords> {
    const client = this.ownerClient
    return client === undefined ? super.businessRecords(after, signal)
      : this.track(signal, lifetime => client.businessRecords(after, lifetime))
  }

  override resolveBusiness(resolution: BusinessResolution, signal?: AbortSignal): Promise<BusinessOperationStatus> {
    const client = this.ownerClient
    return client === undefined ? super.resolveBusiness(resolution, signal)
      : this.track(signal, lifetime => client.resolveBusiness(resolution, lifetime))
  }

  override businessOperations(
    sessionId: SessionId, signal?: AbortSignal, after?: OperationId, workId?: WorkId,
  ): Promise<BusinessOperations> {
    return this.track(signal, lifetime => this.client.businessOperations(sessionId, lifetime, after, workId))
  }

  override reconcile(sessionId: SessionId, id: OperationId, signal?: AbortSignal, workId?: WorkId): Promise<BusinessOperationStatus> {
    return this.track(signal, lifetime => this.client.reconcile(sessionId, id, lifetime, workId))
  }

  private track<T>(signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lifetime = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const pending = task(lifetime)
    this.active.add(pending)
    return pending.finally(() => { this.active.delete(pending) })
  }

  private async requestRelease(request: HandoffRequest, signal: AbortSignal): Promise<HandoffRelease> {
    checkWait(signal)
    const { kind, key, sessionId, targetSessionId, content } = request
    const requestKey = createHash('sha256').update(JSON.stringify([kind, sessionId, key])).digest('hex')
    const handoff = { kind, targetSessionId, content, ...(kind === 'delegation' ? { delegation: request.delegation } : {}) }
    let proposed: OperationStatus
    let status: OperationStatus
    try {
      proposed = await this.client.propose({ requestKey, sessionId, handoff }, signal)
      status = proposed
      checkWait(signal, status.id)
      if (status.state === 'issued') status = await this.client.execute(status.id, signal)
      else if (status.state === 'running' || status.state === 'pending-outcome-evidence') {
        status = await this.client.status(status.id, signal)
      }
    } catch (error: unknown) {
      if (error instanceof OperationControlError && error.code === 'authority-unavailable') checkWait(signal, error.operationId)
      throw error
    }
    const { id, outcome, receipt, state } = status
    checkWait(signal, id)
    if (!isDeepStrictEqual(status.admission, proposed.admission)) {
      throw new OperationControlError('handoff-mismatch', 'The authority reply does not match the proposed handoff operation.', proposed.id)
    }
    if (state !== 'settled') {
      const code = outcome?.kind === 'unknown' ? outcome.code : 'handoff-not-released'
      throw new OperationControlError(code, state === 'pending-evidence' ? `${WITNESS_WAITING_MESSAGE} Operation: ${id}.`
        : `Handoff operation ${id} is ${state}. Inspect its authority record before continuing.`, id)
    }
    const work = outcome?.kind === 'released' ? outcome.work : undefined
    const workMatches = request.kind === 'delivery' ? work === undefined
      : work !== undefined && work.sessionId === targetSessionId && work.workId === request.delegation.workId
        && work.previousWorkId === request.delegation.previousWorkId
        && (request.delegation.permissions === undefined || isDeepStrictEqual(work.permissions, request.delegation.permissions))
        && (request.delegation.inputs === undefined || isDeepStrictEqual(work.inputs ?? [], request.delegation.inputs))
    const expected = handoffOutcome(handoff, work)
    if (outcome?.kind !== 'released' || outcome.handoffKind !== kind || outcome.targetSessionId !== targetSessionId
      || !workMatches || outcome.contentDigest !== expected.contentDigest || receipt?.id !== `${id}-outcome`
      || receipt.digest !== handoffReceiptDigest(id, expected)) {
      throw new OperationControlError('handoff-mismatch', 'The authority reply does not match the requested handoff.', id)
    }
    return { operationId: id, receipt, ...(work === undefined ? {} : { work }) }
  }
}

function checkWait(signal: AbortSignal, operationId?: OperationId): void {
  if (signal.aborted) {
    throw new OperationControlError('handoff-canceled', 'The Host stopped waiting for the handoff release.', operationId, { cause: signal.reason })
  }
}
