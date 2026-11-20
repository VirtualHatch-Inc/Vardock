/** Run the local operation authority under its operator-owned Cordis profile. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { OperationBroker } from '@deepseek-ai/dsh-operation-broker'
import { isBearerToken } from '@deepseek-ai/dsh-operation-broker/library'
import { EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { prettifyError } from 'zod'
import { OperationAuthority, type AuthorityOptions } from './authority.ts'
import { combineBrokers, type AuthorityBroker } from './brokers.ts'
import { OperationControlError } from './client.ts'
import { modelIdPattern, observeModel } from './model-protocol.ts'
import {
  DEFAULT_MAX_FILE_BYTES, MAX_FILE_TRANSFER_BYTES, MAX_MODEL_RESPONSE_BYTES, MAX_SOCKET_PATH_BYTES,
  sessionIdSchema, unattendedActionsSchema, workPermissionsSchema, workPrincipalIdSchema, type UnattendedAction,
} from './protocol.ts'
import { OperationStore } from './store.ts'

export { OperationControlError } from './client.ts'

/** Cordis plugin name. */
export const name = 'operation-control'

/** Run scripts through the authority profile's isolated execution provider. */
export const inject = ['isolatedExecution']

/** Operator configuration for one principal's operation grant. */
export interface Config {
  /** Fixed operator-assigned identity for callers admitted to the authority socket. */
  readonly principalId: string
  /** Fixed operator-assigned identity for the isolated workspace scope. */
  readonly scopeId: string
  /** Unix socket to listen on. */
  readonly socketPath: string
  /** Unix socket for trusted approval decisions and grant limit edits. Required with Assistant or broker access. */
  readonly approvalSocketPath?: string | undefined
  /**
   * Service names of the mounted broker providers, such as `operationBroker` and `operationBrokerMcp`.
   * A non-empty list permits approved business requests from a running isolated execution.
   */
  readonly broker?: string[]
  /**
   * Admit shell proposals without a human decision. Business requests still wait for one.
   * Requires an execution backend without general network access.
   */
  readonly unattendedShell?: boolean
  /**
   * Initial broker actions whose matching requests are sent without a human decision. Each action must be in
   * `assistant.permissions.brokerActions`. A rule with `match` must list its other permitted fields in `allow`.
   * An action takes at most 64 rules. After the owner's first witnessed edit, the owner's rules replace these; each
   * action's rules apply only while its broker route digest equals the one they were saved under.
   */
  readonly unattendedBrokerActions?: UnattendedAction[]
  /** Authority-owned SQLite database path on a local filesystem. */
  readonly databasePath: string
  /** Unix socket of the separate append-only evidence receiver. */
  readonly evidenceSocketPath: string
  /** Initial expiry in UTC epoch milliseconds. Witnessed owner edits take precedence. */
  readonly grantExpiresAt: number
  /** Initial lifetime reservation cap across all Sessions. Witnessed owner edits take precedence. */
  readonly maxOperations: number
  /** Maximum decoded bytes in one imported file or exported snapshot. */
  readonly maxFileBytes?: number
  /** Timeout for incoming request headers and body before admission. */
  readonly requestTimeoutMs?: number
  /** Timeout for an independent evidence acknowledgment. */
  readonly evidenceTimeoutMs?: number
  /** Permit this one model on the same budget. The authority profile must mount the provider's LLM adapter. */
  readonly model?: {
    /** Provider route registered in the authority's LLM runtime, such as `openai` or `codex-local`. */
    readonly provider: string
    /** Exact model ID of that provider. */
    readonly model: string
    /** Credential reference the provider's adapter reads its API key from. Naming it lets the owner set that key. */
    readonly credentialRef?: string
  } | undefined
  /** Permit the main Assistant Session to release handoffs on the same budget. */
  readonly assistant?: {
    /** Exact Session identity that can delegate work and deliver to its user. */
    readonly mainSessionId: string
    /** Maximum shell and business permissions a delegation can grant. */
    readonly permissions: {
      /** Allow delegations to grant isolated shell execution. */
      readonly exec: boolean
      /** Exact broker action IDs that delegations may grant. An empty list permits none. */
      readonly brokerActions: string[]
      /** Maximum file-transfer and disclosure permissions. Omission denies these capabilities. */
      readonly data?: {
        /** Permit scoped owner files to be imported. */
        readonly import: boolean
        /** Permit workspace snapshots to be exported to the owner. */
        readonly export: boolean
        /** Permit the work model to receive information from transferred files. */
        readonly discloseToModel: boolean
        /** Permit the owner to receive information from transferred files. */
        readonly discloseToUser: boolean
        /** Permit business response text to be returned to the work's scripts, and so to the work model. */
        readonly returnResponses: boolean
      } | undefined
    }
  } | undefined
}

