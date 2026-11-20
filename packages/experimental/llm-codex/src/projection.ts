/** Project Harness history and one Codex Responses completion. */

import { brandString } from '@deepseek-ai/dsh-brand'
import {
  EMPTY_RESPONSE_CODE,
  LlmError,
  type ContentBlock,
  type GenerateOptions,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'

/** A JSON object at the app-server process or Session replay boundary. */
export type JsonObject = Record<string, unknown>

/** Native namespace for Harness tools exposed directly to the Codex model. */
export const HARNESS_TOOL_NAMESPACE = 'dsh_harness'

/**
 * Narrow a JSON value to an object.
 * @param value - value read from JSON.
 * @returns the object, or undefined for arrays and scalars.
 */
export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function protocol(message: string): LlmError {
  return LlmError.fromFailure({ message: `Codex app-server returned ${message}.`, code: 'CODEX_PROTOCOL' })
}

/**
 * Identify a rejected operation by its protocol identifiers, omitting payloads.
 * @param type - response item type or app-server method.
 * @param name - tool identifier, when present.
 * @param namespace - tool namespace, when present.
 * @returns a failure that instructs the caller to use Harness tools.
 */
export function blockedCodexOperation(type: unknown, name?: unknown, namespace?: unknown): LlmError {
  const operation = [type, namespace, name]
    .filter(value => typeof value === 'string' && /^[a-z][a-z0-9_./-]{0,79}$/iu.test(value))
    .join(' ')
  return LlmError.fromFailure({
    message: `Harness blocked a Codex operation${operation === '' ? '' : ` (${operation})`}. Use the ${HARNESS_TOOL_NAMESPACE} tools.`,
    code: 'CODEX_NATIVE_TOOL',
  })
}

function inputText(content: readonly ContentBlock[]): Array<{ type: 'input_text'; text: string }> {
  return content.flatMap(block => block.type === 'text' ? [{ type: 'input_text', text: block.text }] : [])
}

/**
 * Resolve the adapter's effective base instructions.
 * @param options - projected Harness model request.
 * @returns the concatenated one-shot and system instructions; empty clears the Codex base prompt.
 */
export function baseInstructions(options: GenerateOptions): string {
  return [
    options.system ?? '',
    ...options.messages.flatMap(message => message.role === 'system'
      ? inputText(message.content).map(part => part.text)
      : []),
  ].filter(Boolean).join('\n\n')
}

type ReasoningItem = {
  type: 'reasoning'
  id?: string
  summary: Array<{ type: 'summary_text'; text: string }>
  encrypted_content: string | null
}

function reasoningItem(value: unknown): ReasoningItem | undefined {
  const item = object(value)
  if (item?.type !== 'reasoning' || !Array.isArray(item.summary)) return undefined
  const summary: ReasoningItem['summary'] = []
  for (const value of item.summary as unknown[]) {
    const part = object(value)
    if (part?.type !== 'summary_text' || typeof part.text !== 'string') return undefined
    summary.push({ type: part.type, text: part.text })
  }
  return {
    type: 'reasoning',
    ...typeof item.id === 'string' ? { id: item.id } : {},
    summary,
    encrypted_content: typeof item.encrypted_content === 'string' ? item.encrypted_content : null,
  }
}

/**
 * Replay ordered roles, tool call arguments and results in a new ephemeral thread.
 * @param options - projected Harness model request.
 * @param model - concrete model resolved by Codex for the new thread.
 * @returns Responses API input items suitable for thread/inject_items.
 */
export function historyItems(options: GenerateOptions, model: string): JsonObject[] {
  return options.messages.flatMap((message): JsonObject[] => {
    switch (message.role) {
      case 'system':
        return []
      case 'user':
      case 'developer': {
        const content = inputText(message.content)
        return content.length === 0 ? [] : [{ type: 'message', role: message.role, content }]
      }
      case 'assistant': {
        const replay = object(message.source.replayState)
        const response = object(replay?.response)
        const blocks: readonly unknown[] = response?.kind === 'codex-app-server'
          && response.model === model && Array.isArray(replay?.blocks)
          && replay.blocks.length === message.content.length
          ? replay.blocks
          : []
        return message.content.flatMap((block, index): JsonObject[] => {
          switch (block.type) {
            case 'text':
              return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] }]
            case 'tool-call':
              return [{
                type: 'function_call', namespace: HARNESS_TOOL_NAMESPACE,
                name: block.name, arguments: block.arguments, call_id: block.id,
              }]
            case 'reasoning': {
              const item = reasoningItem(blocks[index])
              return item === undefined ? [] : [item]
            }
            default:
              // Provider-neutral replay uses only text and function calls.
              return []
          }
        })
      }
      case 'tool':
        return [{
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: inputText(message.content).map(part => part.text).join('\n'),
        }]
    }
  })
}

