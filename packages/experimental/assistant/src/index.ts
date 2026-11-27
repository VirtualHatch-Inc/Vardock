/** Durable delegation from one ordinary root Session to independently inspectable work Sessions. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {
  DEFAULT_MAX_FILE_BYTES, MAX_FILE_TRANSFER_BYTES, MAX_WORK_INPUTS, OperationControlError, workInputPath,
  type BrokerConnections, type BrokerConnectionUpdate, type BusinessRecords, type BusinessResolution,
  type OperationGrantBudget, type OperationGrantUpdate, type WorkGrant, type WorkInputFile, type WorkPermissions,
} from '@deepseek-ai/dsh-operation-control/handoff'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { boundContextSummary, createUserMessage, errorChain, isAgentLoopRequest, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-working-directory'
import { registerAssistantArtifacts } from './artifacts.ts'
import { readWorkInput, type AvailableInput, type InputCoordinates } from './data.ts'
import { registerAssistantMediation } from './mediation.ts'
import { notesProjection, registerNotes } from './notes.ts'
import { reviewScheduleChange, SCHEDULE_CHANGE_TOOLS } from './schedule-review.ts'
import { assistantDomain, receiptProjection, WorkId, workExecutionProjection, workInputProjection } from './state.ts'
import type { AvailableInputState, Receipts, ReportStatus, Work, WorkArtifact, WorkExecution } from './state.ts'
import { readBudget, readUnresolvedBusiness, readWorkAuthority } from './status.ts'
import type { OperationId, WorkId as AuthorityWorkId, WorkPhase, WorkStatusSnapshot } from './status-types.ts'
import { registerTools } from './tools.ts'

export type { Work, WorkId, ReportStatus, WorkArtifact } from './state.ts'

const roleTools = {
  entrance: [
    'list_work_inputs', 'delegate_work', 'list_work', 'stop_work', 'list_business_actions', 'inspect_business_operations',
    'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit', 'write_notes',
  ],
  worker: ['exec', 'report_work'],
} as const satisfies Record<string, readonly string[]>

const MAX_REPLY_BYTES = 128 * 1024

const WITHHELD_RESULT = 'The result is withheld by the current data permissions.'

const ENTRANCE_GUIDANCE = 'You are the Assistant entrance. Delegate independent work with delegate_work, acknowledge its acceptance, and end your turn. Reports arrive in a new turn automatically. Scripts run automatically by default; a deployment may require script approval. External requests wait for owner approval unless a configured rule admits them. Notes and schedule changes always require owner approval. When work fails, needs input, or has an unknown outcome, explain it and await the owner’s direction; do not automatically delegate another attempt or replace the requested deliverable with unverified text. Inspect uncertain external operations before attempting another submission. A scheduled task delivers its prompt to you in a later turn; delegate the work it asks for then.'

function inputCoordinates(inputs: readonly WorkInputFile[]): InputCoordinates[] {
  return inputs.map(({ messageSeq, contentIndex }) => ({ seq: messageSeq, index: contentIndex }))
}

function schedulesElsewhere(args: unknown): boolean {
  return typeof args === 'object' && args !== null && 'target' in args && args.target !== 'this_session'
}

function permitsFiles(permissions: WorkPermissions | undefined, kind: 'import' | 'export'): boolean {
  return permissions?.data?.[kind] === true
    && permissions.data.discloseToModel && permissions.data.discloseToUser
}

function requestMessage(work: Work): Omit<UserMessage, 'id' | 'role'> {
  const inputs = work.authorization?.grant.inputs ?? []
  const files = inputs.length === 0 ? '' : `\n\nImported work files (absolute exec paths; Host paths are unavailable): ${JSON.stringify(inputs.map(input => `/workspace/${workInputPath(input)}`))}\nPaths outside /workspace named in the request do not exist in this work environment; the listed inputs are the files.`
  const continuation = work.previous === null ? ''
    : `\n\nCurrent work ${work.id} continues ${work.previous}. Earlier operations are history, not attempts made for this request. Their effects still matter: do not repeat an unresolved external operation.`
  return {
    content: [{
      type: 'text',
      text: `${work.prompt}${files}${continuation}\n\nGranted work permissions: ${JSON.stringify(work.authorization?.grant.permissions)}\n\nReturn your outcome with report_work (completed, needs_input, or failed), including evidence or your question. Do not delegate back to the main assistant.`,
    }],
    source: {
      kind: 'assistant-work', workId: work.id, direction: 'request',
      form: 'notice', summary: boundContextSummary(work.prompt),
    },
  }
}

function admitsWorkerMessages(messages: readonly UserMessage[], step: number, work: Work): boolean {
  if (step !== 1) return messages.length === 0
  const [message] = messages
  if (messages.length !== 1 || message === undefined) return false
  const request = requestMessage(work)
  return isDeepStrictEqual(message.source, request.source) && isDeepStrictEqual(message.content, request.content)
}

/** Expected delegation failure; code is stable for native callers and tool diagnostics. */
export class AssistantError extends Error {
  constructor(
    readonly code: 'wrong-session' | 'key-conflict' | 'invalid-request' | 'missing-work' | 'busy' | 'no-active-work' | 'stopping' | 'session-unavailable' | 'missing-writer' | 'execution-unavailable' | 'work-file-denied',
    message: string,
  ) {
    super(message)
    this.name = 'AssistantError'
  }
}

/** Deployment selection for the single assistant entry. */
export interface Config {
  /** Stable ordinary Session used as the assistant entrance. */
  mainSessionId?: string
  /** Maximum simultaneous work Sessions. */
  maxActive?: number
  /** Maximum bytes read per work file, bounded by the authority protocol. */
  maxFileBytes?: number
  /** Delay between status reads while the owner views the entrance. */
  workStatusRefreshMs?: number
  /** Maximum UTF-8 bytes of the notes text one `write_notes` call saves; every entrance request carries the saved notes. */
  maxNotesBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistant: AssistantRuntime }
}