const absolutePath = /^\/[^\u0000\r\n]+$/u
const identity = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u

/** Validate the authority's static grant and transport configuration. */
export const Config: z<Config> = z.object({
  principalId: z.string().pattern(identity).required(),
  scopeId: z.string().pattern(identity).required(),
  socketPath: z.string().pattern(absolutePath).required(),
  approvalSocketPath: z.union([z.string().pattern(absolutePath).required(), z.const(undefined)]),
  broker: z.array(z.string().min(1).required()).default([]),
  unattendedShell: z.boolean().default(false),
  unattendedBrokerActions: z.transform(z.array(z.object({
    action: z.string().pattern(/^[a-z][a-z0-9._-]{0,63}$/u).required(),
    match: z.union([z.dict(z.union([z.string(), z.number(), z.boolean()])), z.const(undefined)]),
    allow: z.union([z.array(z.string().min(1).max(256).required()).max(64), z.const(undefined)]),
  }).required()), (rules) => {
    const parsed = unattendedActionsSchema.safeParse(rules)
    if (!parsed.success) throw new Error(`Invalid unattendedBrokerActions: ${prettifyError(parsed.error)}`)
    return parsed.data
  }).default([]),
  databasePath: z.string().pattern(absolutePath).required(),
  evidenceSocketPath: z.string().pattern(absolutePath).required(),
  grantExpiresAt: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxOperations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxFileBytes: z.number().step(1).min(1).max(MAX_FILE_TRANSFER_BYTES).default(DEFAULT_MAX_FILE_BYTES),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
  evidenceTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
  model: z.union([z.object({
    provider: z.string().pattern(modelIdPattern).required(),
    model: z.string().pattern(modelIdPattern).required(),
    credentialRef: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  }), z.const(undefined)]),
  assistant: z.union([z.object({
    mainSessionId: z.string().min(1).max(256).pattern(/^[^\u0000\r\n]+$/u).required(),
    permissions: z.object({
      exec: z.boolean().required(),
      brokerActions: z.array(z.string().pattern(/^[a-z][a-z0-9._-]{0,63}$/u).required()).required(),
      data: z.union([z.object({
        import: z.boolean().required(),
        export: z.boolean().required(),
        discloseToModel: z.boolean().required(),
        discloseToUser: z.boolean().required(),
        returnResponses: z.boolean().required(),
      }), z.const(undefined)]),
    }).required(),
  }), z.const(undefined)]),
})

