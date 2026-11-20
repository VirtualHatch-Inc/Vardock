import { createAssistantMessage, createDeveloperMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { chunks, decodeCompletion, HARNESS_TOOL_NAMESPACE, historyItems } from '../src/projection.ts'

const TOOL = 'assistant_report'
const NAMES = new Set([TOOL])
const CALL = {
  type: 'function_call', namespace: HARNESS_TOOL_NAMESPACE, name: TOOL, call_id: 'call_fixture', arguments: '{}',
}
const TEXT = {
  type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: '' }, { type: 'output_text', text: 'Ready.' }],
}
const USAGE = {
  inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 0,
  outputTokens: 4, totalTokens: 14, reasoningOutputTokens: 1,
}

describe('Codex request and completion projection', () => {
  it('separates response output from Codex-added input and retains ordered reasoning', () => {
    const completed = decodeCompletion([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Codex context' }] },
      { type: 'additional_tools', role: 'developer', tools: [] },
      { type: 'configuration_update' },
      { type: 'reasoning', summary: [], encrypted_content: null },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the result.' }], encrypted_content: null },
      TEXT,
      CALL,
    ], null, 'codex-model', NAMES)
    expect(completed.blocks).toEqual([
      { type: 'reasoning', text: 'Checked the result.' },
      { type: 'text', text: 'Ready.' },
      { type: 'tool-call', id: 'call_fixture', name: TOOL, arguments: '{}' },
    ])
    expect([...chunks(completed)].at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'tool-calls' },
      replayState: {
        response: { kind: 'codex-app-server', model: 'codex-model' },
        blocks: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the result.' }] }, null, null],
      },
    })
    const input: GenerateOptions = {
      provider: 'codex-local', model: 'default',
      messages: [
        createDeveloperMessage({
          source: { kind: 'user' }, content: [{ type: 'tool-removal', toolName: 'removed' }],
        }),
        createAssistantMessage({
          source: { provider: 'codex-local', model: 'default', replayState: completed.replayState },
          content: [...completed.blocks],
        }),
        createAssistantMessage({
          source: { provider: 'elsewhere', model: 'different' },
          content: [{ type: 'tool-removal', toolName: 'removed' }],
        }),
      ],
    }
    expect(historyItems(input, 'changed-model')).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready.' }] },
      CALL,
    ])
  })

  it.each<[string, readonly object[], unknown, string]>([
    ['empty answer', [], null, 'EMPTY_RESPONSE'],
    ['assistant without content', [{ type: 'message', role: 'assistant' }], null, 'CODEX_PROTOCOL'],
    ['non-text assistant content', [{ ...TEXT, content: [{ type: 'input_text', text: 'Ready.' }] }], null, 'CODEX_PROTOCOL'],
    ['non-string assistant text', [{ ...TEXT, content: [{ type: 'output_text', text: 42 }] }], null, 'CODEX_PROTOCOL'],
    ['malformed reasoning', [{ type: 'reasoning', summary: {} }], null, 'CODEX_PROTOCOL'],
    ['unknown reasoning summary part', [{ type: 'reasoning', summary: [{ type: 'other', text: 'text' }] }], null, 'CODEX_PROTOCOL'],
    ['malformed reasoning summary part', [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 42 }] }], null, 'CODEX_PROTOCOL'],
    ['Codex namespace collision', [{ ...CALL, namespace: 'native' }], null, 'CODEX_NATIVE_TOOL'],
    ['missing call ID', [{ ...CALL, call_id: '' }], null, 'CODEX_PROTOCOL'],
    ['non-string call ID', [{ ...CALL, call_id: 42 }], null, 'CODEX_PROTOCOL'],
    ['duplicate call ID', [CALL, CALL], null, 'CODEX_PROTOCOL'],
    ['non-string arguments', [{ ...CALL, arguments: {} }], null, 'CODEX_PROTOCOL'],
    ['native shell item', [{ type: 'local_shell_call' }], null, 'CODEX_PROTOCOL'],
    ['native code mode', [{ type: 'custom_tool_call', name: 'exec', input: 'ignored' }], null, 'CODEX_NATIVE_TOOL'],
    ['missing usage count', [TEXT], {}, 'CODEX_PROTOCOL'],
    ['fractional usage count', [TEXT], { ...USAGE, inputTokens: 0.5 }, 'CODEX_PROTOCOL'],
    ['negative usage count', [TEXT], { ...USAGE, inputTokens: -1 }, 'CODEX_PROTOCOL'],
    ['inconsistent cache counts', [TEXT], { ...USAGE, cachedInputTokens: 11 }, 'CODEX_PROTOCOL'],
  ])('does not publish %s', (_name, items, usage, code) => {
    expect(() => decodeCompletion(items, usage, 'codex-model', NAMES)).toThrow(expect.objectContaining({ code }))
  })
})
