import { rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage, createSystemMessage, createToolResultMessage,
  type GenerateOptions, type StreamChunk, type ToolCallBlock,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { completeWithCodex, type AppServerSpec } from '../src/app-server.ts'
import { HARNESS_TOOL_NAMESPACE } from '../src/projection.ts'
import * as plugin from '../src/index.ts'

const TOOL = {
  name: 'assistant_report', description: 'Report the worker result.',
  parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
}
const INPUT: GenerateOptions = {
  provider: 'codex-local',
  model: 'default',
  messages: [createSystemMessage('Work through the Harness.'), {
    role: 'user', content: [{ type: 'text', text: 'Report the result.' }],
  }],
  tools: [TOOL],
}

interface FixtureOptions {
  readonly deferExit?: boolean
  readonly configReply?: object
  readonly threadReply?: object
  readonly turnReply?: object
  readonly turnEvents?: readonly { method: string; params: object; id?: string }[]
  readonly omitUsage?: boolean
}

const TEXT = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }
const TURN = { threadId: 'thread-fixture', turnId: 'turn-fixture' }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function fixture(items: readonly object[] | undefined, options: FixtureOptions = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const ready = Promise.withResolvers<undefined>()
  const exited = Promise.withResolvers<true>()
  const childOutcome = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const spawns: SubprocessSpawnSpec[] = []
  const terminated = Promise.withResolvers<undefined>()
  const seen: Array<{ id?: string; method?: string; params?: object }> = []
  const lines = createInterface({ input: stdin })
  const send = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
  const notify = (method: string, params: object) => send({ method, params })
  lines.on('line', (line: string) => {
    const frame = JSON.parse(line) as (typeof seen)[number]
    seen.push(frame)
    const reply = (result: object) => send({ id: frame.id, result })
    switch (frame.method) {
      case 'initialize': reply({}); break
      case 'config/read': reply(options.configReply ?? { config: { mcp_servers: { external: { enabled: true } } } }); break
      case 'thread/start':
        reply(options.threadReply ?? { thread: { id: 'thread-fixture', ephemeral: true }, model: 'fixture-model' })
        break
      case 'thread/inject_items': reply({}); break
      case 'turn/start':
        notify('turn/started', { threadId: 'thread-fixture', turn: { id: 'turn-fixture' } })
        for (const event of options.turnEvents ?? []) send(event)
        if (items !== undefined) {
          for (const item of items) {
            notify('rawResponseItem/completed', { threadId: 'thread-fixture', turnId: 'turn-fixture', item })
            if ('name' in item && item.name === TOOL.name) {
              send({
                id: 'tool-request', method: 'item/tool/call',
                params: { tool: TOOL.name, namespace: HARNESS_TOOL_NAMESPACE },
              })
            }
          }
          notify('rawResponse/completed', {
            threadId: 'thread-fixture', turnId: 'turn-fixture',
            usage: options.omitUsage ? null : {
              totalTokens: 14, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 1,
              outputTokens: 4, reasoningOutputTokens: 2,
            },
          })
        }
        reply(options.turnReply ?? { turn: { id: 'turn-fixture' } })
        ready.resolve(undefined)
        break
    }
  })
  const handle: SubprocessHandle = {
    stdin, stdout, stderr: undefined, control: undefined, collected: {},
    done: childOutcome.promise,
    terminate() {
      terminated.resolve(undefined)
      if (!options.deferExit) {
        exited.resolve(true)
        childOutcome.resolve({ exitCode: 0, signal: null })
      }
    },
    waitForExit: () => exited.promise,
  }
  const spec: AppServerSpec = {
    command: 'codex-fixture', timeoutMs: 10_000, disposeGraceMs: 100,
    spawn: vi.fn((spec: SubprocessSpawnSpec) => {
      spawns.push(spec)
      return handle
    }),
  }
  return {
    spec, seen, handle, spawns, ready: ready.promise, terminated: terminated.promise,
    closeOutput() { stdout.end() },
    failSpawn() { childOutcome.reject(new Error('ENOENT')) },
    exit() { childOutcome.resolve({ exitCode: 1, signal: null }) },
    failWait() { exited.reject(new Error('process range unobservable')) },
    release() {
      exited.resolve(true)
      childOutcome.resolve({ exitCode: 0, signal: null })
      lines.close()
      stdin.destroy()
      stdout.destroy()
    },
  }
}

