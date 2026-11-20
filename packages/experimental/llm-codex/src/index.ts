/** Register a Harness model route backed by the user's local Codex command. */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter, LlmError, resolveRetryPolicy,
  type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { completeWithCodex, type AppServerSpec } from './app-server.ts'
import { chunks, type Completion } from './projection.ts'

export const name = 'llm-codex'
export const inject = ['llm', 'subprocess']

const PROVIDER = 'codex-local'
const DEFAULT_MODEL = 'default'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_DISPOSE_GRACE_MS = 3_000
const NO_RETRIES = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'llm-codex')

/** Deployment settings for the local Codex executable and its process lifetime. */
export interface Config {
  /** Codex executable name on PATH or absolute executable path. */
  command?: string
  /** Maximum time in milliseconds to obtain one response. */
  timeoutMs?: number
  /** Milliseconds between managed process termination stages. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  command: z.string().pattern(/\S/).default('codex'),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
  disposeGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_DISPOSE_GRACE_MS),
})

function resolveConfig(config: Config, ctx: Context): AppServerSpec {
  const resolved = Config(config) as Required<Config>
  return { ...resolved, spawn: spec => ctx.subprocess.spawn(spec) }
}

class CodexAdapter extends LlmAdapter {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<Completion>>()

  constructor(private readonly spec: AppServerSpec) { super() }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Local Codex' }
  }

  override providerRetryPolicy() {
    return NO_RETRIES
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [await this.resolveModel(provider, DEFAULT_MODEL)]
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model === DEFAULT_MODEL ? 'Codex default' : model,
      inputModalities: ['text'], compaction: 'unsupported',
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const field of ['maxTokens', 'temperature', 'stop', 'reasoningEffort'] as const) {
      if (options[field] !== undefined) {
        throw new LlmError(`Local Codex does not support the ${field} request option.`, 'UNSUPPORTED_OPTION')
      }
    }
    const signal = options.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([options.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const pending = completeWithCodex({ ...options, signal }, this.spec)
    this.active.add(pending)
    let completion: Completion
    try {
      completion = await pending
    } finally {
      this.active.delete(pending)
    }
    signal.throwIfAborted()
    yield* chunks(completion)
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(new LlmError('The Local Codex adapter was unloaded.', 'ABORTED'))
    const settled = await Promise.allSettled(this.active)
    for (const result of settled) {
      if (result.status === 'rejected' && result.reason instanceof LlmError && result.reason.code === 'CODEX_TEARDOWN') {
        throw result.reason
      }
    }
  }
}

/**
 * Register the local Codex adapter for this plugin's lifetime.
 * @param ctx - Cordis context with the LLM and managed subprocess services.
 * @param config - local executable and process timing settings.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = new CodexAdapter(resolveConfig(config, ctx))
  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.effect(() => () => adapter.dispose(), 'llm-codex: stop active requests')
}
