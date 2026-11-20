import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import { startResponsesFixture } from '../../../subagent/subagent-codex/tests/responses-fixture.ts'
import { completeWithCodex, type AppServerSpec } from '../src/app-server.ts'
import { HARNESS_TOOL_NAMESPACE } from '../src/projection.ts'

const codexAvailable = process.platform !== 'win32'
  && spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0

it.skipIf(!codexAvailable)('uses the installed Codex with only the Harness tool and replays its result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-real-'))
  const ctx = new Context()
  try {
    const codexHome = join(root, 'codex')
    const marker = join(root, 'mcp-started')
    await mkdir(codexHome)
    await ctx.plugin(LocalSubprocessRuntime)
    const fixture = await startResponsesFixture([
      { kind: 'functionCall', name: 'assistant_report', namespace: HARNESS_TOOL_NAMESPACE, arguments: { result: 'ok' } },
      { kind: 'complete', text: 'Worker reported.' },
    ])
    try {
      await writeFile(join(codexHome, 'config.toml'), [
        'model = "fixture-model"',
        'model_provider = "fixture"',
        'check_for_update_on_startup = false',
        '[model_providers.fixture]',
        'name = "Fixture"',
        `base_url = "${fixture.baseUrl}"`,
        'env_key = "DSH_CODEX_TEST_KEY"',
        'wire_api = "responses"',
        '[analytics]',
        'enabled = false',
        '[mcp_servers.fixture]',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = ${JSON.stringify(['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`])}`,
      ].join('\n'))
      const spec: AppServerSpec = {
        command: 'codex', timeoutMs: 10_000, disposeGraceMs: 100,
        spawn: request => ctx.subprocess.spawn({
          ...request,
          env: {
            CODEX_HOME: codexHome,
            DSH_CODEX_TEST_KEY: 'fixture-only',
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
          },
        }),
      }
      const initial: GenerateOptions = {
        provider: 'codex-local',
        model: 'default',
        messages: [createSystemMessage('Use the Harness worker tool.'), {
          role: 'user', content: [{ type: 'text', text: 'Report a result.' }],
        }],
        tools: [{
          name: 'assistant_report', description: 'Report the worker result.',
          parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
        }],
      }
      const first = await completeWithCodex(initial, spec)
      const call = first.blocks.find(block => block.type === 'tool-call')
      expect(call).toEqual({ type: 'tool-call', id: 'call_fixture', name: 'assistant_report', arguments: '{"result":"ok"}' })
      if (call === undefined) throw new Error('fixture returned no tool call')
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.requests[0]?.body.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'namespace', name: HARNESS_TOOL_NAMESPACE,
          description: 'Call tools in dsh_harness directly for all tool use. Choose this namespace when tools share a name.',
          tools: [expect.objectContaining({ name: 'assistant_report' })],
        }),
      ]))
      for (const name of ['exec_command', 'apply_patch', 'read_mcp_resource']) {
        expect(fixture.requests[0]?.body.tools).not.toContainEqual(expect.objectContaining({ name }))
      }
      const second = await completeWithCodex({
        ...initial,
        messages: [...initial.messages,
          createAssistantMessage({ content: first.blocks, source: { provider: initial.provider, model: initial.model } }),
          createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'accepted' }], isError: false }),
        ],
      }, spec)
      expect(second.blocks).toEqual([{ type: 'text', text: 'Worker reported.' }])
      expect(fixture.requests).toHaveLength(2)
      expect(fixture.requests[1]?.body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', namespace: HARNESS_TOOL_NAMESPACE, call_id: 'call_fixture' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture', output: 'accepted' }),
      ]))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.close()
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
