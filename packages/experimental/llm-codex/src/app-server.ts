/** Own one local Codex process and stop it after the first upstream response. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  baseInstructions, blockedCodexOperation, decodeCompletion, HARNESS_TOOL_NAMESPACE, historyItems, object,
  type Completion, type JsonObject,
} from './projection.ts'

const DISABLED_FEATURES = [
  'apps', 'browser_use', 'code_mode_host', 'code_mode_only', 'computer_use', 'goals', 'hooks', 'image_generation',
  'memories', 'multi_agent', 'multi_agent_v2', 'plugins', 'shell_tool', 'skill_search',
  'sleep_tool', 'tool_suggest', 'unified_exec', 'view_image',
] as const

const APP_SERVER_ARGS = [
  'app-server', '--stdio',
  ...DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
  '-c', 'web_search="disabled"',
  '-c', 'project_doc_max_bytes=0',
  '-c', 'skills.include_instructions=false',
  '-c', 'model_post_turn_compact_threshold_percent=0',
  // Model catalogs can require Code Mode. Direct-only tools stay out of its
  // native exec wrapper, and disabling the host prevents wrapper execution.
  '-c', `features.code_mode={enabled=false,direct_only_tool_namespaces=[${JSON.stringify(HARNESS_TOOL_NAMESPACE)}]}`,
  '-c', 'features.code_mode_only_strict_3p_tools=false',
]

/** Resolved process settings for one model adapter instance. */
export interface AppServerSpec {
  readonly command: string
  readonly timeoutMs: number
  readonly disposeGraceMs: number
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

function failedTurn(turn: JsonObject | undefined): LlmError {
  const info = object(turn?.error)?.codexErrorInfo
  switch (info) {
    case 'unauthorized':
      return new LlmError('Codex is not authorized. Run codex login and try again.', 'AUTH')
    case 'contextWindowExceeded':
      return new LlmError('The request exceeds the Codex model context window.', CONTEXT_WINDOW_EXCEEDED_CODE)
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
      return new LlmError('The Codex account or session has reached its usage limit.', QUOTA_EXCEEDED_CODE)
    case 'serverOverloaded':
    case 'internalServerError':
      return LlmError.fromFailure({ message: 'The Codex model service is temporarily unavailable.', code: 'SERVER_ERROR' })
    default:
      return LlmError.fromFailure({
        message: turn?.status === 'completed'
          ? 'Codex completed the turn without a raw response. Check the installed Codex version.'
          : 'Codex did not complete the model response. Check codex login status and try again.',
        code: 'CODEX_PROTOCOL',
      })
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw LlmError.fromFailure({ message: `Codex app-server did not provide ${field}.`, code: 'CODEX_PROTOCOL' })
  }
  return value
}

async function requestResponse(
  transport: JsonRpcLineTransport,
  options: GenerateOptions,
  cwd: string,
  signal: AbortSignal,
  fail: (error: unknown) => void,
  untilClosed: Promise<void>,
): Promise<Completion> {
  await transport.request('initialize', {
    clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }, signal)
  transport.notify('initialized')

  const effective = object(await transport.request('config/read', { cwd }, signal))
  const config = object(effective?.config)
  if (config === undefined) {
    throw LlmError.fromFailure({ message: 'Codex did not report its effective configuration.', code: 'CODEX_PROTOCOL' })
  }
  const servers = config.mcp_servers == null ? {} : object(config.mcp_servers)
  if (servers === undefined) {
    throw LlmError.fromFailure({ message: 'Codex did not report its MCP servers as a configuration table.', code: 'CODEX_PROTOCOL' })
  }
  const mcpServers = Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }]))
  const tools = options.tools ?? []
  const toolNames = new Set(tools.map(tool => tool.name))
  transport.onRequest(async (method, params) => {
    if (method !== 'item/tool/call' || params.namespace !== HARNESS_TOOL_NAMESPACE
      || typeof params.tool !== 'string' || !toolNames.has(params.tool)) {
      fail(blockedCodexOperation(method, params.tool, params.namespace))
    }
    // Responding would let Codex run another sample. The child is stopped at
    // rawResponse/completed and the Harness loop alone executes these calls.
    await untilClosed
  })
  const started = object(await transport.request('thread/start', {
    cwd,
    ephemeral: true,
    ...options.model === 'default' ? {} : { model: options.model },
    baseInstructions: baseInstructions(options),
    developerInstructions: '',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    environments: [],
    config: { mcp_servers: mcpServers },
    dynamicTools: tools.length === 0 ? [] : [{
      type: 'namespace', name: HARNESS_TOOL_NAMESPACE,
      description: `Call tools in ${HARNESS_TOOL_NAMESPACE} directly for all tool use. Choose this namespace when tools share a name.`,
      tools: tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters,
      })),
    }],
    experimentalRawEvents: true,
  }, signal))
  const thread = object(started?.thread)
  if (thread?.ephemeral !== true) {
    throw LlmError.fromFailure({ message: 'Codex did not create a private ephemeral thread.', code: 'CODEX_PROTOCOL' })
  }
  const threadId = requireText(thread.id, 'a thread ID')
  const model = requireText(started?.model, 'the selected model')
  if (options.model !== 'default' && model !== options.model) {
    throw LlmError.fromFailure({ message: 'Codex selected a model different from the requested model ID.', code: 'CODEX_MODEL_MISMATCH' })
  }
  const history = historyItems(options, model)
  if (history.length > 0) {
    await transport.request('thread/inject_items', { threadId, items: history }, signal)
  }

  let turnId: string | undefined
  let complete = false
  const items: unknown[] = []
  const response = Promise.withResolvers<Completion>()
  // A fast response can settle while turn/start's reply is still in flight.
  void response.promise.catch(() => {})
  const abort = (): void => { response.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  transport.onNotification((method, params) => {
    if (complete || params.threadId !== threadId) return
    try {
      if (method === 'turn/started') {
        turnId = requireText(object(params.turn)?.id, 'a turn ID')
      } else if (method === 'turn/completed' && object(params.turn)?.id === turnId) {
        throw failedTurn(object(params.turn))
      } else if (method === 'thread/compacted') {
        throw new LlmError('Codex compacted the request outside the Harness Session history.', CONTEXT_WINDOW_EXCEEDED_CODE)
      } else if (turnId !== undefined && params.turnId === turnId) {
        if (method === 'rawResponseItem/completed') items.push(params.item)
        if (method === 'rawResponse/completed') {
          const completion = decodeCompletion(items, params.usage, model, toolNames)
          complete = true
          response.resolve(completion)
        }
        if (method === 'item/started') {
          const type = object(params.item)?.type
          if (type !== 'userMessage' && type !== 'agentMessage' && type !== 'reasoning' && type !== 'dynamicToolCall') {
            throw blockedCodexOperation(type)
          }
        }
      }
    } catch (error: unknown) {
      fail(error)
    }
  })
  try {
    const running = object(await transport.request('turn/start', {
      threadId, input: [],
    }, signal))
    const runningId = requireText(object(running?.turn)?.id, 'a turn ID')
    if (turnId !== undefined && turnId !== runningId) {
      throw LlmError.fromFailure({ message: 'Codex returned inconsistent turn IDs.', code: 'CODEX_PROTOCOL' })
    }
    turnId = runningId
    signal.throwIfAborted()
    return await response.promise
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Sample a request with local Codex authentication, then await child quiescence.
 * @param options - projected Harness model request.
 * @param spec - command, cancellation budget and managed subprocess owner.
 * @returns one response; protocol errors and cancellation publish no tool calls.
 */
export async function completeWithCodex(options: GenerateOptions, spec: AppServerSpec): Promise<Completion> {
  const broken = new AbortController()
  const upstream = options.signal === undefined
    ? broken.signal
    : AbortSignal.any([options.signal, broken.signal])
  using budget = deadline(upstream, spec.timeoutMs, 'CODEX_TIMEOUT')
  const { signal } = budget
  signal.throwIfAborted()
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
  const closed = Promise.withResolvers<undefined>()
  let child: SubprocessHandle | undefined
  let transport: JsonRpcLineTransport | undefined
  try {
    signal.throwIfAborted()
    child = spec.spawn({
      argv: [spec.command, ...APP_SERVER_ARGS],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
      graceMs: spec.disposeGraceMs,
      signal,
    })
    const fail = (error: unknown): void => { broken.abort(error) }
    void child.done.then(
      () => { fail(LlmError.fromFailure({ message: 'Codex exited before completing the model response.', code: 'CODEX_PROCESS' })) },
      () => { fail(LlmError.fromFailure({ message: 'Could not run the configured Codex command. Check that it is installed.', code: 'CODEX_PROCESS' })) },
    )
    if (child.stdin === undefined || child.stdout === undefined) {
      throw LlmError.fromFailure({ message: 'Codex did not provide both JSON-RPC pipes.', code: 'CODEX_PROCESS' })
    }
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stdout.on('end', () => { fail(LlmError.fromFailure({ message: 'Codex closed its response stream.', code: 'CODEX_PROCESS' })) })
    transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.start()
    return await requestResponse(transport, options, cwd, signal, fail, closed.promise)
  } catch (error: unknown) {
    options.signal?.throwIfAborted()
    if (timeoutOf(signal, 'CODEX_TIMEOUT') !== undefined) {
      throw new LlmError('Codex did not finish within the configured time limit.', 'TIMEOUT')
    }
    if (error instanceof LlmError) throw error
    throw LlmError.fromFailure({ message: 'Could not complete the Codex request. Check the installed Codex version and login status.', code: 'CODEX_PROTOCOL' })
  } finally {
    transport?.close()
    closed.resolve(undefined)
    if (child !== undefined) {
      child.terminate()
      try {
        await child.waitForExit()
      } catch (cause: unknown) {
        throw LlmError.fromFailure(
          { message: 'Could not verify that Codex stopped. Check the Codex process before retrying.', code: 'CODEX_TEARDOWN' },
          { cause },
        )
      }
      await child.done.catch(() => {
        // A spawn rejection has already been reported by the request owner.
      })
    }
    await rm(cwd, { recursive: true, force: true })
  }
}