/**
 * Open the authority state and activate the isolated executor and sockets.
 * @param ctx - lifecycle owner with an isolated execution provider.
 * @param config - operator-supplied grant, socket paths, and optional model and Assistant grants.
 * @returns completion of backend preflight, state recovery, and socket setup.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = Config(config) as Required<Config>
  const names = resolved.broker
  if (names.length === 0) return startAuthority(ctx, resolved)
  if (new Set(names).size !== names.length) throw new Error('Operation control lists a broker service more than once')
  const provider = (scope: Context, name: string): OperationBroker => {
    // A configured service name is operator input, so the mounted value is checked instead of trusted.
    const service: unknown = scope.get(name)
    if (!(service instanceof OperationBroker)) throw new Error(`Operation control requires a mounted operation broker named "${name}"`)
    return service
  }
  for (const name of names) provider(ctx, name)
  await ctx.inject(names, scope => startAuthority(scope, resolved, combineBrokers(names.map(name => provider(scope, name)))))
}

async function startAuthority(ctx: Context, resolved: Required<Config>, broker?: AuthorityBroker): Promise<void> {
  const sockets = [resolved.socketPath, resolved.evidenceSocketPath]
  const { approvalSocketPath } = resolved
  if (approvalSocketPath !== undefined) sockets.push(approvalSocketPath)
  if (resolved.assistant !== undefined && approvalSocketPath === undefined) {
    throw new Error('Operation control requires approvalSocketPath for the Assistant grant')
  }
  if (broker !== undefined && approvalSocketPath === undefined) {
    throw new Error('The operation broker requires approvalSocketPath')
  }
  if (sockets.some(path => !isAbsolute(path) || Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)) {
    throw new Error('Operation control requires absolute Unix socket paths within the portable byte limit')
  }
  const authorityPaths = [...sockets, resolved.databasePath]
  if (new Set(authorityPaths).size !== authorityPaths.length ||
    ctx.isolatedExecution.reservedPaths.some(path => authorityPaths.includes(path))) {
    throw new Error('The operation authority needs distinct socket and database paths outside the execution backend paths')
  }
  const assistant = resolved.assistant === undefined ? undefined : {
    mainSessionId: sessionIdSchema.parse(resolved.assistant.mainSessionId),
    permissions: workPermissionsSchema.parse(resolved.assistant.permissions),
  }
  const permitted = broker === undefined || assistant === undefined ? undefined
    : broker.actions().filter(({ action }) => assistant.permissions.brokerActions.includes(action))
  const missing = assistant?.permissions.brokerActions.filter(action => !permitted?.some(provided => provided.action === action)) ?? []
  if (missing.length > 0) {
    throw new Error(`No configured broker provides permitted actions: ${missing.map(action => JSON.stringify(action)).join(', ')}. Add their routes or remove them from assistant.permissions.brokerActions.`)
  }
  let model: AuthorityOptions['model']
  if (resolved.model !== undefined) {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('The operation model grant needs the LLM runtime and the adapter for its provider')
    const { provider, model: id } = resolved.model
    await llm.resolveModelInfo(provider, id)
    model = {
      provider, id,
      run: (sessionId, request, signal) => observeModel(llm, sessionId, request, signal, MAX_MODEL_RESPONSE_BYTES),
    }
  }
  const workspaceNamespace = JSON.stringify([resolveDshHome(), resolved.principalId, resolved.scopeId])
  const evidence = new EvidenceClient({ socketPath: resolved.evidenceSocketPath, timeoutMs: resolved.evidenceTimeoutMs })
  const executor = ctx.isolatedExecution.open(workspaceNamespace)
  ctx.effect(() => () => executor.dispose(), 'operation-control.dispose-executor')
  const execution = await executor.ready
  const transfer = executor.transfer?.bind(executor)
  const data = assistant?.permissions.data
  if (transfer === undefined && (data?.import || data?.export)) {
    throw new Error('Workspace transfer permissions require an isolated execution provider with file transfers')
  }
  if (broker !== undefined && !execution.supportsBroker) {
    throw new Error('The operation broker requires an execution backend with a gateway socket and no CONNECT targets')
  }
  for (const { action } of resolved.unattendedBrokerActions) {
    if (broker === undefined || assistant?.permissions.brokerActions.includes(action) !== true) {
      throw new Error(`Unattended broker action "${action}" requires the broker and an entry in assistant.permissions.brokerActions`)
    }
  }
  if (resolved.unattendedShell && !execution.supportsBroker) {
    throw new Error('Unattended shell requires an execution backend with a gateway socket and no CONNECT targets')
  }
  if (execution.maxCommandBytes > 32_768 || execution.maxOutputBytes > 131_072) {
    throw new Error('Operation control requires maxCommandBytes at most 32768 and maxOutputBytes at most 131072')
  }
  // The witness record of this start. The event ID hashes this text, so every object keeps one key order.
  const configuration = {
    permissions: assistant === undefined ? null : {
      mainSessionId: assistant.mainSessionId, exec: assistant.permissions.exec, brokerActions: [...assistant.permissions.brokerActions],
      data: data === undefined ? null : {
        import: data.import, export: data.export, discloseToModel: data.discloseToModel, discloseToUser: data.discloseToUser,
        returnResponses: data.returnResponses === true,
      },
    },
    broker: broker === undefined ? null : {
      fingerprint: broker.fingerprint,
      actions: (permitted ?? []).map(({ action, credentialRef, returnsResponse }) => ({
        action, credentialRef, returnsResponse: returnsResponse === true,
      })),
    },
    unattendedShell: resolved.unattendedShell,
    unattendedBrokerActions: resolved.unattendedBrokerActions.map(({ action, match, allow }) => ({
      action, ...match === undefined ? {} : { match }, ...allow === undefined ? {} : { allow },
    })),
    model: resolved.model === undefined ? null : {
      provider: resolved.model.provider, model: resolved.model.model,
      credentialRef: resolved.model.credentialRef ?? null,
    },
    execution: execution.fingerprint,
    limits: { expiresAt: resolved.grantExpiresAt, maxOperations: resolved.maxOperations, maxFileBytes: resolved.maxFileBytes },
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([
    workspaceNamespace, resolved.evidenceSocketPath, approvalSocketPath ?? null, configuration,
  ])).digest('hex')
  const store = await OperationStore.open(resolved.databasePath, {
    principalId: workPrincipalIdSchema.parse(resolved.principalId),
    scopeId: resolved.scopeId,
    expiresAt: resolved.grantExpiresAt,
    maxOperations: resolved.maxOperations,
    maxFileBytes: resolved.maxFileBytes,
    fingerprint,
    configuration,
    ...assistant === undefined ? {} : { assistant },
  })
  const credentials = ctx.get('credentials')
  const modelKey = resolved.model?.credentialRef === undefined ? undefined
    : { route: { provider: resolved.model.provider, model: resolved.model.model }, ref: credentialRef(resolved.model.credentialRef) }
  const authority = new OperationAuthority(store, evidence, {
    socketPath: resolved.socketPath,
    ...approvalSocketPath === undefined ? {} : { approvalSocketPath },
    unattendedShell: resolved.unattendedShell,
    unattendedActions: resolved.unattendedBrokerActions,
    maxCommandBytes: execution.maxCommandBytes,
    requestTimeoutMs: resolved.requestTimeoutMs,
    ...model === undefined ? {} : { model },
    ...broker === undefined ? {} : { broker },
    ...permitted === undefined ? {} : {
      businessActions: permitted.map(({ action, description }) => ({ action, ...description === undefined ? {} : { description } })),
    },
    ...credentials === undefined || (permitted === undefined && modelKey === undefined) ? {} : {
      connections: {
        list: () => Promise.all((permitted ?? []).map(async ({ action, description, credentialRef, returnsResponse }) => ({
          action, ...description === undefined ? {} : { description }, credentialRef,
          configured: (await credentials.describe(credentialRef)).configured, returnsResponse: returnsResponse === true,
        }))),
        ...modelKey === undefined ? {} : {
          model: async () => ({
            ...modelKey.route, credentialRef: modelKey.ref, configured: (await credentials.describe(modelKey.ref)).configured,
          }),
        },
        credentialChange(update) {
          const ref = 'action' in update ? permitted?.find(candidate => candidate.action === update.action)?.credentialRef : modelKey?.ref
          if (ref === undefined) {
            throw new OperationControlError('broker-action-unavailable', 'The broker action or model key is not permitted.')
          }
          const { value } = update
          if (value === null) return () => credentials.unset(ref)
          if (!isBearerToken(value)) {
            throw new OperationControlError('broker-credential-invalid', 'The value is not a valid bearer token.')
          }
          return () => credentials.set(ref, value)
        },
      },
    },
    ...transfer === undefined ? {} : { transfer: { maxBytes: resolved.maxFileBytes, run: transfer } },
    run: (sessionId, command, signal, handler) => executor.run(sessionId, command, signal, handler),
    warn: (error) => { ctx.logger.warn(error) },
  })
  ctx.effect(() => () => authority.close(), 'operation-control.dispose-authority')
  await authority.listen()
}
