/** Agent-side execution and business operation inspection through the operation authority. */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createExecTool, renderExecutionObservation } from '@deepseek-ai/dsh-execution-container/library'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import z from '@deepseek-ai/schemastery'
import { OperationControlClient, OperationControlError, type OperationId, type OperationStatus } from './client.ts'
import { MAX_REQUEST_BYTES, operationIdSchema, sessionIdSchema, WITNESS_WAITING_MESSAGE } from './protocol.ts'
import { approvalDictionaries } from './approval-locales.ts'

/** Cordis plugin name. */
export const name = 'operation-control-agent'
/** The tool registry is required. Approval mode checks its additional Host services at startup. */
export const inject = ['tools']

/** Connection to an independently operated execution authority. */
export interface Config {
  /** Unix socket granted to this Host's operating-system account. */
  socketPath: string
  /** Maximum time to await an authority response, including execution. */
  timeoutMs?: number
  /** Maximum encoded request body size. */
  maxRequestBytes?: number
  /** Review proposals and inspect business operations through the configured main Session. */
  approval?: {
    /** Separate Host-only Unix socket for approval decisions. */
    socketPath: string
    /** Main Session that presents approvals and can inspect business operations. */
    mainSessionId: string
  } | undefined
}

/** Validate the local authority connection before registering execution. */
export const Config: z<Config> = z.object({
  socketPath: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
  timeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(60_000),
  maxRequestBytes: z.number().step(1).min(256).max(Number.MAX_SAFE_INTEGER).default(MAX_REQUEST_BYTES),
  approval: z.union([z.object({
    socketPath: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
    mainSessionId: z.string().min(1).max(256).pattern(/^[^\u0000\r\n]+$/u).required(),
  }), z.const(undefined)]),
})

async function cancelOperation(client: OperationControlClient, id: OperationId): Promise<OperationStatus> {
  try {
    return await client.cancel(id)
  } catch (cause) {
    throw new HarnessError(
      `Execution ${id} has no confirmed cancellation reply. Query its authority record before continuing.`, 'EXEC_UNKNOWN', { cause },
    )
  }
}

