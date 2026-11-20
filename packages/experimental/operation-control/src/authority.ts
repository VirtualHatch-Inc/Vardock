/** Authorize, consume, and witness a single bounded grant over a Unix socket. */
import { createHash } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { chmod, type FileHandle } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ExecutionBroker, ExecutionObservation, WorkspaceTransferRequest, WorkspaceTransferResult } from '@deepseek-ai/dsh-execution-container'
import { EvidenceError, type EvidenceEvent, type EvidenceReceipt } from '@deepseek-ai/dsh-operation-evidence'
import { digestEvidenceEvent, prepareOperationSocket, type EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { BrokerError, type OperationBroker } from '@deepseek-ai/dsh-operation-broker'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { ModelObservation, ModelRequest } from './model-protocol.ts'
import {
  approvalDecisionSchema, brokerConnectionUpdateSchema, businessResponseEvidence, businessResolutionSchema,
  fileContentMatches, fileOutcomeMetadata, fileProposalSchema, guestBusinessRequestSchema,
  handoffEvidenceBody, handoffOutcome, identitySchema, MAX_FILE_WIRE_BYTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  OperationControlError, operationGrantUpdateSchema, operationIdSchema, operationReceiptsRequestSchema, proposalSchema,
  WITNESS_WAITING_MESSAGE,
  reconciliationObservationEvent, sessionIdSchema, workIdSchema, workInputPath, workPermissionsEvidence,
  type BrokerConnections, type BrokerConnectionUpdate, type BrokerCredentialChange, type BusinessActions,
  type BusinessOperations, type BusinessOperationStatus, type BusinessProposal, type BusinessRecords, type BusinessResolution,
  type ReconciliationObservation,
  type ExportedFile, type OperationApprovalDecision, type OperationGrantBudget, type OperationGrantUpdate,
  type OperationId, type OperationProposal, type OperationStatus,
  type OperationOverview, type ResponseOmitted, type RetainedOperationOutcome, type UnattendedAction, type WorkId,
} from './protocol.ts'
import { type Operation, OperationStore, type ReconciliationAttempt, reconciliationIntentEvent } from './store.ts'

const idRequest = z.strictObject({ id: operationIdSchema })
const emptyRequest = z.strictObject({})
const sessionScopeRequest = z.strictObject({ sessionId: sessionIdSchema, workId: workIdSchema.optional() })
const businessListRequest = sessionScopeRequest.extend({ after: operationIdSchema.optional() })
const reconciliationRequest = sessionScopeRequest.extend(idRequest.shape)
const businessRecordsRequest = z.strictObject({ after: operationIdSchema.optional() })
const utf8 = new TextDecoder('utf-8', { fatal: true })

interface Run {
  readonly abort: AbortController
  readonly done: Promise<OperationStatus>
  child?: BusinessRun
}

interface BusinessRun {
  readonly id: OperationId
  readonly signal: AbortSignal
  readonly decide: (status: OperationStatus) => void
  readonly done: Promise<unknown>
}

interface Listener {
  readonly path: string
  readonly server: ReturnType<typeof createServer>
  lease?: FileHandle
}

/**
 * Decide whether a prepared business request is admitted without a human decision.
 * A rule with `match` or `allow` applies only to a JSON object body in compact `JSON.stringify` form, so a
 * duplicate key cannot make the business service read a different value than the rule checked.
 * A rule with neither covers every body of its action.
 * @param rules - Unattended actions currently in effect.
 * @param business - Action and exact outgoing JSON text.
 * @returns Whether a rule covers the request.
 */
export function isUnattended(rules: readonly UnattendedAction[], business: Pick<BusinessProposal['business'], 'action' | 'body'>): boolean {
  return rules.some(({ action, match, allow }) => {
    if (action !== business.action) return false
    if (allow === undefined) return true
    const body: unknown = JSON.parse(business.body)
    if (typeof body !== 'object' || body === null || Array.isArray(body) || JSON.stringify(body) !== business.body) return false
    const required = match ?? {}
    const fields = body as Record<string, unknown>
    return Object.entries(required).every(([field, value]) => Object.hasOwn(fields, field) && fields[field] === value) &&
      Object.keys(fields).every(field => Object.hasOwn(required, field) || allow.includes(field))
  })
}

/** Dependencies owned by the separately launched control profile. */
export interface AuthorityOptions {
  /** Resolved authority socket path. Its parent controls access. */
  readonly socketPath: string
  /**
   * Separate Unix socket for human decisions and owner limit edits.
   * Enables approval for every shell proposal unless `unattendedShell` is set.
   */
  readonly approvalSocketPath?: string
  /** Admit shell proposals without a human decision. Business requests still wait for one unless a rule below matches. */
  readonly unattendedShell?: boolean
  /**
   * The profile's business requests admitted without a human decision, in effect until the owner's first witnessed rule
   * edit. A request matching no rule waits for one.
   */
  readonly unattendedActions?: readonly UnattendedAction[]
  /** Maximum command bytes accepted under this grant. */
  readonly maxCommandBytes: number
  /** Total request-body read time before admission. */
  readonly requestTimeoutMs: number
  /** Reports failures that need operator inspection. */
  readonly warn: (error: unknown) => void
  /**
   * Execute the stored command and collect a structured runner observation.
   * @param sessionId - isolated workspace identity.
   * @param command - exact stored shell script.
   * @param signal - operation lifetime, independent of the HTTP connection.
   * @param broker - optional business proposal handler for this execution.
   * @returns the observed exit and confirmed container stop.
   */
  readonly run: (sessionId: SessionId, command: string, signal: AbortSignal, broker?: ExecutionBroker) => Promise<ExecutionObservation>
  /** List actions with their route digests, and resolve, dispatch, and look up external requests using authority-owned credentials. */
  readonly broker?: Pick<OperationBroker, 'actions' | 'resolve' | 'reviewPresentation' | 'run' | 'reconcile'>
  /** Broker actions the Assistant grant permits, as reported to the trusted Host. Omit when none are permitted. */
  readonly businessActions?: BusinessActions['actions']
  /** Owner access to the credentials of permitted broker actions. Omit to refuse connection settings. */
  readonly connections?: {
    /**
     * List permitted broker actions with their credential state.
     * @returns Each action in ascending action ID order, without credential values.
     */
    readonly list: () => Promise<Omit<BrokerConnections['connections'][number], 'unattended' | 'routeChangedSinceRulesSaved'>[]>
    /**
     * Describe the model route's API key. Omit when the authority profile names no key for it.
     * @returns The route and its credential state, without the value.
     */
    readonly model?: () => Promise<NonNullable<BrokerConnections['model']>>
    /**
     * Check a change to the bearer token one permitted action or the model route sends.
     * @param update - Permitted action or the model route, and its replacement token or `null` to remove the stored one.
     * @returns The write to run once the change is witnessed.
     * @throws An {@link OperationControlError} when the target is not permitted or the token is invalid.
     */
    readonly credentialChange: (update: BrokerCredentialChange) => () => Promise<void>
  }
  /** The one permitted provider route and model. Omit to refuse model operations. */
  readonly model?: {
    readonly provider: string
    readonly id: string
    readonly run: (sessionId: SessionId, request: ModelRequest, signal: AbortSignal) => Promise<ModelObservation>
  }
  /** Bounded file transfers against the same isolated workspace as shell execution. */
  readonly transfer?: {
    readonly maxBytes: number
    readonly run: (sessionId: SessionId, request: WorkspaceTransferRequest, signal: AbortSignal) => Promise<WorkspaceTransferResult>
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) throw new OperationControlError('request-too-large', 'The operation request exceeds the byte limit.')
    chunks.push(chunk)
  }
  try {
    const body: unknown = JSON.parse(utf8.decode(Buffer.concat(chunks)))
    return body
  } catch (error: unknown) {
    throw new OperationControlError('bad-request', 'The operation request is not valid JSON.', undefined, { cause: error })
  }
}

