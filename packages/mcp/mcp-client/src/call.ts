/**
 * One-shot MCP tool call over Streamable HTTP: connect, call one tool, close.
 * Nothing registers on `ctx.tools` and no `serverName` is reserved, so a
 * caller that decides each call itself can use a server without exposing its
 * tools to an Agent. Expected failures return a stage-classified value rather
 * than throwing.
 *
 * @module
 */

import { Client, type FetchLike } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { McpTemplateBinding } from './credentials.ts'
import { McpGeneration } from './generation.ts'
import { McpLocalError } from './diagnostic.ts'
import type { StreamableHttpConfig } from './index.ts'
import { extractText } from './tools.ts'
import type { McpCloseResult } from './types.ts'

type CallOutcome =
  | {
    ok: true
    /** Whether the server marked the result as an error. */
    isError: boolean
    /** The result's text blocks joined by newlines, with resolved template values redacted. */
    text: string
  }
  | {
    ok: false
    /** `connect` failed before the server received the call; a `call` failure leaves the server-side effect unknown. */
    stage: 'connect' | 'call'
    /** Diagnostic with resolved template values redacted. */
    message: string
  }

/** Outcome of one {@link callServerTool} call. */
export type McpCallResult = CallOutcome & McpCloseResult

/**
 * Fetch whose response bodies together carry at most `maxBytes`.
 * @param maxBytes - bytes all response bodies of the connection may carry.
 * @param overflow - called when a body read passes the bound; that read then fails.
 * @param fetcher - HTTP client for this connection.
 * @returns the fetch for one connection.
 */
function boundedFetch(maxBytes: number, overflow: () => void, fetcher: FetchLike): FetchLike {
  let received = 0
  return async (url, init) => {
    const response = await fetcher(url, init)
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received <= maxBytes) {
          controller.enqueue(chunk)
          return
        }
        overflow()
        controller.error(new McpLocalError(`server responses exceeded ${maxBytes} bytes`))
      },
    }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

/**
 * Call one tool on a server and close the connection.
 * @param ctx - context providing template sources when expansion is enabled.
 * @param config - transport configuration; `startupTimeoutMs` bounds the connection and `toolCallTimeoutMs` the call.
 * @param tool - raw tool name and its JSON arguments.
 * @param maxReadBytes - bytes all HTTP response bodies of the connection may carry together, including the handshake.
 *   Exceeding it closes the connection and settles as a failure at the current stage.
 * @param signal - aborts the in-flight call; it settles as a failure at the current stage after bounded cleanup.
 * @param fetcher - HTTP client for this connection; defaults to global fetch.
 * @returns the result text or a stage-classified failure, with the independent cleanup result.
 * @throws for malformed templates or a missing required credentials provider.
 */
export async function callServerTool(
  ctx: Context, config: StreamableHttpConfig, tool: { name: string; arguments: Record<string, JsonValue> },
  maxReadBytes: number, signal?: AbortSignal, fetcher: FetchLike = fetch,
): Promise<McpCallResult> {
  const binding = new McpTemplateBinding(ctx, config)
  const client = new Client({ name: 'dsh-mcp-call', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  const generation = new McpGeneration(client, config.closeTimeoutMs, error => binding.diagnostic(error, 'cleanup'))
  const abort = (): void => { void generation.close() }
  const responses = { overflowed: false }
  const fetch = boundedFetch(maxReadBytes, () => {
    responses.overflowed = true
    abort()
  }, fetcher)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let stage: 'connect' | 'call' = 'connect'
  let result: CallOutcome
  try {
    const resolved = await generation.run(lifetime => binding.resolve(lifetime), config.startupTimeoutMs)
    await generation.connect(resolved, config.startupTimeoutMs, fetch)
    stage = 'call'
    const response = await generation.run(lifetime => client.callTool(tool, { signal: lifetime, timeout: config.toolCallTimeoutMs }))
    result = {
      ok: true, isError: response.isError === true,
      text: binding.redact(extractText(response.content as JsonValue[], tool.name)),
    }
  } catch (error) {
    const message = signal?.aborted ? 'call aborted'
      : responses.overflowed ? `server responses exceeded ${maxReadBytes} bytes` : binding.diagnostic(error, stage)
    result = { ok: false, stage, message }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
  return { ...result, ...await generation.close() }
}
