/** Loader fixture with real Session, checkpoint, and storage plugins. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import LocalAttachment from '@deepseek-ai/dsh-attachment-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Commands from '@deepseek-ai/dsh-commands'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { HandoffControl, OperationControlError, WorkPrincipalId, type OperationId } from '@deepseek-ai/dsh-operation-control/handoff'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import * as Checkpoints from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Approval from '@deepseek-ai/dsh-user-approval'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { vi, type TestContext } from 'vitest'
import AssistantRuntime from '../src/index.ts'

/** Supply the deployment's sandbox mode without spawning OS processes. */
class TestShell extends ShellExecutor {
  override get sandboxMode(): 'workspace-write' { return 'workspace-write' }
  override resolve(): never { throw new Error('unexpected shell command') }
  override execute(): never { throw new Error('unexpected shell command') }
}

interface ToolCall {
  name: string
  args: Record<string, unknown>
}

/** An observed provider request held until the test answers it or the loop cancels it. */
class Request {
  readonly reply = Promise.withResolvers<StreamChunk[]>()
  constructor(readonly options: GenerateOptions) {}

  text(text: string): void {
    this.reply.resolve([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }

  tools(...calls: ToolCall[]): void {
    const chunks = calls.flatMap(({ name, args }, index): StreamChunk[] => {
      const id = ToolCallId(`call-${this.options.messages.length}-${index}`)
      const json = JSON.stringify(args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name, argumentsDelta: json },
        { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } },
      ]
    })
    this.reply.resolve([...chunks, { type: 'finish', reason: { kind: 'tool-calls' } }])
  }
}

class ControlledModel extends LlmAdapter {
  readonly observed: Request[] = []
  private readonly pending: Request[] = []
  private changed = Promise.withResolvers<undefined>()