/** Owns admitted HTTP requests and running operations until they settle. */
export class OperationAuthority {
  private readonly listeners: readonly Listener[]
  private readonly requests = new Set<Promise<void>>()
  private readonly running = new Map<OperationId, Run>()
  private readonly reviewWaiters = new Map<OperationId, () => void>()
  /** Response text held only until the waiting shell execution receives its reply. */
  private readonly responses = new Map<OperationId, { readonly body: string } | { readonly bodyOmitted: ResponseOmitted }>()
  private readonly lookups = new Map<OperationId, Promise<BusinessOperationStatus>>()
  private readonly stopLookups = new AbortController()
  /** Whether an owner edit of the limits or unattended rules awaits its witness. */
  private updatingGrant = false
  /** Settles after the last accepted credential change, so changes are witnessed and written in arrival order. */
  private credentialChanges: Promise<void> = Promise.resolve()
  /** The in-flight attempt to witness this start's configuration record, shared by concurrent requests. */
  private recordingConfiguration: Promise<boolean> | undefined
  private starting: Promise<void> | undefined
  private closing: Promise<void> | undefined

  constructor(
    private readonly store: OperationStore,
    private readonly evidence: Pick<EvidenceClient, 'append'>,
    private readonly options: AuthorityOptions,
  ) {
    const { socketPath, approvalSocketPath } = options
    this.listeners = approvalSocketPath === undefined
      ? [this.listener(socketPath, false)]
      : [this.listener(approvalSocketPath, true), this.listener(socketPath, false)]
  }

  private listener(path: string, decisions: boolean): Listener {
    const { requestTimeoutMs } = this.options
    const server = createServer({ headersTimeout: requestTimeoutMs, requestTimeout: requestTimeoutMs }, (req, res) => {
      const operation = this.handle(req, res, decisions)
      this.requests.add(operation)
      void operation.finally(() => { this.requests.delete(operation) }).catch(this.options.warn)
    })
    return { path, server }
  }

  /**
   * Witness this start's configuration record, then start listening in an operator-controlled directory.
   * While the witness has not confirmed the record, every request is refused and retries it.
   * @returns resolution after socket setup.
   * @throws When the witness refuses the configuration record, which a retry cannot change.
   */
  listen(): Promise<void> {
    return this.starting ??= this.start()
  }

  private async start(): Promise<void> {
    await this.recordConfiguration()
    for (const listener of this.listeners) {
      listener.lease = await prepareOperationSocket(listener.path, this.options.requestTimeoutMs)
    }
    for (const listener of this.listeners) {
      const { path, server } = listener
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(path, 0o660)
    }
  }