/** Dispatches durable requests once and returns explicit worker reports to the main Session. */
export class AssistantRuntime extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'sessionProjections', 'sessionQuery', 'attachments', 'storageDomain', 'tools', 'permissionPresets', 'sessionTitle', 'remoteAccess', 'workspaceRegistry', 'handoffControl', 'llm', 'systemPrompt', 'approval']
  static Config: z<Config> = z.object({
    mainSessionId: z.string().default('assistant-main'),
    maxActive: z.number().step(1).min(1).default(2),
    maxFileBytes: z.number().step(1).min(1).max(MAX_FILE_TRANSFER_BYTES).default(DEFAULT_MAX_FILE_BYTES),
    workStatusRefreshMs: z.number().step(1).min(500).max(60_000).default(2_500),
    maxNotesBytes: z.number().step(1).min(1).max(65_536).default(4_096),
  })
  /** Ordinary Session that owns all delegation commands and result notices. */
  readonly mainSessionId: SessionId
  private readonly home: Context
  private readonly maxActive: number
  private readonly maxFileBytes: number
  private readonly workStatusRefreshMs: number
  private readonly maxNotesBytes: number
  private domain!: Domain<typeof assistantDomain>
  private closeDomain: (() => Promise<void>) | undefined
  private receipts!: ProjectionHandle<Receipts>
  private executions!: ProjectionHandle<WorkExecution>
  private inputs!: ProjectionHandle<AvailableInputState>
  private chain: Promise<unknown> = Promise.resolve()
  private pump: Promise<void> | undefined
  private dirty = false
  private phase: 'starting' | 'ready' | 'closing' = 'starting'
  private readonly handoffAbort = new AbortController()
  private readonly workers = new Set<SessionId>()
  private readonly restrictions = new Map<Agent, { allow: readonly string[]; lift: () => void }>()
  private readonly ownerApprovedScheduleChanges = new WeakSet<ToolExecution>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'assistant')
    this.home = ctx
    const resolved = config as Required<Config>
    if (!resolved.mainSessionId.trim() || !Number.isSafeInteger(resolved.maxActive) || resolved.maxActive < 1) throw new Error('assistant: invalid mainSessionId or maxActive')
    this.mainSessionId = SessionId(resolved.mainSessionId)
    this.maxActive = resolved.maxActive
    this.maxFileBytes = resolved.maxFileBytes
    this.workStatusRefreshMs = resolved.workStatusRefreshMs
    this.maxNotesBytes = resolved.maxNotesBytes
    ctx.inject(['connection'], (scope) => { registerAssistantArtifacts(scope, this) })
    ctx.effect(() => async () => {
      for (const { lift } of this.restrictions.values()) lift()
      this.restrictions.clear()
      await this.closeDomain?.()
    }, 'assistant: release Session restrictions and storage')
  }

  protected async [Service.init](): Promise<void> {
    this.home.systemPrompt.section({
      name: 'assistant:entrance', order: this.home.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: ({ agent }) => agent?.id === this.mainSessionId ? ENTRANCE_GUIDANCE : '',
    })
    this.home.tools.guard((execution) => {
      const { agent, name, toolSet, arguments: args } = execution
      if (agent === undefined || this.phase !== 'ready') return 'Assistant tools require a live Assistant turn.'
      const role = this.roleOf(agent.id)
      const allow: readonly string[] = role === undefined ? [] : roleTools[role]
      const unavailable = `Tool "${name}" is unavailable in this Assistant Session.`
      if (!allow.includes(name)) return unavailable
      if (role === 'worker') {
        const work = this.activeWork(agent.id)
        if (work === undefined) return 'The work request has already ended.'
        if (name === 'exec' && work.authorization?.grant.permissions.exec !== true) return 'This work has no permission to execute commands.'
      }
      if (toolSet === undefined || this.home.tools.get(name, agent, toolSet) !== this.home.tools.get(name)) return unavailable
      if (SCHEDULE_CHANGE_TOOLS.includes(name)) {
        // A scheduled task that created its own Session would deliver to one without an Assistant role.
        if (schedulesElsewhere(args)) return 'The Assistant schedules deliveries only to this_session.'
        if (!this.ownerApprovedScheduleChanges.has(execution)) return 'Changing a scheduled task requires the owner\'s decision.'
      }
      return undefined
    })
    this.home.on('tools/pre-execute', async (execution, next) => {
      const decision = await next()
      const { agent } = execution
      if (decision.kind !== 'allow' || agent?.id !== this.mainSessionId || !SCHEDULE_CHANGE_TOOLS.includes(execution.name)
        || schedulesElsewhere(execution.arguments)) return decision
      const schedule = this.home.get('schedule')
      if (schedule === undefined) return { kind: 'deny', reason: 'The owner cannot review scheduled task changes here.' }
      const reviewed = await reviewScheduleChange(this.home.approval, schedule, agent, execution)
      if (reviewed.kind === 'allow') this.ownerApprovedScheduleChanges.add(execution)
      return reviewed
    })
    this.home.on('agent/pre-step', async ({ agent, messages, step }, next) => {
      if (this.phase !== 'ready') return { kind: 'reject' }
      const role = this.roleOf(agent.id)
      if (role === undefined) return { kind: 'reject' }
      if (role === 'worker') {
        const active = this.activeWork(agent.id)
        if (active === undefined || !admitsWorkerMessages(messages, step, active)) return { kind: 'reject' }
      }
      if (role === 'entrance' && messages.some(({ source }) =>
        (source.kind === 'user' || source.kind === 'retry') && 'principal' in source,
      )) return { kind: 'reject' }
      await this.flush(agent)
      return next()
    }, { prepend: true })
    this.home.on('llm/stream', (options, next) => {
      if (options.sessionId !== this.mainSessionId || !isAgentLoopRequest(options)) return next()
      return this.releaseReply(options, next)
    }, { prepend: true })

    // The ordinary Session's persistence lease excludes a second Host before any queue mutation.
    const main = await this.ensure(this.mainSessionId)
    await this.flush(main)
    this.domain = await this.home.storageDomain.open(assistantDomain)
    this.closeDomain = () => this.domain.close()
    this.receipts = await this.home.sessionProjections.register(receiptProjection)
    this.executions = await this.home.sessionProjections.register(workExecutionProjection)
    this.inputs = await this.home.sessionProjections.register(workInputProjection(this.mainSessionId))
    const notes = await this.home.sessionProjections.register(notesProjection)
    const previous = this.domain.global.get().mainSessionId
    if (previous !== null && previous !== this.mainSessionId) throw new Error(`assistant: existing entrance is ${previous}; restore mainSessionId`)
    await this.domain.global.set({ mainSessionId: this.mainSessionId })
    await this.attachToWorkspace(main)
    for (const [id, work] of this.domain.table('work').entries()) {
      this.workers.add(work.sessionId)
      if (work.status === 'running') await this.domain.table('work').put(id, { ...work, status: 'unknown', result: 'The Host stopped after dispatch. Inspect the work Session before explicitly continuing; external effects may already have occurred.' })
    }
    registerTools(this.home, this)
    registerNotes(this.home, this.mainSessionId, notes, this.maxNotesBytes)
    this.home.on('agent/created', ({ agent }) => { this.restrict(agent) })
    this.home.on('agent/disposed', ({ agent }) => { this.restrictions.delete(agent) })
    for (const agent of this.home.agents.list()) this.restrict(agent)
    registerAssistantMediation(this.home, this)
    let updatingRestriction = false
    this.home.on('tools/change', () => {
      this.kick()
      if (updatingRestriction || this.phase === 'closing') return
      const entrance = this.home.agents.get(this.mainSessionId)
      if (entrance === undefined || !this.restrictions.has(entrance)) return
      updatingRestriction = true
      try {
        this.restrict(entrance)
      } finally {
        updatingRestriction = false
      }
    })
    this.home.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.phase !== 'ready' || !this.workers.has(agent.id)) return
      void this.exclusive(async () => {
        const work = this.activeWork(agent.id)
        if (work !== undefined) await this.domain.table('work').put(work.id, { ...work, status: 'unknown', result: 'The worker stopped without an explicit report. Inspect its Session before continuing.' })
      }).then(() => { this.kick() }, (error: unknown) => { this.home.logger.warn(errorChain(error)) })
    })
    this.home.sessionTitle.rename(main.session, 'Assistant')
    await this.flush(main)
    this.home.effect(() => async () => {
      this.phase = 'closing'
      this.handoffAbort.abort(new AssistantError('stopping', 'Assistant is stopping.'))
      await this.pump
      await this.chain
      const agents = [this.mainSessionId, ...this.workers]
        .map(id => this.home.agents.get(id)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      await Promise.all(agents.map(agent => agent.whenIdle()))
      await this.chain
    }, 'assistant: drain dispatch and Sessions')
    this.phase = 'ready'
    main.wake()
    this.kick()
  }

  private roleOf(sessionId: SessionId): 'entrance' | 'worker' | undefined {
    if (sessionId === this.mainSessionId) return 'entrance'
    if (this.workers.has(sessionId)) return 'worker'
    return undefined
  }

  /** Called during Agent creation or while dispatch holds its maintenance lock. */
  private restrict(agent: Agent, work?: Work): void {
    const role = this.roleOf(agent.id)
    if (role === undefined) return
    const previous = this.restrictions.get(agent)
    const allow = roleTools[role].filter(name => this.home.tools.get(name) !== undefined
      && (name !== 'exec' || work?.authorization?.grant.permissions.exec === true))
    if (isDeepStrictEqual(previous?.allow, allow)) return
    previous?.lift()
    const disposers = [agent.ctx.tools.restrict({ allow })]
    if (role === 'worker') {
      disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
      const directory = agent.ctx.get('workingDirectory')
      if (directory !== undefined) disposers.push(agent.ctx.systemPrompt.context({
        name: 'working-directory:current', order: agent.ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
        required: true, interpolate: false,
        text: () => `Host Session metadata (not the exec workspace): ${JSON.stringify(directory.get(agent.session))}.`,
      }))
    }
    this.restrictions.set(agent, { allow, lift: () => { for (const dispose of disposers.reverse()) dispose() } })
  }

  private activeWork(id: SessionId): Work | undefined {
    return this.list().find(work => work.sessionId === id && work.status === 'running')
  }

  /**
   * Resolve the Session opened by the browser's Assistant launcher.
   * @param signal - launcher request lifetime.
   * @returns the configured Session identity when the caller may access it.
   */
  @Remote
  entrance(signal: AbortSignal): { sessionId: SessionId } {
    signal.throwIfAborted()
    if (!this.ctx.remoteAccess.allows({ kind: 'session', id: this.mainSessionId })) {
      throw new RemoteError('remote-access/denied', 'Assistant Session is unavailable', { action: 'assistant/entrance', reason: 'no-allow' })
    }
    return { sessionId: this.mainSessionId }
  }

  /**
   * Inspect the entrance grant and retained work without reserving operations or retrying dispatch.
   * @param sessionId - configured entrance Session.
   * @param signal - owner read lifetime.
   * @returns Worker reports, independently verified operation status, and the configured refresh delay.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async workStatus(sessionId: SessionId, signal: AbortSignal): Promise<WorkStatusSnapshot> {
    this.requireWorkEntrance(sessionId)
    const lifetime = AbortSignal.any([signal, this.handoffAbort.signal])
    lifetime.throwIfAborted()
    const handoff = this.home.handoffControl
    const [authority, work] = await Promise.all([
      readBudget(handoff, sessionId, lifetime),
      Promise.all(this.list().reverse().filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })).map(async (item) => {
        const { id, sessionId: worker, prompt, status, result } = item
        const [operations, available] = await Promise.all([
          readWorkAuthority(handoff, item, lifetime),
          this.home.sessionPersistence.stat(worker, { signal: lifetime }),
        ])
        return { id, sessionId: worker, prompt, status, result, inspectable: available !== undefined,
          ...(operations === undefined ? {} : { operations }),
          ...(item.artifacts === undefined ? {} : {
            artifacts: item.artifacts.map(({ name, bytes, digest }) => ({ name, bytes, digest })),
          }),
        }
      })),
    ])
    lifetime.throwIfAborted()
    return { refreshMs: this.workStatusRefreshMs, authority, work }
  }

  /**
   * Read the effective limits through the owner-only authority connection.
   * @param sessionId - Configured entrance Session.
   * @param signal - Owner request lifetime.
   * @returns Current limits and revision, including after expiry.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async grantSettings(sessionId: SessionId, signal: AbortSignal): Promise<OperationGrantBudget> {
    this.requireWorkEntrance(sessionId)
    try {
      return await this.home.handoffControl.grantSettings(AbortSignal.any([signal, this.handoffAbort.signal]))
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not read usage settings.', { reason: error.code }, { cause: error })
    }
  }

  /**
   * List the external actions the authority permits and whether each has a stored credential.
   * @param sessionId - Configured entrance Session.
   * @param signal - Owner request lifetime.
   * @returns Each permitted action and its credential state, never a credential value.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async connections(sessionId: SessionId, signal: AbortSignal): Promise<BrokerConnections> {
    this.requireWorkEntrance(sessionId)
    try {
      return await this.home.handoffControl.brokerConnections(AbortSignal.any([signal, this.handoffAbort.signal]))
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not read connections.', { reason: error.code }, { cause: error })
    }
  }

  /**
   * Read one page of the authority's business records across every work Session, newest first.
   * @param sessionId - Configured entrance Session.
   * @param after - Cursor from the preceding page, or undefined for the newest records.
   * @param signal - Owner request lifetime.
   * @returns Each record's status and exact request body, and a cursor when older records exist.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async records(sessionId: SessionId, after: OperationId | undefined, signal: AbortSignal): Promise<BusinessRecords> {
    this.requireWorkEntrance(sessionId)
    try {
      return await this.home.handoffControl.businessRecords(after, AbortSignal.any([signal, this.handoffAbort.signal]))
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not read business records.', { reason: error.code }, { cause: error })
    }
  }

  /**
   * Record the owner's determination after checking an unresolved external request.
   * @param sessionId - Configured entrance Session.
   * @param resolution - Operation and checked outcome.
   * @param signal - Owner request lifetime; reread records if the reply is lost.
   * @returns Whether the witness confirmed the determination.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async resolveBusiness(sessionId: SessionId, resolution: BusinessResolution, signal: AbortSignal): Promise<{ confirmed: boolean }> {
    this.requireWorkEntrance(sessionId)
    try {
      const result = await this.home.handoffControl.resolveBusiness(resolution, AbortSignal.any([signal, this.handoffAbort.signal]))
      return { confirmed: result.businessCompletion.kind === resolution.kind }
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not record the checked outcome.', { reason: error.code }, { cause: error })
    }
  }

  /**
   * Change one connection in the authority: the owner's stored token, or a permitted external action's unattended rules.
   * @param sessionId - Configured entrance Session.
   * @param update - Target and its replacement token or `null` to remove it, or an action's complete rule list.
   *   This Host forwards the value without retaining it.
   * @param signal - Cancels the wait; a lost response requires rereading connections.
   * @returns The connections after the change, never a credential value.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async setConnection(sessionId: SessionId, update: BrokerConnectionUpdate, signal: AbortSignal): Promise<BrokerConnections> {
    this.requireWorkEntrance(sessionId)
    try {
      return await this.home.handoffControl.setBrokerConnection(update, AbortSignal.any([signal, this.handoffAbort.signal]))
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not save the connection.', { reason: error.code }, { cause: error })
    }
  }

  /**
   * Apply an owner's reviewed budget and expiry without changing capability permissions.
   * @param sessionId - Configured entrance Session.
   * @param update - Exact limits and the revision the owner reviewed.
   * @param signal - Cancels the wait; a lost response requires rereading settings.
   * @returns Witnessed effective limits; earlier reservations and outcomes remain retained.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async updateGrant(sessionId: SessionId, update: OperationGrantUpdate, signal: AbortSignal): Promise<OperationGrantBudget> {
    this.requireWorkEntrance(sessionId)
    try {
      return await this.home.handoffControl.updateGrant(update, AbortSignal.any([signal, this.handoffAbort.signal]))
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not confirm usage settings.', { reason: error.code }, { cause: error })
    }
  }

  /**
   * Record an owner stop for an accepted work request. Earlier effects remain inspectable.
   * @param sessionId - configured entrance Session.
   * @param workId - retained work request to stop.
   * @param signal - cancels before the stop commits. A lost response may follow a committed stop.
   * @returns The durable work state, which may already be terminal.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async stopWork(sessionId: SessionId, workId: AuthorityWorkId, signal: AbortSignal): Promise<{ status: WorkPhase }> {
    this.requireWorkEntrance(sessionId)
    this.requireVisibleWork(workId)
    const { status } = await this.cancelWork(workId, signal)
    return { status }
  }

  /**
   * Check a retained external effect through the authority's read-only reconciliation lookup.
   * @param sessionId - configured entrance Session.
   * @param workId - exact assignment that owns the operation, including after a continuation.
   * @param operationId - retained operation to check.
   * @param signal - cancels the owner wait. Inspect the retained outcome if the response is lost.
   * @returns The latest witnessed external completion state.
   */
  @Remote({ resources: { session: (sessionId: SessionId) => sessionId } })
  async checkOutcome(sessionId: SessionId, workId: AuthorityWorkId, operationId: OperationId, signal: AbortSignal): Promise<{ completion: 'unconfirmed' | 'pending' | 'succeeded' | 'failed' }> {
    this.requireWorkEntrance(sessionId)
    const work = this.requireVisibleWork(workId)
    const lifetime = AbortSignal.any([signal, this.handoffAbort.signal])
    try {
      const result = await this.home.handoffControl.reconcile(work.sessionId, operationId, lifetime, work.id)
      return { completion: result.businessCompletion.kind }
    } catch (error: unknown) {
      if (!(error instanceof OperationControlError)) throw error
      throw new RemoteError('assistant/work-unavailable', 'Could not check the external outcome.', { reason: error.code }, { cause: error })
    }
  }

  private requireWorkEntrance(sessionId: SessionId): void {
    if (sessionId !== this.mainSessionId || this.phase !== 'ready') {
      throw new RemoteError('assistant/work-unavailable', 'Assistant work is unavailable.', { reason: 'entrance-unavailable' })
    }
  }

  private requireVisibleWork(id: WorkId): Work {
    const work = this.domain.table('work').get(id)
    if (work === undefined || !this.ctx.remoteAccess.allows({ kind: 'session', id: work.sessionId })) {
      throw new RemoteError('assistant/work-unavailable', 'Assistant work is unavailable.', { reason: 'work-unavailable' })
    }
    return work
  }

  /**
   * Read durable work records.
   * @returns all retained requests and their current outcomes.
   */
  list(): Work[] { return [...this.domain.table('work').entries()].map(([, work]) => work) }

  /**
   * Ask the authority whether a work's report may reach the entrance model before it is shown there.
   * @param work - retained work request.
   * @param signal - cancels the authority read.
   * @returns the work unchanged, or without its artifacts and with a fixed result sentence when its Session imported
   *   owner files and the authority's current permissions forbid their disclosure.
   * @throws If the authority cannot answer for a work that imported owner files.
   */
  async disclosableWork(work: Work, signal: AbortSignal): Promise<Work> {
    if (work.result === null || (work.authorization?.grant.inputs?.length ?? 0) === 0) return work
    const { disclosesImportedData } = await this.home.handoffControl.overview(
      work.sessionId, AbortSignal.any([signal, this.handoffAbort.signal]), work.id)
    if (disclosesImportedData) return work
    const { artifacts: _withheld, ...rest } = work
    return { ...rest, result: WITHHELD_RESULT }
  }

  /**
   * Return coordinates for the latest owner message that included attachments.
   * @param agent - main Session Agent.
   * @returns file and image metadata suitable for delegate_work input selection.
   */
  listInputs(agent: Agent): readonly AvailableInput[] {
    this.assertMain(agent)
    return this.inputs.stateOf(agent.session).inputs
  }

  /**
   * Identify Sessions whose history may contain attachment contents or export details.
   * @param sessionId - inspected Session.
   * @returns whether the Session requires an owner reader.
   */
  isOwnerOnlyDataSession(sessionId: SessionId): boolean {
    return sessionId === this.mainSessionId || this.list().some(work => work.sessionId === sessionId
      && ((work.authorization?.grant.inputs?.length ?? 0) > 0 || permitsFiles(work.authorization?.grant.permissions, 'export')))
  }

  /**
   * Require the configured entrance.
   * @param agent - calling Agent.
   */
  assertMain(agent: Agent): void {
    if (agent.id !== this.mainSessionId) throw new AssistantError('wrong-session', `Use assistant Session ${this.mainSessionId}.`)
  }

  /**
   * Accept one request or return its prior receipt; a changed payload under the same key fails.
   * @param agent - main Session Agent.
   * @param key - stable caller-selected idempotency key, reused after uncertain replies.
   * @param prompt - complete worker instruction; parent history is not copied.
   * @param previous - terminal request whose Session should continue.
   * @param signal - optional cancellation of admission before the queue write begins.
   * @param permissions - subset of the authority's current delegation ceiling; required for fresh work, and omitted by a
   *   continuation to keep its predecessor's grant.
   * @param inputs - owner attachment coordinates for a fresh worker. A continuation inherits the same files.
   * @returns the durable acceptance receipt, before execution finishes.
   */
  async delegate(
    agent: Agent, key: string, prompt: string, previous: WorkId | null = null, signal?: AbortSignal,
    permissions?: WorkPermissions, inputs?: readonly InputCoordinates[],
  ): Promise<Work> {
    this.assertMain(agent)
    const admissionSignal = signal === undefined
      ? this.handoffAbort.signal : AbortSignal.any([signal, this.handoffAbort.signal])
    const result = await this.exclusive(async () => {
      admissionSignal.throwIfAborted()
      const id = WorkId(createHash('sha256').update(key).digest('hex'))
      const existing = this.domain.table('work').get(id)
      if (existing !== undefined) {
        const existingInputs = inputCoordinates(existing.authorization?.grant.inputs ?? [])
        if (existing.key !== key || existing.prompt !== prompt || existing.previous !== previous
          || !isDeepStrictEqual(existing.authorization?.requestedPermissions, permissions)
          || !isDeepStrictEqual(inputs ?? (previous === null ? [] : existingInputs), existingInputs)) {
          throw new AssistantError('key-conflict', 'This request key already has different instructions, permissions, or inputs. Use a new key for new work.')
        }
        return existing
      }
      if (!key.trim() || !prompt.trim()) throw new AssistantError('invalid-request', 'Request key and prompt must not be empty.')
      const parent = previous === null ? undefined : this.domain.table('work').get(previous)
      if (previous !== null && parent === undefined) throw new AssistantError('missing-work', 'Previous work does not exist.')
      if (parent !== undefined && parent.authorization === undefined) throw new AssistantError('invalid-request', 'Previous work has no recorded permission grant. Create a new work request without a previous work id.')
      if (parent !== undefined && (this.list().some(work => work.sessionId === parent.sessionId && (work.status === 'queued' || work.status === 'running')) || this.home.agents.get(parent.sessionId)?.status === 'running')) throw new AssistantError('busy', 'The work Session is still busy.')
      const attachments = this.inputs.stateOf(agent.session).turnInputs ?? []
      if (parent === undefined && inputs === undefined && attachments.length > 0) {
        const selections = attachments.map(({ name, seq, index }) =>
          `Select ${JSON.stringify(name)} with inputs: ${JSON.stringify([{ seq, index }])}.`).join(' ')
        throw new AssistantError('work-file-denied',
          `Fresh work must state inputs for the attachments in this owner request. ${selections} Pass inputs: [] if this work needs no files. Selected inputs require permissions.data.import: true and both disclosure permissions.`)
      }
      const selected = await this.selectInputs(parent, inputs, admissionSignal)
      const permission = this.home.permissionPresets.current(agent.session)
      this.home.permissionPresets.resolve(permission)
      const command: Work = {
        id, key, prompt, previous,
        sessionId: parent?.sessionId ?? SessionId(`assistant-work-${id}`),
        cwd: agent.session.header.cwd ?? null, preset: agent.session.header.agentPreset ?? null,
        permission, status: 'queued', result: null, notified: false,
      }
      const grant = await this.releaseDelegation(command, permissions, selected, admissionSignal)
      admissionSignal.throwIfAborted()
      if (grant.permissions.exec && this.home.tools.get('exec') === undefined) throw new AssistantError('execution-unavailable', 'Isolated execution is unavailable. Try delegation after it is restored.')
      const authorization = permissions === undefined ? { grant } : { grant, requestedPermissions: permissions }
      const work: Work = { ...command, authorization, ...(parent?.inputsReady === true ? { inputsReady: true } : {}) }
      await this.domain.table('work').put(id, work)
      this.workers.add(work.sessionId)
      return work
    })
    this.kick()
    return result
  }

  /**
   * Persist a worker's explicit result before acknowledging its report tool.
   * @param agent - worker whose active request owns the report.
   * @param status - explicit outcome; idle never implies success.
   * @param result - summary, evidence, or question returned to the main Session.
   * @param artifactPaths - paths to final regular files in the worker workspace.
   * @param signal - optional cancellation while awaiting witnessed artifact exports.
   * @returns durable reported work. A completed report is recorded as `unknown` while an external request of the work has
   *   an unresolved outcome or the authority cannot be read. Imported-file completion requires a nonerror exec result observed
   *   in that work; otherwise it is recorded as failed and withheld. Observation does not verify file use or reported values.
   */
  async report(
    agent: Agent, status: ReportStatus, result: string, artifactPaths: readonly string[] = [], signal?: AbortSignal,
  ): Promise<Work> {
    const work = await this.exclusive(async () => {
      const current = this.activeWork(agent.id)
      if (current === undefined) throw new AssistantError('no-active-work', 'No active request owns this worker.')
      if (status === 'completed' && (current.authorization?.grant.inputs?.length ?? 0) > 0) {
        const execution = this.executions.stateOf(agent.session)
        if (execution.workId !== current.id || !execution.executed) {
          status = 'failed'
          result = `${current.authorization?.grant.permissions.exec === true
            ? 'This work has no observed nonerror exec result for its imported files.'
            : 'This work lacks exec permission to read its imported files.'} Imported-file work cannot be reported complete without that observation. Ask the owner before delegating new work with the required permission.`
          artifactPaths = []
        }
      }
      const lifetime = signal === undefined ? this.handoffAbort.signal : AbortSignal.any([signal, this.handoffAbort.signal])
      const artifacts = await this.exportArtifacts(current, artifactPaths, lifetime)
      lifetime.throwIfAborted()
      let next: Work = { ...current, status, result, ...(artifacts.length === 0 ? {} : { artifacts }) }
      if (status === 'completed') {
        const read = await readUnresolvedBusiness(this.home.handoffControl, current, lifetime)
        if (read.kind === 'unavailable' || read.value.length > 0) {
          const cause = read.kind === 'available'
            ? `The script ran, but the outside request's result is unknown. It may or may not have taken effect. Unresolved operations: ${read.value.join(', ')}.`
            : `The authority could not be read (${read.code}). We cannot confirm whether this work made any outside requests or what their results were. An outside request may or may not have taken effect.`
          next = {
            ...next, status: 'unknown',
            result: `${cause} Tell the owner about this uncertainty. Do not send these requests again without the owner's direction. Inspect them with inspect_business_operations.\n\nWorker report (completed): ${result}`,
          }
        }
      }
      await this.domain.table('work').put(current.id, next)
      return next
    })
    this.kick()
    return work
  }

  /**
   * Retrieve a published artifact for the authenticated owner download route.
   * @param workId - retained work report identity.
   * @param index - zero-based artifact index in that report.
   * @param signal - optional cancellation of the authority read.
   * @returns display name and verified bytes for the original witnessed export.
   */
  async readArtifact(workId: WorkId, index: number, signal?: AbortSignal): Promise<{ name: string; data: Uint8Array }> {
    const artifact = this.phase === 'ready' ? this.domain.table('work').get(workId)?.artifacts?.[index] : undefined
    if (artifact === undefined) throw new OperationControlError('artifact-unavailable', 'This work report has no such artifact.')
    const exported = await this.home.handoffControl.readExportedFile(artifact.operationId, signal)
    const { operationId, outcome, receipt, contentBase64 } = exported
    if (operationId !== artifact.operationId || outcome.workId !== workId || outcome.targetSessionId !== this.mainSessionId
      || outcome.path !== artifact.path || outcome.bytes !== artifact.bytes || outcome.digest !== artifact.digest
      || receipt.digest !== artifact.receiptDigest) {
      throw new OperationControlError('file-mismatch', 'The authority reply does not match the published artifact.', artifact.operationId)
    }
    return { name: artifact.name, data: Buffer.from(contentBase64, 'base64') }
  }

  private async selectInputs(
    parent: Work | undefined, inputs: readonly InputCoordinates[] | undefined, signal: AbortSignal,
  ): Promise<readonly WorkInputFile[]> {
    if (parent !== undefined) {
      const inherited = parent.authorization?.grant.inputs ?? []
      if (inputs !== undefined && !isDeepStrictEqual(inputs, inputCoordinates(inherited))) {
        throw new AssistantError('work-file-denied', 'A continuation keeps the same imported files. Start fresh work to change them.')
      }
      if (inherited.length > 0 && parent.inputsReady !== true) {
        throw new AssistantError('work-file-denied', 'The previous file imports did not finish. Start fresh work with the selected attachments.')
      }
      return inherited
    }
    if (inputs === undefined || inputs.length === 0) return []
    if (inputs.length > MAX_WORK_INPUTS) throw new AssistantError('invalid-request', `Select at most ${MAX_WORK_INPUTS} work attachments.`)
    const selected: WorkInputFile[] = []
    const paths = new Set<string>()
    for (const input of inputs) {
      const { source } = await readWorkInput(this.home, this.mainSessionId, input, this.maxFileBytes, signal)
      const path = workInputPath(source)
      if (paths.has(path)) throw new AssistantError('invalid-request', 'Select each work input file once.')
      paths.add(path)
      selected.push(source)
    }
    return selected
  }

  private async importInputs(work: Work, grant: WorkGrant, signal: AbortSignal): Promise<void> {
    const inputs = grant.inputs ?? []
    if (inputs.length === 0 || work.inputsReady === true) return
    if (!permitsFiles(grant.permissions, 'import')) {
      throw new AssistantError('work-file-denied', 'This work needs import and both disclosure permissions to use the selected attachments.')
    }
    for (const expected of inputs) {
      const { source, data } = await readWorkInput(this.home, this.mainSessionId,
        { seq: expected.messageSeq, index: expected.contentIndex }, this.maxFileBytes, signal)
      if (!isDeepStrictEqual(expected, source)) throw new AssistantError('work-file-denied', 'The attachment no longer matches the granted work input.')
      const requestKey = createHash('sha256').update(JSON.stringify(['import', work.id, source.messageSeq, source.contentIndex])).digest('hex')
      const { outcome, operationId } = await this.home.handoffControl.transferFile({
        requestKey, sessionId: work.sessionId,
        file: { kind: 'import', workId: work.id, source, contentBase64: Buffer.from(data).toString('base64') },
      }, signal)
      if (outcome.kind !== 'file-imported' || outcome.workId !== work.id || !isDeepStrictEqual(outcome.source, expected)
        || outcome.path !== workInputPath(expected) || outcome.digest !== expected.attachmentId || outcome.bytes !== expected.bytes) {
        throw new OperationControlError('file-mismatch', 'The authority reply does not match the granted work input.', operationId)
      }
    }
  }

  private async exportArtifacts(work: Work, paths: readonly string[], signal: AbortSignal): Promise<WorkArtifact[]> {
    if (paths.length === 0) return []
    if (paths.length > MAX_WORK_INPUTS || new Set(paths).size !== paths.length) {
      throw new AssistantError('invalid-request', `Select at most ${MAX_WORK_INPUTS} distinct work artifact paths.`)
    }
    if (!permitsFiles(work.authorization?.grant.permissions, 'export')) {
      throw new AssistantError('work-file-denied', 'This work needs export and both disclosure permissions to deliver files.')
    }
    const artifacts: WorkArtifact[] = []
    for (const path of paths) {
      signal.throwIfAborted()
      const requestKey = createHash('sha256').update(JSON.stringify(['export', work.id, path])).digest('hex')
      const { outcome, operationId, receipt } = await this.home.handoffControl.transferFile({
        requestKey, sessionId: work.sessionId,
        file: { kind: 'export', workId: work.id, path, targetSessionId: this.mainSessionId },
      }, signal)
      if (outcome.kind !== 'file-exported' || outcome.workId !== work.id || outcome.path !== path || outcome.targetSessionId !== this.mainSessionId) {
        throw new OperationControlError('file-mismatch', 'The authority reply does not match the requested artifact.', operationId)
      }
      artifacts.push({ operationId, path, name: path.slice(path.lastIndexOf('/') + 1), bytes: outcome.bytes, digest: outcome.digest, receiptDigest: receipt.digest })
    }
    return artifacts
  }

  /**
   * Cancel queued or running work; interrupted external effects remain inspectable.
   * @param agent - main Session Agent.
   * @param id - request to stop.
   * @returns durable cancellation receipt.
   */
  async stop(agent: Agent, id: WorkId): Promise<Work> {
    this.assertMain(agent)
    return this.cancelWork(id)
  }

  private async cancelWork(id: WorkId, signal?: AbortSignal): Promise<Work> {
    const work = await this.exclusive(async () => {
      signal?.throwIfAborted()
      const current = this.domain.table('work').get(id)
      if (current === undefined) throw new AssistantError('missing-work', 'Work does not exist.')
      if (current.status !== 'queued' && current.status !== 'running') return current
      const next: Work = { ...current, status: 'canceled', result: 'Work was canceled. Inspect its Session for effects performed before cancellation.' }
      await this.domain.table('work').put(id, next)
      this.home.agents.get(current.sessionId)?.cancel({ kind: 'user' })
      return next
    })
    this.kick()
    return work
  }

  /** Retry pending dispatch or delivery after an operator repairs a reported storage error. */
  retry(): void { this.kick() }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.phase === 'closing') return Promise.reject(new AssistantError('stopping', 'Assistant is stopping.'))
    const result = this.chain.then(task)
    this.chain = result.catch((_error: unknown) => { /* The returned promise reports this operation's failure. */ })
    return result
  }

  private kick(): void {
    if (this.phase !== 'ready') return
    this.dirty = true
    if (this.pump !== undefined) return
    this.pump = Promise.resolve().then(async () => {
      try {
        while (this.dirty && this.phase === 'ready') {
          this.dirty = false
          await this.exclusive(() => this.drain())
        }
      } catch (error: unknown) {
        this.home.logger.warn(`assistant dispatch paused; list_work retries after repair: ${errorChain(error)}`)
      } finally {
        this.pump = undefined
      }
    })
  }

  private async drain(): Promise<void> {
    for (const work of this.list()) {
      if (this.phase === 'closing') return
      if (work.status === 'queued') {
        const active = new Set(this.list().filter(item => item.status === 'running').map(item => item.sessionId))
        for (const id of this.workers) {
          if (this.home.agents.get(id)?.status === 'running') active.add(id)
        }
        if (active.size >= this.maxActive) continue
        await this.dispatch(work)
      } else if (work.status !== 'running' && !work.notified && this.home.agents.get(work.sessionId)?.status !== 'running') {
        await this.deliver(work)
      }
    }
  }

  private async ensure(id: SessionId, work?: Work): Promise<Agent> {
    if (this.home.agents.get(id) === undefined && await this.home.sessionPersistence.stat(id) === undefined) {
      const created = await this.home.sessionController.create({ sessionId: id,
        ...(work?.cwd == null ? {} : { cwd: work.cwd }),
        ...(work?.preset == null ? {} : { agentPreset: work.preset }),
      })
      if (created.sessionId !== id) throw new AssistantError('session-unavailable', `Reserved Session ${id} could not be reused.`)
    }
    const resolved = await this.home.sessionController.resolveAgent(id)
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }

  private async dispatch(work: Work): Promise<void> {
    const { authorization } = work
    if (authorization === undefined) {
      await this.domain.table('work').put(work.id, { ...work, status: 'failed', result: 'Queued work has no recorded permission grant. Create a new work request with a new key.' })
      this.dirty = true
      return
    }
    const requiresExec = authorization.grant.permissions.exec
    if (requiresExec && this.home.tools.get('exec') === undefined) return
    let preparing = false
    try {
      const grant = await this.releaseDelegation(
        work, authorization.requestedPermissions, authorization.grant.inputs ?? [], this.handoffAbort.signal,
      )
      if (!isDeepStrictEqual(grant, authorization.grant)) throw new OperationControlError('handoff-mismatch', 'The authority returned a different work grant.')
      if (this.handoffAbort.signal.aborted || (requiresExec && this.home.tools.get('exec') === undefined)) return
      preparing = true
      await this.importInputs(work, grant, this.handoffAbort.signal)
      this.handoffAbort.signal.throwIfAborted()
      // A failure during worker setup must not discard imports the authority has already completed.
      if (grant.inputs?.length && work.inputsReady !== true) await this.domain.table('work').put(work.id, { ...work, inputsReady: true })
      const worker = await this.ensure(work.sessionId, work)
      if (this.phase === 'closing') return
      if (worker.status !== 'idle') throw new AssistantError('busy', `Reserved worker ${worker.id} is busy.`)
      await this.attachToWorkspace(worker)
      await worker.runMaintenance(async () => {
        try {
          worker.inbox.clear()
          this.home.permissionPresets.set(worker.session, work.permission)
          this.home.sessionTitle.rename(worker.session, work.prompt.slice(0, 80))
          await this.flush(worker)
          if (requiresExec && this.home.tools.get('exec') === undefined) return
          this.restrict(worker, work)
          // This write precedes every possible model/tool effect. Recovery never replays it.
          await this.domain.table('work').put(work.id, { ...work, status: 'running', ...(grant.inputs?.length ? { inputsReady: true } : {}) })
          worker.inbox.prepend('next-turn', createUserMessage(requestMessage(work)))
          await this.flush(worker)
          if (this.phase === 'ready') worker.wake()
        } catch (error: unknown) {
          worker.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      const current = this.domain.table('work').get(work.id)
      if (this.handoffAbort.signal.aborted && current?.status === 'queued') return
      if (preparing) this.home.agents.get(work.sessionId)?.cancel({ kind: 'user' })
      await this.domain.table('work').put(work.id, { ...work, ...current,
        status: current?.status === 'running' ? 'unknown' : 'failed',
        result: preparing
          ? `Dispatch stopped: ${errorChain(error)}. Inspect the worker before explicitly continuing.`
          : `Delegation authorization blocked worker setup: ${errorChain(error)}. Check the operation authority before explicitly continuing.`,
      })
      this.dirty = true
    }
  }

  private async releaseDelegation(
    work: Work, permissions: WorkPermissions | undefined, inputs: readonly WorkInputFile[], signal: AbortSignal,
  ): Promise<WorkGrant> {
    const { id, previous, prompt, cwd, preset, permission } = work
    signal.throwIfAborted()
    const release = await this.home.handoffControl.release({
      kind: 'delegation', key: id, sessionId: this.mainSessionId, targetSessionId: work.sessionId,
      content: JSON.stringify({ id, previous, prompt, cwd, preset, permission, ...(inputs.length === 0 ? {} : { inputs }) }),
      delegation: {
        workId: id, previousWorkId: previous,
        ...(permissions === undefined ? {} : { permissions }),
        ...(inputs.length === 0 ? {} : { inputs }),
      },
    }, signal)
    if (release.work === undefined) throw new OperationControlError('handoff-mismatch', 'The authority returned no work grant.', release.operationId)
    if (!isDeepStrictEqual(release.work.inputs ?? [], inputs)) {
      throw new OperationControlError('handoff-mismatch', 'The authority returned different work inputs.', release.operationId)
    }
    const { data } = release.work.permissions
    if (inputs.length > 0 && (data?.discloseToModel !== true || !data.discloseToUser || (previous === null && !data.import))) {
      throw new AssistantError('work-file-denied', 'The work grant does not permit the selected attachments.')
    }
    return release.work
  }

  private async *releaseReply(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const signal = options.signal === undefined
      ? this.handoffAbort.signal : AbortSignal.any([options.signal, this.handoffAbort.signal])
    const chunks: StreamChunk[] = []
    let bytes = 2
    let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
    for await (const chunk of next()) {
      signal.throwIfAborted()
      if (finish !== undefined) throw LlmError.fromFailure({ message: 'The Assistant reply continued after its terminal chunk.', code: 'ASSISTANT_REPLY_INVALID' })
      const saved = snapshotJsonValue(chunk)
      if (saved === undefined) throw LlmError.fromFailure({ message: 'The Assistant reply could not be encoded for delivery.', code: 'ASSISTANT_REPLY_INVALID' })
      bytes += Buffer.byteLength(JSON.stringify(saved)) + (chunks.length === 0 ? 0 : 1)
      if (bytes > MAX_REPLY_BYTES) throw LlmError.fromFailure({ message: 'The Assistant reply exceeds the delivery limit.', code: 'ASSISTANT_REPLY_TOO_LARGE' })
      chunks.push(saved)
      if (saved.type === 'finish') finish = saved
    }
    signal.throwIfAborted()
    if (finish === undefined) throw LlmError.fromFailure({ message: 'The Assistant reply ended before its terminal chunk.', code: 'ASSISTANT_REPLY_INVALID' })
    if (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') {
      yield finish
      return
    }
    try {
      await this.home.handoffControl.release({
        kind: 'delivery', key: createHash('sha256').update(JSON.stringify(options.messages)).digest('hex'),
        sessionId: this.mainSessionId, targetSessionId: this.mainSessionId, content: JSON.stringify(chunks),
      }, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof OperationControlError) {
        throw LlmError.fromFailure({ message: `The Assistant could not release the reply. ${error.message}`, code: error.code }, { cause: error })
      }
      throw LlmError.fromFailure({ message: 'The Assistant could not release the reply. Check the operation authority before retrying.', code: 'ASSISTANT_DELIVERY_UNAVAILABLE' }, { cause: error })
    }
    for (const chunk of chunks) {
      signal.throwIfAborted()
      yield chunk
    }
  }

  private async attachToWorkspace(agent: Agent): Promise<void> {
    const { cwd } = agent.session.header
    if (cwd === undefined) return
    const workspace = await this.home.workspaceRegistry.create(cwd)
    await workspace.attachSession(agent.id)
  }

  private async deliver(work: Work): Promise<void> {
    const main = await this.ensure(this.mainSessionId)
    if (!this.receipts.stateOf(main.session).includes(work.id)) {
      const shown = await this.disclosableWork(work, this.handoffAbort.signal)
      const artifacts = shown.artifacts?.map(({ name, bytes, digest }) => ({ name, bytes, digest }))
      main.send(createUserMessage({
        content: [{
          type: 'text',
          text: JSON.stringify({ work_id: work.id, session_id: work.sessionId, status: work.status, result: shown.result,
            ...(artifacts === undefined ? {} : { artifacts, artifact_delivery: 'The owner downloads these files from the work result card. Name each file in your reply without linking it.' }) }),
        }],
        source: {
          kind: 'assistant-work', workId: work.id, direction: 'result',
          form: 'notice', summary: boundContextSummary(`${work.status}: ${work.prompt}`),
          ...(artifacts === undefined ? {} : { artifacts }),
        },
      }), 'next-turn', false)
    }
    await this.flush(main)
    await this.domain.table('work').put(work.id, { ...work, notified: true })
    main.wake()
  }

  private async flush(agent: Agent): Promise<void> {
    if (!await this.home.sessions.flush(agent.session)) throw new AssistantError('missing-writer', `Session ${agent.id} has no persistence writer.`)
  }
}
export default AssistantRuntime