  async next(id: SessionId): Promise<Request> {
    for (;;) {
      const index = this.pending.findIndex(request => request.options.sessionId === id)
      if (index >= 0) return this.pending.splice(index, 1)[0]!
      await this.changed.promise
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request = new Request(options)
    const signal = options.signal
    signal?.throwIfAborted()
    this.observed.push(request)
    this.pending.push(request)
    this.changed.resolve(undefined)
    this.changed = Promise.withResolvers<undefined>()
    const abort = (): void => { request.reply.reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      yield* await request.reply.promise
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
}

/** Allocate one private Host data directory; boot twice over it to exercise recovery. */
export async function hostFixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-'))
  const contexts = new Set<Context>()
  const operationId = brandString<OperationId>('03820331-87b0-45d7-aa23-86a80cd36c97')
  const handoff = vi.fn<HandoffControl['release']>(async (request, signal) => {
    signal?.throwIfAborted()
    const release = { operationId, receipt: { id: `${operationId}-outcome`, digest: 'a'.repeat(64) } }
    if (request.kind === 'delivery') return release
    const { workId, previousWorkId, permissions, inputs } = request.delegation
    return { ...release, work: {
      workId, previousWorkId, sessionId: request.targetSessionId, principalId: WorkPrincipalId('fixture-owner'),
      permissions: permissions ?? { exec: true, brokerActions: [] },
      ...(inputs === undefined ? {} : { inputs }),
    } }
  })
  const transferFile = vi.fn<HandoffControl['transferFile']>(async () => {
    throw new OperationControlError('file-unavailable', 'Fixture has no work file transfer.')
  })
  const readExportedFile = vi.fn<HandoffControl['readExportedFile']>(async () => {
    throw new OperationControlError('artifact-unavailable', 'Fixture has no exported artifact.')
  })
  const overview = vi.fn<HandoffControl['overview']>(async (sessionId, signal, workId) => {
    signal?.throwIfAborted()
    return {
      sessionId, ...(workId === undefined ? {} : { workId }), principalId: WorkPrincipalId('fixture-owner'),
      scopeId: 'fixture-scope', expiresAt: 1, expired: true, maxOperations: 4, reserved: 7, remaining: 0,
      pendingApprovals: 0, running: 0, unknown: 0,
      businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 }, disclosesImportedData: true,
    }
  })
  const businessOperations = vi.fn<HandoffControl['businessOperations']>(async sessionId => ({ sessionId, operations: [] }))
  const reconcile = vi.fn<HandoffControl['reconcile']>(async () => {
    throw new OperationControlError('grant-expired', 'The operation grant expired.', operationId)
  })
  const configuration = { id: `configuration-${'c'.repeat(64)}`, digest: 'd'.repeat(64) }
  const grantSettings = vi.fn<HandoffControl['grantSettings']>(async () => ({
    principalId: WorkPrincipalId('fixture-owner'), scopeId: 'fixture-scope', revision: 'a'.repeat(64), configuration,
    expiresAt: 1, expired: true, maxOperations: 4, reserved: 7, remaining: 0,
  }))
  const updateGrant = vi.fn<HandoffControl['updateGrant']>(async update => ({
    principalId: WorkPrincipalId('fixture-owner'), scopeId: 'fixture-scope', revision: 'b'.repeat(64), configuration,
    expiresAt: update.expiresAt, expired: Date.now() >= update.expiresAt, maxOperations: update.maxOperations,
    reserved: 7, remaining: Math.max(0, update.maxOperations - 7),
  }))
  const connection = {
    action: 'post-message', description: 'Post one message.', credentialRef: 'MESSAGE_TOKEN', returnsResponse: false, unattended: [],
    routeChangedSinceRulesSaved: false,
  }
  const brokerConnections = vi.fn<HandoffControl['brokerConnections']>(async () => ({
    unattendedShell: false, revision: 'a'.repeat(64), connections: [{ ...connection, configured: false }],
  }))
  const setBrokerConnection = vi.fn<HandoffControl['setBrokerConnection']>(async () => ({
    unattendedShell: false, revision: 'a'.repeat(64), connections: [{ ...connection, configured: true }],
  }))
  const resolveBusiness = vi.fn<HandoffControl['resolveBusiness']>(async () => {
    throw new OperationControlError('authority-unavailable', 'Fixture has no owner determination.')
  })
  const businessRecords = vi.fn<HandoffControl['businessRecords']>(async () => ({ records: [] }))
  class TestHandoff extends HandoffControl {
    override release = handoff
    override transferFile = transferFile
    override readExportedFile = readExportedFile
    override overview = overview
    override businessOperations = businessOperations
    override reconcile = reconcile
    override grantSettings = grantSettings
    override updateGrant = updateGrant
    override brokerConnections = brokerConnections
    override setBrokerConnection = setBrokerConnection
    override businessRecords = businessRecords
    override resolveBusiness = resolveBusiness
  }
  test.onTestFinished(async () => {
    try {
      for (const ctx of contexts) await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  async function boot(
    maxActive = 2,
    mainSessionId = 'assistant-test',
    prepare?: (ctx: Context) => Promise<void> | void,
    workStatusConcurrency?: number,
  ) {
    const ctx = new Context()
    contexts.add(ctx)
    const model = new ControlledModel()
    const entries = [
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', Projections],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' }],
      ['@deepseek-ai/dsh-session-checkpoint-policy', Checkpoints],
      ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ['@deepseek-ai/dsh-storage', Storage],
      ['@deepseek-ai/dsh-storage-json', JsonStorage, { root: join(root, 'storage') }],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain, { backend: 'json' }],
      ['@deepseek-ai/dsh-session-title', SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 256 }],
      ['@deepseek-ai/dsh-user-approval', Approval, { policy: 'ask' }],
      ['test-shell', TestShell],
      ['@deepseek-ai/dsh-permission-presets', PermissionPresets],
      ['@deepseek-ai/dsh-agent-default-model', DefaultModel, { provider: 'mock', model: 'mock' }],
      ['@deepseek-ai/dsh-credentials-local', LocalCredentials, { dshHome: root }],
      ['@deepseek-ai/dsh-attachment-local', LocalAttachment, { dshHome: root }],
      ['@deepseek-ai/dsh-commands', Commands],
      ['@deepseek-ai/dsh-client-connection', Connection],
      ['@deepseek-ai/dsh-client-file-upload', FileUploads],
      ['@deepseek-ai/dsh-fs-local', LocalFs],
      ['@deepseek-ai/dsh-typert-registry', Typert],
      ['@deepseek-ai/dsh-api-remote-access', RemoteAccess],
      ['@deepseek-ai/dsh-api-gateway', Gateway],
      ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
      ['@deepseek-ai/dsh-session-query-sqlite', SessionQuery, { path: ':memory:', openAt: 'never' }],
      ['@deepseek-ai/dsh-api-session-controller', SessionController],
      ['test-handoff', TestHandoff],
      ['test-adapter', { inject: ['llm'], apply(ctx: Context) {
        ctx.llm.registerAdapter(['mock'], model)
      } }],
      ['test-execution-tool', { inject: ['tools'], apply(ctx: Context) {
        ctx.tools.register(defineTool({
          name: 'exec',
          description: 'Execute a command in the isolated worker.',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
          async execute() { return 'Isolated execution completed.' },
        }))
      } }],
    ] as const
    const assistant = {
      name: 'cordis:@deepseek-ai/dsh-assistant',
      config: { mainSessionId, maxActive, workStatusConcurrency },
    }
    const configPath = join(root, 'cordis.yml')
    const rows = entries.map(([name, _module, config]) => ({ name: `cordis:${name}`, config }))
    await writeFile(configPath, JSON.stringify(prepare === undefined ? [...rows, assistant] : rows))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['@deepseek-ai/dsh-assistant'] = AssistantRuntime
    for (const [name, module] of entries) ctx.loader.builtins[name] = module
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    try {
      await ctx.loader.await()
      if (prepare !== undefined) {
        await prepare(ctx)
        const entry = ctx.loader.resolve(await ctx.loader.create(assistant))
        await entry?.fiber?.await()
      }
      for (const entry of ctx.loader.entries()) {
        if (entry.fiber === undefined) throw new Error(`Loader did not import ${entry.options.name}`)
        await entry.fiber.await()
      }
    } catch (error: unknown) {
      await ctx.fiber.dispose()
      contexts.delete(ctx)
      throw error
    }
    const main = ctx.agents.get(ctx.assistant.mainSessionId)
    if (main === undefined) throw new Error('assistant entrance did not start')
    return { ctx, main, model, async close() {
      await ctx.fiber.dispose()
      contexts.delete(ctx)
    } }
  }
  return {
    boot, handoff, transferFile, readExportedFile, overview, businessOperations, reconcile, operationId,
    grantSettings, updateGrant, brokerConnections, setBrokerConnection, businessRecords, resolveBusiness,
  }
}

/** Read validated events from disk rather than the attached Session. */
export async function stored(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}