  /**
   * Stop admission, cancel running operations, and wait for final observations.
   * @returns settlement after the socket and database are closed.
   */
  close(): Promise<void> {
    return this.closing ??= this.drain()
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([this.starting])
    const listenersClosed = Promise.allSettled(this.listeners.map(({ server }) => {
      if (!server.listening) return Promise.resolve()
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
      server.closeAllConnections()
      return closed
    }))
    for (const { abort } of this.running.values()) abort.abort(new Error('The operation authority is stopping'))
    this.stopLookups.abort(new Error('The operation authority is stopping'))
    await Promise.allSettled(this.requests)
    try {
      const failure = (await listenersClosed).find(result => result.status === 'rejected')
      if (failure !== undefined) throw new Error('An operation socket could not close', { cause: failure.reason })
    } finally {
      try {
        this.store.close()
      } finally {
        await Promise.all(this.listeners.map(async ({ lease }) => { await lease?.close() }))
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, decisions: boolean): Promise<void> {
    let id: OperationId | undefined
    const timeout = setTimeout(() => req.destroy(), this.options.requestTimeoutMs)
    try {
      if (req.method !== 'POST') throw new OperationControlError('bad-request', 'Use POST for operation requests.')
      const fileProposal = !decisions && req.url === '/propose-file'
      const maxBytes = fileProposal && this.options.transfer !== undefined ? MAX_FILE_WIRE_BYTES : MAX_REQUEST_BYTES
      const body = await readBody(req, maxBytes)
      // The client closes this connection after it receives the reply to its potentially large upload.
      if (fileProposal) res.setHeader('connection', 'keep-alive')
      clearTimeout(timeout)
      if (this.closing !== undefined) throw new OperationControlError('authority-stopping', 'The operation authority is stopping.')
      if (!await this.recordConfiguration()) {
        throw new OperationControlError('configuration-evidence-unavailable',
          WITNESS_WAITING_MESSAGE)
      }
      if (decisions) {
        switch (req.url) {
          case '/decide': {
            const decision = approvalDecisionSchema.parse(body)
            id = decision.id
            this.respond(res, 200, await this.decide(decision))
            return
          }
          case '/grant-settings':
            emptyRequest.parse(body)
            this.respond(res, 200, this.store.grantSettings())
            return
          case '/update-grant':
            this.respond(res, 200, await this.updateGrant(operationGrantUpdateSchema.parse(body)))
            return
          case '/operation-receipts':
            this.respond(res, 200, { receipts: this.store.receipts(operationReceiptsRequestSchema.parse(body).ids) })
            return
          case '/business-records':
            this.respond(res, 200, this.businessRecords(businessRecordsRequest.parse(body).after))
            return
          case '/resolve-business': {
            const resolution = businessResolutionSchema.parse(body)
            id = resolution.id
            this.respond(res, 200, await this.resolveBusiness(resolution))
            return
          }
          case '/broker-connections':
            emptyRequest.parse(body)
            this.respond(res, 200, await this.brokerConnections())
            return
          case '/set-broker-connection': {
            const update = brokerConnectionUpdateSchema.parse(body)
            if ('unattended' in update) await this.setUnattended(update)
            else await this.setCredential(update)
            this.respond(res, 200, await this.brokerConnections())
            return
          }
          default:
            throw new OperationControlError('bad-request', 'Use the approval socket for decisions and grant limits.')
        }
      }
      if (req.url === '/decide' || req.url === '/grant-settings' || req.url === '/update-grant'
        || req.url === '/broker-connections' || req.url === '/set-broker-connection' || req.url === '/operation-receipts'
        || req.url === '/business-records' || req.url === '/resolve-business') {
        throw new OperationControlError('approval-forbidden', 'Use the approval socket for decisions and grant limits.')
      }
      if (req.url === '/propose') {
        const proposal = proposalSchema.parse(body)
        if ('file' in proposal) throw new OperationControlError('bad-request', 'Use the workspace transfer endpoint for file proposals.')
        this.respond(res, 200, await this.propose(proposal))
        return
      }
      if (req.url === '/propose-file') {
        this.respond(res, 200, await this.propose(fileProposalSchema.parse(body)))
        return
      }
      if (req.url === '/overview') {
        const { sessionId, workId } = sessionScopeRequest.parse(body)
        this.respond(res, 200, this.overview(sessionId, workId))
        return
      }
      if (req.url === '/business-operations') {
        const { sessionId, after, workId } = businessListRequest.parse(body)
        this.respond(res, 200, this.businessOperations(sessionId, after, workId))
        return
      }
      if (req.url === '/business-actions') {
        emptyRequest.parse(body)
        this.respond(res, 200, { actions: this.options.businessActions ?? [] } satisfies BusinessActions)
        return
      }
      if (req.url === '/reconcile') {
        const { id: operationId, sessionId, workId } = reconciliationRequest.parse(body)
        id = operationId
        this.respond(res, 200, await this.reconcile(sessionId, id, workId))
        return
      }
      id = idRequest.parse(body).id
      switch (req.url) {
        case '/read-export':
          this.respond(res, 200, await this.readExport(id), MAX_FILE_WIRE_BYTES)
          return
        case '/wait-review': {
          const disconnected = new AbortController()
          res.once('close', () => { disconnected.abort() })
          this.respond(res, 200, await this.waitReview(id, disconnected.signal))
          return
        }
        case '/execute':
          this.respond(res, 200, await this.execute(id))
          return
        case '/status':
          this.respond(res, 200, await this.preserve(this.store.get(id)))
          return
        case '/cancel':
          this.respond(res, 200, await this.cancel(id))
          return
        default:
          throw new OperationControlError('bad-request', 'The operation authority endpoint is unknown.', id)
      }
    } catch (error: unknown) {
      const failure = error instanceof z.ZodError
        ? new OperationControlError('bad-request', 'The operation request has invalid fields.', id)
        : error instanceof OperationControlError ? error
          : new OperationControlError('authority-error', 'The authority could not settle this request. Query the operation before continuing.', id, { cause: error })
      if (failure.cause !== undefined) this.options.warn(failure)
      this.respond(res, 400, {
        code: failure.code,
        message: failure.message,
        operationId: failure.operationId ?? id,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private permitsModel({ provider, model }: ModelRequest): boolean {
    return provider === this.options.model?.provider && model === this.options.model.id
  }

  private respond(res: ServerResponse, code: number, value: unknown, maxBytes = MAX_RESPONSE_BYTES): void {
    if (res.destroyed) return
    const payload = Buffer.from(JSON.stringify(value))
    if (payload.length > maxBytes) throw new Error('Operation response exceeds the wire byte limit')
    if (!res.hasHeader('connection')) res.setHeader('connection', 'close')
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': payload.length })
    res.end(payload)
  }

  /** The current route digest of each broker action the grant permits. */
  private get permittedRoutes(): ReadonlyMap<string, string> {
    const permitted = new Set(this.options.businessActions?.map(entry => entry.action))
    return new Map((this.options.broker?.actions() ?? [])
      .filter(({ action }) => permitted.has(action)).map(({ action, routeDigest }) => [action, routeDigest]))
  }

  /**
   * The profile's rules until the owner's first edit; then the owner's rules of each permitted action whose current route
   * digest is the one they were saved under.
   */
  private get unattendedActions(): readonly UnattendedAction[] {
    const saved = this.store.unattendedRules
    if (saved === undefined) return this.options.unattendedActions ?? []
    const routes = this.permittedRoutes
    return saved.actions.filter(({ action, routeDigest }) => routes.get(action) === routeDigest)
      .flatMap(({ action, rules }) => rules.map(rule => ({ action, ...rule })))
  }

  private async setUnattended({ action, unattended, revision }: Extract<BrokerConnectionUpdate, { unattended: unknown }>): Promise<void> {
    const routes = this.permittedRoutes
    const routeDigest = routes.get(action)
    if (routeDigest === undefined) {
      throw new OperationControlError('broker-action-unavailable', 'An unattended rule names a broker action the grant does not permit.')
    }
    // The first edit copies each permitted action's profile rules under its current route; later edits keep every saved
    // entry, including one whose route changed. Entries of actions the grant no longer permits are dropped.
    const current = this.store.unattendedRules?.actions ?? [...routes].map(([permitted, digest]) => ({
      action: permitted, routeDigest: digest,
      rules: (this.options.unattendedActions ?? []).filter(rule => rule.action === permitted).map(({ action: _action, ...rule }) => rule),
    })).filter(entry => entry.rules.length > 0)
    const update = {
      revision,
      actions: [...current.filter(entry => entry.action !== action && routes.has(entry.action)), { action, routeDigest, rules: unattended }]
        .sort((left, right) => left.action.localeCompare(right.action, 'en')),
    }
    const event = this.store.prepareUnattendedRules(update)
    await this.witnessOwnerEdit(event, (receipt) => {
      this.store.commitUnattendedRules(update, receipt)
    })
  }

  private async updateGrant(update: OperationGrantUpdate): Promise<OperationGrantBudget> {
    const event = this.store.prepareGrantUpdate(update)
    if (event === undefined) return this.store.grantSettings()
    return this.witnessOwnerEdit(event, receipt => this.store.commitGrantUpdate(update, receipt))
  }

  /** Apply one owner edit of the limits or unattended rules after the witness confirms it; refuse a concurrent edit. */
  private async witnessOwnerEdit<T>(event: EvidenceEvent, commit: (receipt: EvidenceReceipt) => T): Promise<T> {
    if (this.updatingGrant) {
      throw new OperationControlError('grant-update-in-progress', 'Another grant update is in progress. Refresh the grant before saving again.')
    }
    this.updatingGrant = true
    try {
      const receipt = await this.witness(event, true)
      if (receipt === undefined) {
        throw new OperationControlError('grant-update-evidence-unavailable', 'The witness did not confirm the grant update. Refresh the grant and retry.')
      }
      return commit(receipt)
    } finally {
      this.updatingGrant = false
    }
  }

  /**
   * Witness the configuration record of this start, if the store lacks it, and adopt its revision.
   * @returns Whether the store holds the record's receipt.
   * @throws When the witness refuses the record, such as one larger than its request limit.
   */
  private recordConfiguration(): Promise<boolean> {
    const event = this.store.configurationEvent
    if (event === undefined) return Promise.resolve(true)
    return this.recordingConfiguration ??= this.witnessConfiguration(event).finally(() => { this.recordingConfiguration = undefined })
  }

  private async witnessConfiguration(event: EvidenceEvent): Promise<boolean> {
    let receipt: EvidenceReceipt
    try {
      receipt = await this.evidence.append(event)
    } catch (error: unknown) {
      if (error instanceof EvidenceError && error.code === 'invalid') {
        throw new OperationControlError('configuration-evidence-refused',
          'The witness refused the configuration record. If the record exceeds its request byte limit, permit fewer broker actions or shorten the unattended rules, then restart.',
          undefined, { cause: error })
      }
      this.options.warn(new Error('Evidence acknowledgment unavailable for the authority configuration', { cause: error }))
      return false
    }
    if (receipt.id !== event.id || receipt.digest !== digestEvidenceEvent(event)) {
      this.options.warn(new Error('Evidence receiver returned a receipt for a different configuration record'))
      return false
    }
    this.store.commitConfiguration(receipt)
    return true
  }

  private setCredential(update: BrokerCredentialChange): Promise<void> {
    const write = this.connections.credentialChange(update)
    const change = this.credentialChanges.then(async () => {
      const receipt = await this.witness(this.store.credentialChangeEvent('action' in update ? update.action : undefined, update.value !== null))
      if (receipt === undefined) {
        throw new OperationControlError('credential-evidence-unavailable', 'The witness did not confirm the credential change. Retry.')
      }
      await write()
    })
    // A failed change is reported to its own caller; the next change still waits for it to settle.
    this.credentialChanges = change.then(() => undefined, () => undefined)
    return change
  }

  private async propose(proposal: OperationProposal): Promise<OperationStatus> {
    if ('business' in proposal) throw new OperationControlError('broker-proposal-forbidden', 'Submit business requests from the active execution gateway.')
    const operation = this.store.reserve(proposal, () => {
      if ('command' in proposal) {
        if (Buffer.byteLength(proposal.command) > this.options.maxCommandBytes) {
          throw new OperationControlError('command-too-large', 'The shell script exceeds the grant byte limit.')
        }
      } else if ('modelRequest' in proposal && !this.permitsModel(proposal.modelRequest)) {
        throw new OperationControlError('model-denied', 'The operation grant does not allow this model route.')
      } else if ('file' in proposal && this.options.transfer === undefined) {
        throw new OperationControlError('file-unavailable', 'This execution backend does not provide workspace file transfers.')
      }
    }, 'command' in proposal && this.reviewsShell)
    return this.preserve(operation)
  }

  private async readExport(id: OperationId): Promise<ExportedFile> {
    const current = this.store.get(id)
    if (!('file' in current.proposal) || current.proposal.file.kind !== 'export') {
      throw new OperationControlError('not-found', 'The operation has no exported file.', id)
    }
    this.store.assertOutcomeDisclosure(current)
    await this.preserve(current)
    const operation = this.store.get(id)
    const { outcome, receipt } = operation
    if (operation.state !== 'settled' || outcome?.kind !== 'file-exported' || !('contentBase64' in outcome) || receipt === undefined) {
      throw new OperationControlError('file-not-settled', 'The file export has no confirmed snapshot. Inspect its operation record.', id)
    }
    this.store.assertOutcomeDisclosure(operation)
    const { contentBase64, ...metadata } = outcome
    return { operationId: id, outcome: metadata, receipt, contentBase64 }
  }

  private async decide({ id, revision, payloadDigest, decision }: OperationApprovalDecision): Promise<OperationStatus> {
    const current = this.store.get(id)
    if (!('command' in current.proposal || 'business' in current.proposal) || current.revision !== revision || current.payloadDigest !== payloadDigest) {
      throw new OperationControlError('approval-mismatch', 'The approval does not match the reviewed operation.', id)
    }
    if (decision === 'approve') this.store.assertCurrent(current)
    if (current.state !== 'pending-approval') {
      if (current.approval === (decision === 'approve' ? 'approved' : 'denied')) return this.preserve(current)
      throw new OperationControlError('approval-not-pending', 'The operation no longer accepts this decision.', id)
    }
    const child = 'business' in current.proposal ? this.activeChild(current.id, current.proposal.business.parentId) : undefined
    const next: Operation = decision === 'approve'
      ? { ...current, state: 'pending-evidence', approval: 'approved' }
      : { ...current, state: 'canceled', approval: 'denied' }
    const result = await this.preserve(this.store.put(next, 'pending-approval'))
    child?.decide(result)
    return result
  }

  private get connections(): NonNullable<AuthorityOptions['connections']> {
    if (this.options.connections === undefined) {
      throw new OperationControlError('broker-unavailable', 'The authority has no broker connection settings.')
    }
    return this.options.connections
  }

  private async brokerConnections(): Promise<BrokerConnections> {
    const rules = this.unattendedActions
    const saved = this.store.unattendedRules?.actions
    const routes = this.permittedRoutes
    const model = await this.connections.model?.()
    return {
      ...model === undefined ? {} : { model },
      unattendedShell: this.options.unattendedShell === true,
      revision: this.store.grantSettings().revision,
      connections: (await this.connections.list()).map(connection => ({
        ...connection,
        unattended: rules.filter(rule => rule.action === connection.action).map(({ action: _action, ...rule }) => rule),
        routeChangedSinceRulesSaved: saved?.some(({ action, routeDigest }) =>
          action === connection.action && routes.get(action) !== routeDigest) === true,
      })),
    }
  }

  private unattended(business: Pick<BusinessProposal['business'], 'action' | 'body'>): boolean {
    return isUnattended(this.unattendedActions, business)
  }

  private get reviewsShell(): boolean {
    return this.options.approvalSocketPath !== undefined && this.options.unattendedShell !== true
  }

  private assertApproved(operation: Operation): void {
    const { proposal } = operation
    if ((('business' in proposal && !this.unattended(proposal.business)) || (this.reviewsShell && 'command' in proposal)) &&
      operation.approval !== 'approved') {
      throw new OperationControlError('approval-required', 'This execution has no human approval.', operation.id)
    }
  }

  private async admit(operation: Operation): Promise<OperationStatus> {
    this.assertApproved(operation)
    this.store.assertCurrent(operation)
    if ('business' in operation.proposal) this.activeChild(operation.id, operation.proposal.business.parentId)
    const work = 'handoff' in operation.proposal ? this.store.resolveDelegation(operation.proposal, operation.id) : undefined
    const body = {
      principalId: operation.principalId,
      scopeId: operation.scopeId,
      sessionId: operation.proposal.sessionId,
      requestKey: operation.proposal.requestKey,
      ...(operation.workId === undefined ? {} : { workId: operation.workId }),
      ...admissionEvidence(operation),
      ...(work === undefined ? {} : {
        workId: work.workId, previousWorkId: work.previousWorkId, requestDigest: operation.payloadDigest,
        permissions: workPermissionsEvidence(work.permissions),
        ...(work.inputs === undefined ? {} : { inputs: [...work.inputs] }),
      }),
      fingerprint: operation.fingerprint,
      revision: operation.revision,
      ...(operation.limitsRevision === undefined ? {} : { limitsRevision: operation.limitsRevision }),
      ...(operation.rulesRevision === undefined ? {} : { rulesRevision: operation.rulesRevision }),
      expiresAt: operation.expiresAt,
      ...operation.approval === 'approved' ? { approval: 'human-approved' } : {},
    }
    const admission = await this.witness(operationEvent(operation.id, 'admission', body),
      operation.approval === 'approved' || operation.workId !== undefined || work !== undefined)
    return this.statusOf(admission === undefined ? this.store.get(operation.id)
      : this.store.put({ ...operation, state: 'issued', admission }, 'pending-evidence'))
  }

  private activeChild(id: OperationId, parentId: OperationId): BusinessRun {
    const child = this.running.get(parentId)?.child
    if (child?.id !== id || child.signal.aborted) {
      throw new OperationControlError('broker-parent-inactive', 'The shell execution is no longer waiting for this business request.', id)
    }
    this.store.assertCurrent(this.store.get(parentId))
    return child
  }

  private pendingReview(parentId: OperationId): OperationStatus | undefined {
    const child = this.running.get(parentId)?.child
    if (child === undefined || child.signal.aborted) return undefined
    const operation = this.store.get(child.id)
    if (operation.state === 'pending-approval') return this.statusOf(operation)
  }

  private async waitReview(parentId: OperationId, signal: AbortSignal): Promise<{ review?: OperationStatus }> {
    if (this.options.broker === undefined) {
      throw new OperationControlError('broker-unavailable', 'The authority has no business broker.', parentId)
    }
    const parent = this.store.get(parentId)
    if (!('command' in parent.proposal) || (parent.state !== 'issued' && parent.state !== 'running')) {
      throw new OperationControlError('broker-parent-inactive', 'The shell execution can no longer receive business reviews.', parentId)
    }
    const ready = this.pendingReview(parentId)
    if (ready !== undefined) return { review: ready }
    if (this.reviewWaiters.has(parentId)) {
      throw new OperationControlError('review-already-waiting', 'A review wait is already active for this shell execution.', parentId)
    }
    const waiting = Promise.withResolvers<void>()
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)])
    using _abort = addAbortListener(lifetime, () => { waiting.resolve() })
    this.reviewWaiters.set(parentId, waiting.resolve)
    try {
      await waiting.promise
      const review = this.pendingReview(parentId)
      return review === undefined ? {} : { review }
    } finally {
      this.reviewWaiters.delete(parentId)
    }
  }

  private async guestBusiness(parent: Operation, request: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      return await this.submitBusiness(parent, request, signal)
    } catch (error: unknown) {
      if (error instanceof OperationControlError) {
        return { code: error.code, message: error.message, operationId: error.operationId }
      }
      if (error instanceof BrokerError) return { code: error.code, message: error.message }
      if (error instanceof z.ZodError) return { code: 'bad-request', message: 'The business request has invalid fields.' }
      this.options.warn(new Error(`Business request failed for shell execution ${parent.id}`))
      return { code: 'broker-unavailable', message: 'The authority could not handle the business request.' }
    }
  }

  private async submitBusiness(parent: Operation, request: unknown, signal: AbortSignal): Promise<unknown> {
    const run = this.running.get(parent.id)
    const { broker } = this.options
    if (broker === undefined || run === undefined || signal.aborted || run.abort.signal.aborted) {
      throw new OperationControlError('broker-parent-inactive', 'The shell execution cannot submit a business request.')
    }
    if (run.child !== undefined) throw new OperationControlError('broker-busy', 'This shell execution already has an active business request.')
    const input = guestBusinessRequestSchema.parse(request)
    this.store.assertBrokerAction(parent, input.action)
    const { action, method, endpoint, credentialRef, body, reconciliationEndpoint, tool } = broker.resolve(
      input.action, input.body, { parentId: parent.id, requestKey: input.requestKey },
    )
    const lifetime = AbortSignal.any([signal, run.abort.signal])
    const unattended = this.unattended({ action, body })
    const operation = this.store.reserve({
      requestKey: input.requestKey, sessionId: parent.proposal.sessionId,
      business: {
        parentId: parent.id, action, method, endpoint, credentialRef, body,
        ...(reconciliationEndpoint === undefined ? {} : { reconciliationEndpoint }),
        ...(tool === undefined ? {} : { tool }),
      },
    }, () => { this.store.assertCurrent(parent) }, !unattended)
    const admitted = unattended && operation.state === 'pending-evidence' && operation.approval === 'unattended'
    if (operation.state !== 'pending-approval' && !admitted) return this.businessReply(await this.preserve(operation))
    const decision = Promise.withResolvers<OperationStatus | undefined>()
    using _abort = addAbortListener(lifetime, () => { decision.resolve(undefined) })
    const done = this.finishBusiness(operation.id, decision.promise, lifetime)
    run.child = { id: operation.id, signal: lifetime, decide: decision.resolve, done }
    if (admitted) decision.resolve(await this.preserve(operation))
    else this.reviewWaiters.get(parent.id)?.()
    try {
      return await done
    } finally {
      delete run.child
    }
  }

  private async finishBusiness(id: OperationId, decision: Promise<OperationStatus | undefined>, signal: AbortSignal): Promise<unknown> {
    try {
      const status = await decision
      if (signal.aborted || status === undefined) {
        throw new OperationControlError('broker-canceled', 'The business request was canceled.', id)
      }
      return this.businessReply(status.state === 'issued' ? await this.execute(id, signal) : status)
    } finally {
      this.responses.delete(id)
      const current = this.store.get(id)
      if (current.state === 'pending-approval' || current.state === 'pending-evidence' || current.state === 'issued') {
        await this.cancel(id)
      }
    }
  }

  private businessReply({ id, state, outcome, receipt }: OperationStatus): unknown {
    if (state === 'settled' && outcome?.kind === 'business-response' && receipt !== undefined) {
      const { statusCode, toolError } = outcome
      return { id, ...(statusCode === undefined ? { toolError } : { status: statusCode }), receipt, ...this.responses.get(id) }
    }
    if (state === 'settled' && outcome?.kind === 'business-not-sent') {
      throw new OperationControlError(outcome.code, 'The broker stopped before sending the approved request.', id)
    }
    if (state === 'canceled') throw new OperationControlError('broker-canceled', 'The business request was canceled or declined.', id)
    throw new OperationControlError('broker-outcome-unavailable', 'The business request has no witnessed response. Inspect its authority record.', id)
  }

  private execute(id: OperationId, businessSignal?: AbortSignal): Promise<OperationStatus> {
    const current = this.store.get(id)
    if ('business' in current.proposal) {
      if (businessSignal === undefined) {
        throw new OperationControlError('broker-execute-forbidden', 'Only the waiting shell execution can consume this business operation.', id)
      }
      this.activeChild(id, current.proposal.business.parentId)
      businessSignal.throwIfAborted()
    }
    if (current.state !== 'issued') return this.preserve(current)
    this.assertApproved(current)
    const consumed = this.store.put({ ...current, state: 'running' }, 'issued')
    const abort = new AbortController()
    const signal = businessSignal === undefined ? abort.signal : AbortSignal.any([abort.signal, businessSignal])
    const done = Promise.resolve().then(async () => {
      let outcome: RetainedOperationOutcome
      try {
        outcome = await this.run(consumed, signal)
      } catch (error: unknown) {
        if ('business' in consumed.proposal) {
          const code = error instanceof BrokerError ? error.code : 'broker-response-unavailable'
          const kind = error instanceof BrokerError && error.dispatch === 'not-sent' ? 'business-not-sent' : 'unknown'
          outcome = { kind, code }
          this.options.warn(new Error(`Business operation ${id} ended with ${kind} (${code})`))
        } else {
          outcome = { kind: 'unknown', code: error instanceof HarnessError ? error.code : 'runner-unavailable' }
          this.options.warn(error)
        }
      } finally {
        if ('command' in consumed.proposal && this.options.broker !== undefined) {
          abort.abort(new Error('The parent shell execution ended'))
          const child = this.running.get(id)?.child
          if (child !== undefined) await Promise.allSettled([child.done])
        }
      }
      const operation = this.store.put({ ...consumed, state: 'pending-outcome-evidence', outcome }, 'running')
      return this.preserve(operation)
    }).finally(() => {
      this.running.delete(id)
      this.reviewWaiters.get(id)?.()
    })
    this.running.set(id, { abort, done })
    return done
  }

  private async run(operation: Operation, signal: AbortSignal): Promise<RetainedOperationOutcome> {
    const { proposal } = operation
    const { sessionId } = proposal
    if ('command' in proposal) {
      const observation = this.options.broker === undefined
        ? await this.options.run(sessionId, proposal.command, signal)
        : await this.options.run(sessionId, proposal.command, signal,
          (request, lifetime) => this.guestBusiness(operation, request, lifetime))
      return { kind: 'exited', observation }
    }
    if ('business' in proposal) {
      const { broker } = this.options
      if (broker === undefined) throw new Error('The authority has no business broker')
      const correlation = { operationId: operation.id, payloadDigest: operation.payloadDigest }
      const observation = await broker.run(proposal.business, correlation, signal)
      const { body, bodyOmitted } = observation
      const response = {
        kind: 'business-response' as const,
        ...(observation.kind === 'tool-result' ? { toolError: observation.isError } : { statusCode: observation.statusCode }),
      }
      const returned = body !== undefined || bodyOmitted !== undefined
      if (returned && !this.store.returnsResponses(operation)) {
        this.responses.set(operation.id, { bodyOmitted: 'not-permitted' })
        return { ...response, responseOmitted: 'not-permitted' }
      }
      if (bodyOmitted !== undefined) {
        this.responses.set(operation.id, { bodyOmitted })
        return { ...response, responseOmitted: bodyOmitted }
      }
      if (body === undefined) return response
      this.responses.set(operation.id, { body })
      return { ...response, responseDigest: createHash('sha256').update(body).digest('hex') }
    }
    if ('handoff' in proposal) {
      signal.throwIfAborted()
      return handoffOutcome(proposal.handoff, this.store.resolveDelegation(proposal, operation.id))
    }
    if ('file' in proposal) {
      const { transfer } = this.options
      if (transfer === undefined) throw new HarnessError('Workspace file transfer is unavailable.', 'file-unavailable')
      const { file } = proposal
      const maxBytes = transfer.maxBytes
      if (file.kind === 'import') {
        const path = workInputPath(file.source)
        const data = Buffer.from(file.contentBase64, 'base64')
        const observation = await transfer.run(sessionId, { kind: 'import', path, data, maxBytes }, signal)
        if (observation.kind !== 'imported' || observation.bytes !== file.source.bytes || observation.digest !== file.source.attachmentId) {
          throw new HarnessError('The isolated runner did not confirm the requested import.', 'file-mismatch')
        }
        return { kind: 'file-imported', workId: file.workId, path, bytes: observation.bytes, digest: observation.digest, source: file.source }
      }
      const { path, targetSessionId } = file
      const observation = await transfer.run(sessionId, { kind: 'export', path, maxBytes }, signal)
      if (observation.kind !== 'exported' || observation.data.byteLength > maxBytes) {
        throw new HarnessError('The isolated runner did not return a bounded export.', 'file-mismatch')
      }
      const contentBase64 = Buffer.from(observation.data).toString('base64')
      if (!fileContentMatches(contentBase64, observation.bytes, observation.digest)) {
        throw new HarnessError('The isolated runner returned different export bytes.', 'file-mismatch')
      }
      return { kind: 'file-exported', workId: file.workId, path, bytes: observation.bytes, digest: observation.digest, targetSessionId, contentBase64 }
    }
    const model = this.options.model
    if (model === undefined || !this.permitsModel(proposal.modelRequest)) {
      throw new HarnessError('The operation grant does not allow this model route.', 'model-denied')
    }
    return { kind: 'model-response', chunks: await model.run(sessionId, proposal.modelRequest, signal) }
  }

  private async cancel(id: OperationId): Promise<OperationStatus> {
    const run = this.running.get(id)
    if (run !== undefined) {
      run.abort.abort(new Error('Operation canceled by its authorized client'))
      return run.done
    }
    const current = this.store.get(id)
    const operation = current.state === 'issued' || current.state === 'pending-evidence' || current.state === 'pending-approval'
      ? this.store.put({ ...current, state: 'canceled' }, current.state)
      : current
    const result = await this.preserve(operation)
    if ('business' in operation.proposal) {
      const child = this.running.get(operation.proposal.business.parentId)?.child
      if (child?.id === id) child.decide(result)
    }
    return result
  }

  private async preserve(operation: Operation): Promise<OperationStatus> {
    const { outcome, state } = operation
    if (state === 'pending-evidence') return this.admit(operation)
    if (state === 'canceled' && operation.revoked === undefined) {
      const body = operation.approval === 'denied'
        ? { reason: 'approval-rejected', revision: operation.revision, ...admissionEvidence(operation) }
        : { reason: 'business' in operation.proposal ? 'business-canceled' : 'client-canceled' }
      const revoked = await this.witness(operationEvent(operation.id, 'revocation', body))
      return this.statusOf(revoked === undefined ? operation : this.store.put({ ...operation, revoked }, state))
    }
    if ((state !== 'pending-outcome-evidence' && state !== 'unknown') || outcome === undefined || operation.receipt !== undefined) {
      return this.statusOf(operation)
    }
    if (outcome.kind === 'released') this.store.assertCurrent(operation)
    const body = outcomeEvidence(outcome)
    const receipt = await this.witness(operationEvent(operation.id, 'outcome', body),
      outcome.kind === 'released' || 'business' in operation.proposal || 'file' in operation.proposal)
    return this.statusOf(receipt === undefined ? this.store.get(operation.id) : this.store.put({
      ...operation,
      state: outcome.kind === 'unknown' ? 'unknown' : 'settled',
      receipt,
    }, state))
  }

  private statusOf(operation: Operation): OperationStatus {
    const { id, state, admission, receipt, revoked, outcome, proposal, revision, payloadDigest } = operation
    const witnessed = state === 'settled' && receipt?.id === `${id}-outcome`
    if (outcome?.kind === 'released' && witnessed) this.store.assertCurrent(operation)
    const protectedOutcome = outcome?.kind === 'released' || outcome?.kind === 'model-response'
      || outcome?.kind === 'business-response' || outcome?.kind === 'business-not-sent' ||
      outcome?.kind === 'file-imported' || outcome?.kind === 'file-exported'
    const hideOutcome = ('modelRequest' in proposal && state === 'pending-outcome-evidence') || (protectedOutcome && !witnessed)
    const availableReceipt = receipt ?? revoked
    const reviewFields = {
      sessionId: proposal.sessionId, revision, payloadDigest,
      ...(operation.workId === undefined ? {} : { workId: operation.workId, principalId: operation.principalId }),
    }
    const availableOutcome = hideOutcome || outcome === undefined ? undefined
      : outcome.kind === 'file-exported' || outcome.kind === 'file-imported' ? fileOutcomeMetadata(outcome) : outcome
    if (availableOutcome !== undefined && availableOutcome.kind !== 'unknown') this.store.assertOutcomeDisclosure(operation)
    const presentation = state === 'pending-approval' && 'business' in proposal
      ? this.options.broker?.reviewPresentation(proposal.business)
      : undefined
    return {
      id, state,
      ...(state === 'pending-approval' && 'command' in proposal
        ? { review: { ...reviewFields, command: proposal.command } }
        : state === 'pending-approval' && 'business' in proposal
          ? { review: {
            ...reviewFields, business: proposal.business, ...(presentation === undefined ? {} : { presentation }),
            ...(operation.repeats === undefined ? {} : { repeats: operation.repeats }),
          } }
          : {}),
      ...(admission === undefined ? {} : { admission }),
      ...(availableOutcome === undefined ? {} : { outcome: availableOutcome }),
      ...(availableReceipt === undefined ? {} : { receipt: availableReceipt }),
    }
  }

  private overview(sessionId: SessionId, workId?: WorkId): OperationOverview {
    const summary: OperationOverview = {
      ...this.store.budget(), sessionId, ...(workId === undefined ? {} : { workId }),
      pendingApprovals: 0, running: 0, unknown: 0,
      businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 },
      disclosesImportedData: this.store.disclosesImportedData(sessionId, workId),
    }
    this.store.inspectSessionOperations(sessionId, workId, (operation) => {
      const { id, proposal, state, outcome } = operation
      const uncertain = state === 'unknown' || state === 'pending-outcome-evidence'
      const superseded = this.store.isPermitSuperseded(operation)
      if (state === 'pending-approval' && !superseded) summary.pendingApprovals++
      if (state === 'running') summary.running++
      let completion: BusinessOperationStatus['businessCompletion'] | undefined
      if ('business' in proposal && (state === 'running' || uncertain || (state === 'settled' && outcome?.kind === 'business-response'))) {
        completion = businessCompletionOf(this.store.latestReconciliation(operation))
        summary.businessCompletion[completion.kind]++
      }
      if (uncertain && completion?.kind !== 'succeeded' && completion?.kind !== 'failed') summary.unknown++
      const code = superseded ? 'revision-mismatch' : overviewFailure(operation, completion)
      if (code !== undefined) summary.lastFailure = { id, code }
      else if (state === 'settled' || completion?.kind === 'succeeded') delete summary.lastFailure
    })
    return summary
  }

  private businessOperations(sessionId: SessionId, after?: OperationId, workId?: WorkId): BusinessOperations {
    const { operations, next } = this.store.businessOperations(sessionId, after, workId)
    return {
      sessionId,
      ...(workId === undefined ? {} : { workId }),
      operations: operations.map(operation => this.businessStatusOf(operation, this.store.latestReconciliation(operation))),
      ...(next === undefined ? {} : { next }),
    }
  }

  private businessRecords(after?: OperationId): BusinessRecords {
    const { operations, more } = this.store.businessRecords(after)
    const records: BusinessRecords['records'][number][] = []
    let bytes = Buffer.byteLength(JSON.stringify({ records: [], next: operations[0]?.id }))
    for (const operation of operations) {
      const { proposal, workId } = operation
      if (!('business' in proposal)) throw new Error('Business records require business requests')
      const { method, endpoint, tool, body } = proposal.business
      const record = {
        ...this.businessStatusOf(operation, this.store.latestReconciliation(operation)),
        method, endpoint, ...(tool === undefined ? {} : { tool }), body, ...(workId === undefined ? {} : { workId }),
      }
      bytes += Buffer.byteLength(JSON.stringify(record)) + 1
      if (records.length > 0 && bytes > MAX_RESPONSE_BYTES) break
      records.push(record)
    }
    const next = more || records.length < operations.length ? records.at(-1)?.id : undefined
    return next === undefined ? { records } : { records, next }
  }

  private businessStatusOf(
    operation: Operation, attempt: ReconciliationAttempt | undefined, evidenceUnavailable = false,
  ): BusinessOperationStatus {
    const { proposal } = operation
    if (!('business' in proposal)) throw new Error('Business status requires a business request')
    const { id, state, outcome, receipt } = this.statusOf(operation)
    const observation = attempt?.observation
    const lookupReceipt = attempt?.receipt
    const businessCompletion = this.store.isPermitSuperseded(operation)
      ? { kind: 'unconfirmed' as const, code: 'revision-mismatch' }
      : businessCompletionOf(attempt, evidenceUnavailable)
    let canReconcile = businessCompletion.kind !== 'succeeded' && businessCompletion.kind !== 'failed'
    if (canReconcile && (observation === undefined || lookupReceipt !== undefined)) {
      try {
        this.authorizeLookup(operation)
      } catch (error: unknown) {
        if (!(error instanceof OperationControlError)) throw error
        canReconcile = false
      }
    }
    return {
      id, sessionId: proposal.sessionId, action: proposal.business.action, state, businessCompletion, canReconcile,
      ...(operation.approval === undefined ? {} : { approval: operation.approval }),
      ...(outcome?.kind === 'business-response' || outcome?.kind === 'business-not-sent' || outcome?.kind === 'unknown' ? { outcome } : {}),
      ...(receipt === undefined ? {} : { receipt }),
    }
  }

  private authorizeLookup(operation: Operation): NonNullable<AuthorityOptions['broker']> {
    const { id, proposal, outcome, approval, admission } = operation
    const broker = this.options.broker
    if (!('business' in proposal) || proposal.business.reconciliationEndpoint === undefined || broker === undefined ||
      (approval !== 'approved' && approval !== 'unattended') || admission === undefined || (outcome?.kind !== 'unknown' && outcome?.kind !== 'business-response')) {
      throw new OperationControlError('broker-reconciliation-unavailable', 'The business operation has no eligible status lookup.', id)
    }
    this.store.assertLookupAllowed(operation)
    return broker
  }

  private reconcile(sessionId: SessionId, id: OperationId, workId?: WorkId): Promise<BusinessOperationStatus> {
    const operation = this.store.get(id)
    if (!('business' in operation.proposal) || operation.proposal.sessionId !== sessionId ||
      (workId !== undefined && operation.workId !== workId)) {
      throw new OperationControlError('not-found', 'The requested scope has no such business operation.', id)
    }
    const active = this.lookups.get(id)
    if (active !== undefined) return active
    const previous = this.store.latestReconciliation(operation)
    const done = this.lookup(operation, operation.proposal.business, previous).finally(() => { this.lookups.delete(id) })
    this.lookups.set(id, done)
    return done
  }

  private async resolveBusiness({ id, kind }: BusinessResolution): Promise<BusinessOperationStatus> {
    for (let active = this.lookups.get(id); active !== undefined; active = this.lookups.get(id)) await active
    const operation = this.store.get(id)
    const previous = this.store.latestReconciliation(operation)
    const completion = businessCompletionOf(previous)
    if (!('business' in operation.proposal) || (operation.outcome?.kind !== 'unknown' && operation.outcome?.kind !== 'business-response')
      || completion.kind === 'succeeded' || completion.kind === 'failed') {
      throw new OperationControlError('broker-reconciliation-unavailable', 'Only an unresolved business outcome can be determined by the owner.', id)
    }
    const attempt = this.store.reserveReconciliation(id, undefined, { kind, source: 'owner' })
    const done = this.sealLookup(operation, attempt).finally(() => { this.lookups.delete(id) })
    this.lookups.set(id, done)
    return done
  }

  private async lookup(
    operation: Operation, business: BusinessProposal['business'],
    previous: ReconciliationAttempt | undefined,
  ): Promise<BusinessOperationStatus> {
    if (previous?.receipt !== undefined && (previous.observation?.kind === 'succeeded' || previous.observation?.kind === 'failed')) {
      return this.businessStatusOf(operation, previous)
    }
    if (previous?.observation !== undefined && previous.receipt === undefined) return this.sealLookup(operation, previous)
    const broker = this.authorizeLookup(operation)
    const original = await this.preserve(operation)
    if (original.receipt === undefined) return this.businessStatusOf(this.store.get(operation.id), previous, true)
    operation = this.store.get(operation.id)
    const attempt = this.store.reserveReconciliation(operation.id, previous)
    const intent = await this.witness(reconciliationIntentEvent(operation, attempt), true)
    if (intent === undefined) return this.businessStatusOf(operation, attempt)
    const admitted = { ...attempt, intent }
    this.store.putReconciliation(admitted)
    let observation: ReconciliationObservation
    try {
      this.store.assertLookupAllowed(operation)
      this.stopLookups.signal.throwIfAborted()
      const correlation = { operationId: operation.id, payloadDigest: operation.payloadDigest }
      const resolution = await broker.reconcile(business, correlation, this.stopLookups.signal)
      observation = resolution.kind === 'pending'
        ? { kind: resolution.kind }
        : { kind: resolution.kind, receiptId: resolution.receiptId }
    } catch (error: unknown) {
      const code = error instanceof BrokerError ? error.code
        : error instanceof OperationControlError && error.code === 'grant-expired' ? error.code
          : this.stopLookups.signal.aborted ? 'broker-canceled' : 'broker-reconciliation-unconfirmed'
      observation = { kind: 'unconfirmed', code }
      this.options.warn(new Error(`Business status lookup for ${operation.id} remains unconfirmed (${code})`))
    }
    const observed = { ...admitted, observation }
    this.store.putReconciliation(observed)
    return this.sealLookup(operation, observed)
  }

  private async sealLookup(
    operation: Operation, attempt: ReconciliationAttempt,
  ): Promise<BusinessOperationStatus> {
    if (attempt.observation === undefined) throw new Error('Cannot seal a lookup without an observation')
    const receipt = await this.witness(reconciliationObservationEvent(operation.id, attempt.id, attempt.observation), true)
    if (receipt === undefined) return this.businessStatusOf(operation, attempt)
    const settled = { ...attempt, receipt }
    this.store.putReconciliation(settled)
    return this.businessStatusOf(operation, settled)
  }

  private async witness(event: EvidenceEvent, verifyDigest = false): Promise<EvidenceReceipt | undefined> {
    const { id, operationId, kind } = event
    try {
      const receipt = await this.evidence.append(event)
      if (receipt.id !== id) throw new Error('Evidence receiver returned a receipt for a different event')
      if (verifyDigest && receipt.digest !== digestEvidenceEvent(event)) {
        throw new Error('Evidence receiver returned a receipt for different operation evidence')
      }
      return receipt
    } catch (error: unknown) {
      this.options.warn(new Error(`Evidence acknowledgment unavailable for operation ${operationId} (${kind})`, { cause: error }))
      return undefined
    }
  }
}

function businessCompletionOf(
  attempt: ReconciliationAttempt | undefined, evidenceUnavailable = false,
): BusinessOperationStatus['businessCompletion'] {
  const observation = attempt?.observation
  const receipt = attempt?.receipt
  if (observation !== undefined && receipt !== undefined) return { ...observation, receipt }
  if (evidenceUnavailable || (attempt !== undefined && (attempt.intent === undefined || observation !== undefined))) {
    return { kind: 'unconfirmed', code: 'reconciliation-evidence-unavailable' }
  }
  return { kind: 'unconfirmed' }
}

function overviewFailure(operation: Operation, completion: BusinessOperationStatus['businessCompletion'] | undefined): string | undefined {
  const { approval, state, outcome } = operation
  if (completion?.kind === 'succeeded') return undefined
  if (approval === 'denied') return 'approval-rejected'
  if (state === 'canceled') return 'operation-canceled'
  if (completion?.kind === 'failed') return 'business-failed'
  if (state === 'pending-outcome-evidence') return 'outcome-evidence-unavailable'
  if (outcome?.kind === 'unknown' || outcome?.kind === 'business-not-sent') {
    return identitySchema.safeParse(outcome.code).success ? outcome.code : 'operation-outcome-unavailable'
  }
  if (completion?.kind === 'unconfirmed' && completion.code !== undefined) return completion.code
  if (outcome?.kind === 'exited' && outcome.observation.exitCode !== 0) return 'shell-exited-nonzero'
}

function operationEvent(operationId: OperationId, kind: EvidenceEvent['kind'], body: EvidenceEvent['body']): EvidenceEvent {
  return { id: `${operationId}-${kind}`, operationId, kind, body }
}

function admissionEvidence({ proposal, payloadDigest }: Operation): Record<string, EvidenceEvent['body']> {
  if ('command' in proposal) return { commandDigest: payloadDigest }
  if ('business' in proposal) {
    const { parentId, action, endpoint, method, credentialRef, body, reconciliationEndpoint, tool } = proposal.business
    return {
      parentId, action, endpoint, method, credentialRef, bodyDigest: sha256(body), requestDigest: payloadDigest,
      ...(reconciliationEndpoint === undefined ? {} : { reconciliationEndpoint }),
      ...(tool === undefined ? {} : { tool }),
    }
  }
  if ('modelRequest' in proposal) {
    return { provider: proposal.modelRequest.provider, model: proposal.modelRequest.model, requestDigest: payloadDigest }
  }
  if ('file' in proposal) {
    const { file } = proposal
    return file.kind === 'import'
      ? { transfer: file.kind, path: workInputPath(file.source), source: file.source, requestDigest: payloadDigest }
      : { transfer: file.kind, path: file.path, targetSessionId: file.targetSessionId, requestDigest: payloadDigest }
  }
  const { handoffKind, targetSessionId, contentDigest } = handoffOutcome(proposal.handoff)
  return { handoffKind, targetSessionId, contentDigest }
}

function outcomeEvidence(outcome: RetainedOperationOutcome): EvidenceEvent['body'] {
  switch (outcome.kind) {
    case 'exited': return {
      kind: outcome.kind,
      containerId: outcome.observation.containerId,
      exitCode: outcome.observation.exitCode,
      stopped: outcome.observation.stopped,
      stdoutDigest: sha256(outcome.observation.stdout),
      stdoutTruncated: outcome.observation.stdoutTruncated,
      stderrDigest: sha256(outcome.observation.stderr),
      stderrTruncated: outcome.observation.stderrTruncated,
    }
    case 'model-response': {
      const encoded = JSON.stringify(outcome.chunks)
      const usage = outcome.chunks.find(chunk => chunk.type === 'usage')?.usage
      return {
        kind: outcome.kind,
        responseDigest: sha256(encoded),
        responseBytes: Buffer.byteLength(encoded),
        ...usage === undefined ? {} : { usage },
      }
    }
    case 'released': return handoffEvidenceBody(outcome)
    case 'file-imported':
    case 'file-exported': return fileOutcomeMetadata(outcome)
    case 'business-response': return businessResponseEvidence(outcome)
    case 'business-not-sent': return outcome
    case 'unknown': return { kind: outcome.kind, code: outcome.code }
  }
}
