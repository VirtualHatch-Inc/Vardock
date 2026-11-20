/** Bounded text requests and completed model streams sent across the operation socket. */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createMessage, LlmError,
  type GenerateOptions, type LlmRuntime, type StreamChunk, type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

/** Pattern for provider route and model IDs, shared by the operator configuration and model wire validation. */
export const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

const modelId = z.string().regex(modelIdPattern)
const callId = z.string().min(1).transform(value => brandString<ToolCallId>(value))
const text = z.strictObject({ type: z.literal('text'), text: z.string() })
const reasoning = z.strictObject({ type: z.literal('reasoning'), text: z.string() })
const toolCall = z.strictObject({
  type: z.literal('tool-call'), id: callId, name: z.string().min(1), arguments: z.string(),
})
const assistantBlock = z.discriminatedUnion('type', [text, reasoning, toolCall])
// Adapter-private metadata that the same adapter reads back from a later request.
const replay = z.strictObject({ response: z.json(), blocks: z.array(z.json()).exactOptional() })
const message = z.discriminatedUnion('role', [
  z.strictObject({ role: z.enum(['system', 'developer', 'user']), content: z.array(text) }),
  z.strictObject({ role: z.literal('tool'), content: z.array(text), toolCallId: callId }),
  z.strictObject({
    role: z.literal('assistant'), content: z.array(assistantBlock),
    source: z.strictObject({
      kind: z.literal('model'), provider: z.string().min(1), model: z.string().min(1),
      replayState: replay.optional(),
    }),
  }),
])

/** Validate the projected model-visible fields of a text and tool request. */
export const modelRequestSchema = z.strictObject({
  provider: modelId,
  model: modelId,
  messages: z.array(message),
  system: z.string().optional(),
  tools: z.array(z.strictObject({
    name: z.string().min(1),
    description: z.string(),
    parameters: z.record(z.string(), z.json()),
  })).optional(),
})

/** Projected model request without local source metadata, credentials, or cancellation. */
export type ModelRequest = z.infer<typeof modelRequestSchema>

const counter = z.number().int().nonnegative()
const usage = z.strictObject({
  inputTokens: counter, outputTokens: counter, totalTokens: counter.exactOptional(),
  cacheReadTokens: counter.exactOptional(), cacheWriteTokens: counter.exactOptional(), reasoningTokens: counter.exactOptional(),
})
const chunk = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('block-start'), index: counter, blockType: z.enum(['text', 'reasoning', 'tool-call']) }),
  z.strictObject({ type: z.literal('block-end'), index: counter, block: assistantBlock }),
  z.strictObject({ type: z.literal('usage'), usage }),
  z.strictObject({
    type: z.literal('finish'), reason: z.strictObject({ kind: z.enum(['stop', 'tool-calls']) }),
    replayState: replay.exactOptional(),
  }),
]) satisfies z.ZodType<StreamChunk>

/** Validate a successful buffered stream: each block's start and end, optional usage, then the finish. */
export const modelObservationSchema = z.array(chunk).min(1).refine((chunks) => {
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish') return false
  const lastBlock = chunks.at(-2)?.type === 'usage' ? chunks.length - 2 : chunks.length - 1
  const blockCount = lastBlock / 2
  if (!Number.isInteger(blockCount) || blockCount < 1) return false
  const calls = new Set<ToolCallId>()
  let hasText = false
  for (let index = 0; index < blockCount; index++) {
    const start = chunks[index * 2]
    const end = chunks[index * 2 + 1]
    if (start?.type !== 'block-start' || end?.type !== 'block-end'
      || start.index !== index || end.index !== index || start.blockType !== end.block.type) return false
    const { block } = end
    if (block.type === 'tool-call') {
      if (calls.has(block.id)) return false
      calls.add(block.id)
    }
    if (block.type === 'text' && block.text.length > 0) hasText = true
  }
  return (hasText || calls.size > 0)
    && finish.reason.kind === (calls.size > 0 ? 'tool-calls' : 'stop')
    && (finish.replayState?.blocks === undefined || finish.replayState.blocks.length === blockCount)
})

/** Validated stream chunks for one complete model response. */
export type ModelObservation = z.infer<typeof modelObservationSchema>

/**
 * Project the text and tool history that the authority forwards to its model adapter.
 * @param options - request after LlmRuntime projection of images, files, and tool updates.
 * @returns the serializable request for the authority.
 */
export function projectModelRequest(options: GenerateOptions): ModelRequest {
  for (const field of ['maxTokens', 'temperature', 'stop', 'reasoningEffort', 'purpose'] as const) {
    if (options[field] !== undefined) {
      throw new LlmError(`Mediated model requests do not support the ${field} request option.`, 'UNSUPPORTED_OPTION')
    }
  }
  const projected = modelRequestSchema.safeParse({
    provider: options.provider, model: options.model, system: options.system,
    tools: options.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
    messages: options.messages.map((entry) => {
      const { role, content } = entry
      if (role === 'assistant') return { role, content, source: entry.source }
      if (role === 'tool') return { role, content, toolCallId: entry.toolCallId }
      return { role, content }
    }),
  })
  if (!projected.success) {
    throw LlmError.fromFailure({ message: 'Mediated model requests accept text and Harness tool history.', code: 'UNSUPPORTED_MODEL_REQUEST' })
  }
  return projected.data
}

/**
 * Use the authority profile's existing LLM runtime and validate its completed stream.
 * @param llm - authority-owned runtime with the adapter for the request's provider.
 * @param sessionId - Session that proposed this request.
 * @param request - admitted model request payload.
 * @param signal - authority-owned operation lifetime.
 * @param maxBytes - total JSON stream budget excluding its enclosing response.
 * @returns the complete response after the adapter's stream ends.
 */
export async function observeModel(
  llm: LlmRuntime, sessionId: SessionId, request: ModelRequest, signal: AbortSignal, maxBytes: number,
): Promise<ModelObservation> {
  const { provider, model, system, tools, messages } = request
  const input: GenerateOptions = {
    provider, model, sessionId, signal,
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
    messages: messages.map((entry) => {
      switch (entry.role) {
        case 'assistant': return createMessage(entry)
        case 'tool': return createMessage({ ...entry, source: { kind: 'tool', callId: entry.toolCallId } })
        case 'system': return createMessage({ ...entry, role: 'system', source: { kind: 'system-prompt' } })
        case 'developer': return createMessage({ ...entry, role: 'developer', source: { kind: 'user' } })
        case 'user': return { ...entry, role: 'user' }
      }
    }),
  }
  const chunks: StreamChunk[] = []
  let bytes = 2
  for await (const frame of llm.stream(input)) {
    if (frame.type === 'finish' && (frame.reason.kind === 'error' || frame.reason.kind === 'aborted')) {
      throw LlmError.fromFailure({ message: 'The authority could not confirm a model response.', code: frame.reason.failure.code })
    }
    // Each block-end carries the assembled block, so the incremental chunks are not kept.
    if (frame.type === 'text-delta' || frame.type === 'reasoning-delta' || frame.type === 'tool-call-delta') continue
    bytes += Buffer.byteLength(JSON.stringify(frame)) + (chunks.length === 0 ? 0 : 1)
    if (bytes > maxBytes) throw LlmError.fromFailure({ message: 'The model response exceeds the authority byte limit.', code: 'MODEL_RESPONSE_TOO_LARGE' })
    chunks.push(frame)
  }
  const result = modelObservationSchema.safeParse(chunks)
  if (!result.success) throw LlmError.fromFailure({ message: 'The authority did not receive a complete model response.', code: 'MODEL_RESPONSE_INVALID' })
  return result.data
}