describe('local Codex response adapter', () => {
  it('returns native tool calls at response completion without answering Codex tool requests', async () => {
    const argumentsText = '{ "result": "ready" }'
    const native = [
      { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'ciphertext', summary: [] },
      {
        type: 'function_call', namespace: HARNESS_TOOL_NAMESPACE,
        name: TOOL.name, call_id: 'call_fixture', arguments: argumentsText,
      },
    ]
    const peer = fixture(native)
    try {
      const completion = await completeWithCodex(INPUT, peer.spec)
      expect(completion.blocks).toEqual([
        { type: 'reasoning', text: '' },
        { type: 'tool-call', id: 'call_fixture', name: TOOL.name, arguments: argumentsText },
      ])
      expect(completion.usage).toEqual({
        inputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, outputTokens: 4, totalTokens: 14, reasoningTokens: 2,
      })
      expect(peer.seen.find(frame => frame.method === 'thread/start')?.params).toMatchObject({
        ephemeral: true, environments: [], approvalPolicy: 'never', sandbox: 'read-only',
        baseInstructions: 'Work through the Harness.',
        config: { mcp_servers: { external: { enabled: false } } },
        dynamicTools: [{
          type: 'namespace', name: HARNESS_TOOL_NAMESPACE,
          description: 'Call tools in dsh_harness directly for all tool use. Choose this namespace when tools share a name.',
          tools: [{ type: 'function', name: TOOL.name, inputSchema: TOOL.parameters }],
        }],
      })
      expect(peer.seen.find(frame => frame.method === 'thread/start')?.params).not.toHaveProperty('model')
      expect(peer.seen.find(frame => frame.method === 'turn/start')?.params).toMatchObject({ input: [] })
      expect(peer.seen.some(frame => frame.id === 'tool-request')).toBe(false)

      const next = fixture([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }])
      try {
        const call = completion.blocks[1] as ToolCallBlock
        const followup = await completeWithCodex({
          ...INPUT,
          model: 'fixture-model',
          messages: [
            ...INPUT.messages,
            createAssistantMessage({
              content: completion.blocks,
              source: { provider: INPUT.provider, model: INPUT.model, replayState: completion.replayState },
            }),
            createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'accepted' }], isError: false }),
          ],
        }, next.spec)
        expect(followup.blocks).toEqual([{ type: 'text', text: 'Done.' }])
        expect(next.seen.find(frame => frame.method === 'thread/start')?.params).toHaveProperty('model', 'fixture-model')
        expect(next.seen.find(frame => frame.method === 'thread/inject_items')?.params).toMatchObject({
          items: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Report the result.' }] },
            ...native,
            { type: 'function_call_output', call_id: 'call_fixture', output: 'accepted' },
          ],
        })
      } finally {
        next.release()
      }
    } finally {
      peer.release()
    }
  })

  it('rejects tool calls outside the declared Harness schema before publishing output', async () => {
    const peer = fixture([{ type: 'function_call', name: 'exec_command', call_id: 'other', arguments: '{}' }])
    try {
      await expect(completeWithCodex(INPUT, peer.spec)).rejects.toMatchObject({ code: 'CODEX_NATIVE_TOOL' })
      await peer.terminated
    } finally {
      peer.release()
    }
  })

  it.each([true, false])('drains active work on unload (process stop verified: %s)', async (quiescent) => {
    const peer = fixture(undefined, { deferExit: true })
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(peer.spec.spawn)
      const fiber = await ctx.plugin(plugin)
      const request = ctx.llm.stream(INPUT)[Symbol.asyncIterator]().next()
      await peer.ready
      const done = vi.fn()
      const disposing = fiber.dispose().then(done)
      await peer.terminated
      expect(done).not.toHaveBeenCalled()
      if (quiescent) peer.release()
      else peer.failWait()
      await disposing
      await expect(request).resolves.toMatchObject({
        value: {
          type: 'finish',
          reason: quiescent
            ? { kind: 'aborted', failure: { code: 'ABORTED' } }
            : { kind: 'error', failure: { code: 'CODEX_TEARDOWN' } },
        },
      })
      expect(ctx.llm.listProviders()).not.toContainEqual(expect.objectContaining({ id: INPUT.provider }))
    } finally {
      peer.release()
      await ctx.fiber.dispose()
      const cwd = peer.spawns[0]?.cwd
      if (!quiescent && cwd !== undefined) await rm(cwd, { recursive: true, force: true })
    }
  })

  it('exposes a model, emits usage before finish, and refuses unsupported sampling controls', async () => {
    const peer = fixture([TEXT], { omitUsage: false })
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(peer.spec.spawn)
      await ctx.plugin(plugin, { command: '/fixture/codex', timeoutMs: 9000, disposeGraceMs: 25 })
      expect(await ctx.llm.listModels(INPUT.provider)).toEqual([
        { provider: INPUT.provider, id: INPUT.model, name: 'Codex default', inputModalities: ['text'] },
      ])
      expect(ctx.llm.providerRetryPolicy(INPUT.provider)).toMatchObject({ maxRetries: 0 })
      const signal = new AbortController().signal
      const result = await collect(ctx.llm.stream({ ...INPUT, model: 'fixture-model', signal }))
      expect(result.map(chunk => chunk.type)).toEqual(['block-start', 'block-end', 'usage', 'finish'])
      expect(result.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(peer.spawns[0]?.argv.slice(0, 3)).toEqual(['/fixture/codex', 'app-server', '--stdio'])
      expect(peer.spawns[0]?.graceMs).toBe(25)
      for (const controls of [{ maxTokens: 5 }, { stop: ['END'] }, { temperature: 0.4 }]) {
        await expect(collect(ctx.llm.stream({ ...INPUT, ...controls }))).resolves.toMatchObject([
          { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } } },
        ])
      }
      expect(peer.spawns).toHaveLength(1)
    } finally {
      peer.release()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['unauthorized', 'AUTH'], ['contextWindowExceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    ['usageLimitExceeded', 'QUOTA'], ['sessionBudgetExceeded', 'QUOTA'],
    ['serverOverloaded', 'SERVER_ERROR'], ['internalServerError', 'SERVER_ERROR'],
    ['badRequest', 'CODEX_PROTOCOL'],
  ])('maps Codex %s before a response to %s', async (codexErrorInfo, code) => {
    const peer = fixture(undefined, { turnEvents: [{
      method: 'turn/completed',
      params: { threadId: TURN.threadId, turn: { id: TURN.turnId, status: 'failed', error: { codexErrorInfo } } },
    }] })
    try {
      await expect(completeWithCodex(INPUT, peer.spec)).rejects.toMatchObject({ code })
    } finally {
      peer.release()
    }
  })

  it.each<[string, FixtureOptions, string]>([
    ['no config', { configReply: {} }, 'CODEX_PROTOCOL'],
    ['invalid MCP config', { configReply: { config: { mcp_servers: [] } } }, 'CODEX_PROTOCOL'],
    ['persistent thread', { threadReply: { thread: { id: TURN.threadId, ephemeral: false } } }, 'CODEX_PROTOCOL'],
    ['missing model', { threadReply: { thread: { id: TURN.threadId, ephemeral: true } } }, 'CODEX_PROTOCOL'],
    ['invalid thread ID', { threadReply: { thread: { id: '', ephemeral: true }, model: 'fixture-model' } }, 'CODEX_PROTOCOL'],
    ['inconsistent turn ID', { turnReply: { turn: { id: 'other-turn' } } }, 'CODEX_PROTOCOL'],
    ['compaction', { turnEvents: [{ method: 'thread/compacted', params: TURN }] }, 'CONTEXT_WINDOW_EXCEEDED'],
    ['native operation', { turnEvents: [{ method: 'item/started', params: { ...TURN, item: { type: 'commandExecution' } } }] }, 'CODEX_NATIVE_TOOL'],
    ['unadmitted callback', { turnEvents: [{
      id: 'cmd', method: 'item/tool/call', params: { ...TURN, tool: 'unknown', namespace: HARNESS_TOOL_NAMESPACE },
    }] }, 'CODEX_NATIVE_TOOL'],
    ['native namespace', { turnEvents: [{
      id: 'cmd', method: 'item/tool/call', params: { ...TURN, tool: TOOL.name, namespace: 'native' },
    }] }, 'CODEX_NATIVE_TOOL'],
    ['approval request', { turnEvents: [{ id: 'cmd', method: 'item/commandExecution/requestApproval', params: TURN }] }, 'CODEX_NATIVE_TOOL'],
    ['missing tool name', { turnEvents: [{
      id: 'cmd', method: 'item/tool/call', params: { ...TURN, namespace: HARNESS_TOOL_NAMESPACE },
    }] }, 'CODEX_NATIVE_TOOL'],
    ['missing raw response', { turnEvents: [{
      method: 'turn/completed', params: { threadId: TURN.threadId, turn: { id: TURN.turnId, status: 'completed' } },
    }] }, 'CODEX_PROTOCOL'],
  ])('fails closed for %s', async (_name, fixtureOptions, code) => {
    const peer = fixture(undefined, fixtureOptions)
    try {
      await expect(completeWithCodex(INPUT, peer.spec)).rejects.toMatchObject({ code })
      await peer.terminated
    } finally {
      peer.release()
    }
  })

  it('reports a native Code Mode call without publishing its input or a Harness tool call', async () => {
    const peer = fixture([
      { type: 'function_call', namespace: HARNESS_TOOL_NAMESPACE, name: TOOL.name, call_id: 'call_fixture', arguments: '{}' },
      { type: 'custom_tool_call', name: 'exec', input: 'private script' },
    ])
    try {
      await expect(completeWithCodex(INPUT, peer.spec)).rejects.toMatchObject({
        code: 'CODEX_NATIVE_TOOL',
        message: 'Harness blocked a Codex operation (custom_tool_call exec). Use the dsh_harness tools.',
      })
      await peer.terminated
      expect(peer.seen.some(frame => frame.id === 'tool-request')).toBe(false)
    } finally {
      peer.release()
    }
  })

  it('does not start a turn if Codex resolves a different explicit model', async () => {
    const peer = fixture([TEXT])
    try {
      await expect(completeWithCodex({ ...INPUT, model: 'required-model' }, peer.spec))
        .rejects.toMatchObject({ code: 'CODEX_MODEL_MISMATCH' })
      expect(peer.seen.map(frame => frame.method)).not.toContain('turn/start')
    } finally {
      peer.release()
    }
  })

  it.each<[string, (peer: ReturnType<typeof fixture>) => void]>([
    ['child exit', (peer) => { peer.exit() }],
    ['child startup rejection', (peer) => { peer.failSpawn() }],
    ['closed stdout', (peer) => { peer.closeOutput() }],
    ['pipe error', (peer) => { peer.handle.stdout?.emit('error', new Error('pipe')) }],
  ])('reclaims Codex after %s', async (failure, disrupt) => {
    const peer = fixture(undefined)
    try {
      const result = completeWithCodex(INPUT, peer.spec)
      const checked = expect(result).rejects.toMatchObject({
        code: failure === 'pipe error' ? 'CODEX_PROTOCOL' : 'CODEX_PROCESS',
      })
      await peer.ready
      disrupt(peer)
      await checked
      await peer.terminated
    } finally {
      peer.release()
    }
  })

  it('rejects a missing subprocess pipe and reclaims the child', async () => {
    const peer = fixture(undefined)
    try {
      await expect(completeWithCodex(INPUT, {
        ...peer.spec, spawn: spec => ({ ...peer.spec.spawn(spec), stdout: undefined }),
      })).rejects.toMatchObject({ code: 'CODEX_PROCESS' })
      await peer.terminated
    } finally {
      peer.release()
    }
  })

  it('reports startup failure without a process handle', async () => {
    await expect(completeWithCodex(INPUT, {
      command: 'missing', timeoutMs: 10_000, disposeGraceMs: 100,
      spawn() { throw new Error('no process handle') },
    })).rejects.toMatchObject({ code: 'CODEX_PROTOCOL' })
  })

  it('samples text without an MCP table or tool declarations', async () => {
    const peer = fixture([TEXT], { configReply: { config: {} } })
    const { tools: _tools, ...request } = INPUT
    try {
      await expect(completeWithCodex(request, peer.spec)).resolves.toMatchObject({
        blocks: [{ type: 'text', text: 'Done.' }],
      })
      expect(peer.seen.find(frame => frame.method === 'thread/start')?.params).toMatchObject({
        dynamicTools: [], config: { mcp_servers: {} },
      })
    } finally {
      peer.release()
    }
  })

  it('aborts an unresponsive turn on its configured deadline', async () => {
    const peer = fixture(undefined)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const result = completeWithCodex(INPUT, { ...peer.spec, timeoutMs: 500 })
      const checked = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })
      await peer.ready
      await vi.advanceTimersByTimeAsync(500)
      await checked
      await peer.terminated
    } finally {
      vi.useRealTimers()
      peer.release()
    }
  })

  it('does not publish a response when subprocess quiescence cannot be confirmed', async () => {
    const peer = fixture([TEXT], { deferExit: true })
    try {
      const result = completeWithCodex(INPUT, peer.spec)
      const checked = expect(result).rejects.toMatchObject({ code: 'CODEX_TEARDOWN' })
      await peer.terminated
      peer.failWait()
      await checked
    } finally {
      peer.release()
      const cwd = peer.spawns[0]?.cwd
      if (cwd !== undefined) await rm(cwd, { recursive: true, force: true })
    }
  })
})