/** The data admitted from one completed upstream response. */
export interface Completion {
  readonly blocks: readonly ContentBlock[]
  readonly usage?: TokenUsage
  readonly replayState?: ReplayEnvelope
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw protocol('invalid token usage')
  }
  return value
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  if (value === null || value === undefined) return undefined
  const usage = object(value)
  const cacheReadTokens = counter(usage?.cachedInputTokens)
  const cacheWriteTokens = counter(usage?.cacheWriteInputTokens)
  const inputTokens = counter(usage?.inputTokens) - cacheReadTokens - cacheWriteTokens
  if (inputTokens < 0) throw protocol('inconsistent input token usage')
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: counter(usage?.outputTokens),
    totalTokens: counter(usage?.totalTokens),
    reasoningTokens: counter(usage?.reasoningOutputTokens),
  }
}

/**
 * Validate output before Harness can act on any tool call from it.
 * @param items - raw items recorded for the active turn before response completion.
 * @param usage - Codex's upstream response counters, when supplied.
 * @param model - concrete Codex model for replay compatibility.
 * @param toolNames - Harness tools declared for this request.
 * @returns complete, ordered Harness blocks and optional native reasoning.
 * @throws {LlmError} if Codex requests a tool outside the declared namespace and tool list.
 */
export function decodeCompletion(
  items: readonly unknown[],
  usage: unknown,
  model: string,
  toolNames: ReadonlySet<string>,
): Completion {
  const blocks: ContentBlock[] = []
  const native: Array<JsonObject | null> = []
  const calls = new Set<string>()
  for (const raw of items) {
    const item = object(raw)
    switch (item?.type) {
      case 'message': {
        // The raw event stream includes Codex-generated developer/user input.
        if (item.role !== 'assistant') break
        if (!Array.isArray(item.content)) throw protocol('an invalid assistant message')
        for (const value of item.content as unknown[]) {
          const part = object(value)
          if (part?.type !== 'output_text' || typeof part.text !== 'string') {
            throw protocol('unsupported assistant content')
          }
          if (part.text.length === 0) continue
          blocks.push({ type: 'text', text: part.text })
          native.push(null)
        }
        break
      }
      case 'reasoning': {
        const reasoning = reasoningItem(item)
        if (reasoning === undefined) throw protocol('an invalid reasoning item')
        const text = reasoning.summary.map(part => part.text).join('\n')
        if (text.length === 0 && reasoning.encrypted_content === null) break
        blocks.push({ type: 'reasoning', text })
        native.push(reasoning)
        break
      }
      case 'function_call': {
        const { name, namespace, call_id: id, arguments: args } = item
        if (typeof name !== 'string' || !toolNames.has(name) || namespace !== HARNESS_TOOL_NAMESPACE) {
          throw blockedCodexOperation(item.type, name, namespace)
        }
        if (typeof id !== 'string' || id.length === 0 || calls.has(id) || typeof args !== 'string') {
          throw protocol('an invalid Harness tool call')
        }
        calls.add(id)
        blocks.push({ type: 'tool-call', id: brandString<ToolCallId>(id), name, arguments: args })
        native.push(null)
        break
      }
      case 'custom_tool_call':
        throw blockedCodexOperation(item.type, item.name, item.namespace)
      case 'additional_tools':
      case 'configuration_update':
        break
      default:
        throw protocol('an unsupported raw response item')
    }
  }
  if (!blocks.some(block => block.type === 'text' || block.type === 'tool-call')) {
    throw new LlmError('Codex returned no answer or Harness tool calls.', EMPTY_RESPONSE_CODE)
  }
  const tokens = tokenUsage(usage)
  return {
    blocks,
    ...tokens === undefined ? {} : { usage: tokens },
    ...native.some(item => item !== null)
      ? { replayState: { response: { kind: 'codex-app-server', model }, blocks: native } }
      : {},
  }
}

/**
 * Publish a completed response in Harness stream order, with usage before finish.
 * @param completion - fully validated response from the terminated child.
 * @returns a generator for the assembled response blocks and one terminal finish chunk.
 */
export function* chunks(completion: Completion): Generator<StreamChunk> {
  for (const [index, block] of completion.blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    yield { type: 'block-end', index, block }
  }
  if (completion.usage !== undefined) yield { type: 'usage', usage: completion.usage }
  yield {
    type: 'finish',
    reason: { kind: completion.blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' },
    ...completion.replayState === undefined ? {} : { replayState: completion.replayState },
  }
}