function operationReviewer(ctx: Context, config: Config, client: OperationControlClient) {
  if (config.approval === undefined) return undefined
  const { agents, approval } = ctx
  if (resolve(config.approval.socketPath) === resolve(config.socketPath)) {
    throw new Error('Execution approval requires a separate Host-only decision socket.')
  }
  const mainSessionId = sessionIdSchema.parse(config.approval.mainSessionId)
  const { timeoutMs, maxRequestBytes } = config
  const reviewer = new OperationControlClient({
    socketPath: config.approval.socketPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
  })

  return async (
    proposal: OperationStatus, sessionId: SessionId, expected: { command: string } | { parentId: OperationId }, signal: AbortSignal,
  ): Promise<OperationStatus> => {
    const { id, review } = proposal
    let approved: boolean
    let decided: OperationStatus
    try {
      const matches = review !== undefined && review.sessionId === sessionId && ('command' in expected
        ? 'command' in review && review.command === expected.command
        : 'business' in review && review.business.parentId === expected.parentId)
      if (proposal.state !== 'pending-approval' || review === undefined || !matches) {
        throw new HarnessError(proposal.state === 'pending-evidence' ? `${WITNESS_WAITING_MESSAGE} Operation: ${id}.`
          : `Execution ${id} does not have a matching approval review.`, 'EXEC_APPROVAL_MISMATCH')
      }
      const agent = agents.get(mainSessionId)
      if (agent === undefined) {
        throw new HarnessError(`Execution ${id} cannot be reviewed. Open the main Session before trying again.`, 'EXEC_APPROVAL_UNAVAILABLE')
      }
      const { workId, principalId } = review
      const repeats = 'business' in review ? review.repeats : undefined
      const displayReason = Object.fromEntries(Object.entries(approvalDictionaries).map(([locale, text]) => {
        const question = 'command' in review ? text.script : review.presentation?.title[locale]
          ?? review.presentation?.title.en ?? text.business.replace('{action}', JSON.stringify(review.business.action))
        const attribution = workId === undefined || principalId === undefined
          ? text.session.replace('{id}', review.sessionId.length > 12 ? `${review.sessionId.slice(0, 8)}…` : review.sessionId)
          : text.work.replace('{id}', `${workId.slice(0, 8)}…`).replace('{principal}', principalId)
        return [locale, `${question} ${attribution}${repeats === undefined ? '' : ` ${text.repeat.replace('{id}', `${repeats.slice(0, 8)}…`)}`}`]
      })) as { en: string; [locale: string]: string }
      const decision = await approval.requestBackground({
        agent,
        toolName: 'exec',
        reason: `Execution ${id} for work Session ${review.sessionId}${workId === undefined || principalId === undefined ? '' : `, work ${workId}, principal ${principalId}`}, grant ${review.revision}, payload ${review.payloadDigest}${repeats === undefined ? '' : `, repeats unresolved operation ${repeats}`}.`,
        displayReason,
        detail: 'command' in review ? review.command
          : `${review.business.tool === undefined ? review.business.method : `Tool ${review.business.tool} at`} ${
            review.business.endpoint}\nCredential: ${review.business.credentialRef}${
            review.business.reconciliationEndpoint === undefined ? '' : `\nStatus lookup: GET ${review.business.reconciliationEndpoint}`
          }\n\n${review.presentation === undefined ? '' : `${review.presentation.detail}\n\n`}JSON\n${review.business.body}`,
        signal,
      })
      signal.throwIfAborted()
      if (decision === 'unavailable') {
        throw new HarnessError(`Approval for execution ${id} is unavailable. Open the main Session before trying again.`, 'EXEC_APPROVAL_UNAVAILABLE')
      }
      if (decision === 'cancelled') {
        throw new HarnessError(`Approval for execution ${id} was canceled.`, 'EXEC_CANCELLED')
      }
      approved = decision === 'allowed-once'
      decided = await reviewer.decide({
        id, revision: review.revision, payloadDigest: review.payloadDigest, decision: approved ? 'approve' : 'deny',
      }, signal)
      if (approved ? decided.state !== 'issued' || decided.admission === undefined : decided.state !== 'canceled') {
        throw new HarnessError(decided.state === 'pending-evidence' ? `${WITNESS_WAITING_MESSAGE} Operation: ${id}.`
          : `Execution ${id} is ${decided.state} after review. Inspect its authority record.`, 'EXEC_NOT_ISSUED')
      }
    } catch (cause) {
      const canceled = await cancelOperation(client, id)
      if (canceled.state !== 'canceled') {
        throw new HarnessError(`Execution ${id} is ${canceled.state} after cancellation. Inspect its authority record.`, 'EXEC_UNKNOWN', { cause })
      }
      if (signal.aborted) {
        throw new HarnessError(`Approval for execution ${id} was canceled.`, 'EXEC_CANCELLED', { cause })
      }
      if ('parentId' in expected && cause instanceof OperationControlError && cause.code === 'revision-mismatch') {
        throw new HarnessError(`Execution ${id} could not be approved under the current grant.`, 'EXEC_APPROVAL_DENIED', { cause })
      }
      if (cause instanceof HarnessError) throw cause
      throw new HarnessError(`Approval for execution ${id} could not be confirmed. Authority state is ${canceled.state}.`, 'EXEC_APPROVAL_UNAVAILABLE', { cause })
    }
    if (!approved) throw new HarnessError(`Execution ${id} was not approved.`, 'EXEC_APPROVAL_DENIED')
    return decided
  }
}

async function inspectBusinessOperations(
  client: OperationControlClient, sessionId: SessionId, reconcile: boolean, after: OperationId | undefined, signal: AbortSignal,
): Promise<string> {
  const page = await client.businessOperations(sessionId, signal, after)
  signal.throwIfAborted()
  if (!reconcile) return JSON.stringify(page)
  const operations = []
  for (const operation of page.operations) {
    if (!operation.canReconcile) {
      operations.push(operation)
      continue
    }
    try {
      operations.push(await client.reconcile(sessionId, operation.id, signal))
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (!(error instanceof OperationControlError)) throw error
      operations.push({ ...operation, reconciliationError: error.code })
    }
    signal.throwIfAborted()
  }
  return JSON.stringify({ ...page, operations })
}

function registerAdapter(ctx: Context, config: Config): void {
  const client = new OperationControlClient(config)
  const review = operationReviewer(ctx, config, client)
  const lifetime = new AbortController()
  const active = new Set<Promise<string>>()
  const execute = async (sessionId: SessionId, command: string, signal: AbortSignal): Promise<string> => {
    const proposal = await client.propose({ requestKey: randomUUID(), sessionId, command }, signal)
    // The authority admits a shell proposal without review when its operator configured unattended shell.
    const issued = review === undefined || proposal.state === 'issued' ? proposal : await review(proposal, sessionId, { command }, signal)
    if (issued.state !== 'issued' || issued.admission === undefined) {
      throw new HarnessError(issued.state === 'pending-evidence' ? `${WITNESS_WAITING_MESSAGE} Operation: ${issued.id}.`
        : `Execution ${issued.id} is ${issued.state}. Inspect its authority record before continuing.`, 'EXEC_NOT_ISSUED')
    }
    let outcome
    const businessOperations = new Set<OperationId>()
    let cancellation: Promise<OperationStatus> | undefined
    const cancel = () => cancellation ??= cancelOperation(client, issued.id)
    try {
      if (review === undefined) {
        outcome = await client.execute(issued.id, signal)
      } else {
        const monitor = new AbortController()
        const monitoringSignal = AbortSignal.any([signal, monitor.signal])
        const execution = client.execute(issued.id, signal).finally(() => { monitor.abort() })
        const approvals = (async () => {
          for (;;) {
            let child
            try {
              child = await client.waitReview(issued.id, monitoringSignal)
            } catch (cause) {
              if (monitoringSignal.aborted || (cause instanceof OperationControlError
                && (cause.code === 'broker-unavailable' || cause.code === 'broker-parent-inactive'))) return
              throw cause
            }
            if (child === undefined) continue
            businessOperations.add(child.id)
            try {
              await review(child, sessionId, { parentId: issued.id }, monitoringSignal)
            } catch (cause) {
              if (monitoringSignal.aborted) return
              if (!(cause instanceof HarnessError) || cause.code !== 'EXEC_APPROVAL_DENIED') throw cause
            }
          }
        })()
        try {
          [outcome] = await Promise.all([execution, approvals])
        } catch (cause) {
          await cancel()
          throw cause
        } finally {
          monitor.abort()
          await Promise.allSettled([execution, approvals])
        }
      }
    } catch (cause) {
      if (signal.aborted) {
        const canceled = await cancel()
        throw new HarnessError(`Cancellation requested for execution ${issued.id}. Authority state is ${canceled.state}. Inspect its recorded outcome before continuing.`, 'EXEC_CANCELLED', { cause })
      }
      throw new HarnessError(`Execution ${issued.id} has no confirmed reply. Query its authority record before trying again.`, 'EXEC_UNKNOWN', { cause })
    }
    if (outcome.state !== 'settled' || outcome.outcome?.kind !== 'exited' || outcome.receipt === undefined) {
      throw new HarnessError(`Execution ${issued.id} is ${outcome.state}. Inspect its authority record before continuing.`, 'EXEC_UNKNOWN')
    }
    const businessResults = await Promise.all([...businessOperations].map(async (id) => {
      try {
        const status = await client.status(id, signal)
        const response = status.state === 'settled' && status.outcome?.kind === 'business-response'
          ? `${status.outcome.statusCode === undefined
            ? `tool result${status.outcome.toolError === true ? ' marked as an error' : ''}` : `HTTP ${status.outcome.statusCode}`} observed${
            status.outcome.responseDigest === undefined ? '' : `; response sha256 ${status.outcome.responseDigest}`
          }; business completion is not verified`
          : status.state === 'settled' && status.outcome?.kind === 'business-not-sent'
            ? `not sent (${status.outcome.code})` : status.state
        return `External operation ${id}: ${response}${status.receipt === undefined ? '' : `; evidence ${status.receipt.digest}`}`
      } catch (cause) {
        // A lost status reply cannot establish an external result, even when the script exited successfully.
        void cause
        return `External operation ${id}: result unknown. Inspect its authority record before continuing.`
      }
    }))
    return [
      `${renderExecutionObservation(outcome.outcome.observation)}\nOperation: ${outcome.id}\nEvidence: ${outcome.receipt.digest}`,
      ...businessResults,
    ].join('\n')
  }
  ctx.effect(() => async () => {
    lifetime.abort(new Error('The operation-control agent was unloaded'))
    await Promise.allSettled(active)
  }, 'operation-control-agent.cancel')
  const track = (pending: Promise<string>) => {
    active.add(pending)
    return pending.finally(() => { active.delete(pending) })
  }
  ctx.tools.register(createExecTool((sessionId, command, signal) =>
    track(execute(sessionId, command, AbortSignal.any([signal, lifetime.signal])))))

  if (config.approval === undefined) return
  const mainSessionId = sessionIdSchema.parse(config.approval.mainSessionId)
  ctx.tools.register(defineTool({
    name: 'list_business_actions',
    description: 'List the external actions a worker may request, with each action’s purpose and JSON body. Call this before delegating work that needs an external action, and include the action name and body format in the worker’s instructions.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(_args, { agent, signal }) {
      if (agent === undefined || agent !== ctx.agents.get(mainSessionId)) {
        throw new HarnessError('Listing external actions requires the main Session.', 'BUSINESS_ACTIONS_FORBIDDEN')
      }
      return track(client.businessActions(AbortSignal.any([signal, lifetime.signal])).then(actions => JSON.stringify(actions)))
    },
  }), { when: ({ agent }) => agent === ctx.agents.get(mainSessionId) })
  ctx.tools.register(defineTool({
    name: 'inspect_business_operations',
    description: 'Inspect recorded external operations for a worker Session. Set reconcile to true to check unresolved operations with a read-only lookup. Only succeeded or failed business completion with a receipt confirms the outcome. Do not resend an operation whose outcome is uncertain.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Worker Session id returned by delegate_work or list_work.' },
      reconcile: { type: 'boolean', default: false, description: 'Look up each eligible unresolved operation on this page once.' },
      after: { type: 'string', description: 'Use the previous result’s next value to read older operations.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute({ session_id, reconcile = false, after }, { agent, signal }) {
      if (agent === undefined || agent !== ctx.agents.get(mainSessionId)) {
        throw new HarnessError('External operation inspection requires the main Session.', 'BUSINESS_INSPECTION_FORBIDDEN')
      }
      const sessionId = sessionIdSchema.safeParse(session_id)
      const cursor = operationIdSchema.optional().safeParse(after)
      if (!sessionId.success || !cursor.success) {
        throw new HarnessError('Provide a worker Session id and, if present, the next value returned by inspection.', 'BUSINESS_INSPECTION_INVALID')
      }
      return track(inspectBusinessOperations(client, sessionId.data, reconcile, cursor.data, AbortSignal.any([signal, lifetime.signal])))
    },
  }), { when: ({ agent }) => agent === ctx.agents.get(mainSessionId) })
}

/**
 * Register authority-owned execution and optional main Session inspection.
 * @param ctx - owner of the tool registration.
 * @param config - local authority connection and optional main Session approval route.
 * @returns Completion of registration in the current Host service scope.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = Config(config)
  if (resolved.approval === undefined) {
    registerAdapter(ctx, resolved)
    return
  }
  if (ctx.get('agents') === undefined || ctx.get('approval') === undefined) {
    throw new Error('Execution approval requires the Host agents and approval services.')
  }
  await ctx.inject(['agents', 'approval'], (scope) => { registerAdapter(scope, resolved) })
}
