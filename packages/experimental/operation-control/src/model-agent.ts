/** Dispatch the Host's one model route only through the operation authority. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter, LlmError, resolveRetryPolicy,
  type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { OperationControlClient, OperationControlError } from './client.ts'
import { modelIdPattern, projectModelRequest, type ModelObservation } from './model-protocol.ts'
import { WITNESS_WAITING_MESSAGE } from './protocol.ts'

/** Cordis plugin name. */
export const name = 'operation-control-model-agent'
/** The Host only needs its LLM runtime to make mediated model requests. */
export const inject = ['llm']

/** Host connection and the only model route allowed by this composition. */
export interface Config {
  /** Unix socket granted to this Host's operating-system account. */
  readonly socketPath: string
  /** Provider route also configured on the authority. */
  readonly provider: string
  /** Model ID also configured on the authority. */
  readonly model: string
  /** Maximum time to await an authority response, including the model request. */
  readonly timeoutMs?: number
}

/** Validate the configured authority connection and exact route. */
export const Config: z<Config> = z.object({
  socketPath: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
  provider: z.string().pattern(modelIdPattern).required(),
  model: z.string().pattern(modelIdPattern).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(180_000),
})

const NO_RETRIES = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, name)

function denied(): LlmError {
  return LlmError.fromFailure({ message: 'This Host can use only its configured model through the operation authority.', code: 'MODEL_ROUTE_DENIED' })
}

class MediatedModelAdapter extends LlmAdapter {
  private readonly client: OperationControlClient
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<ModelObservation>>()

  constructor(private readonly config: Config) {
    super()
    this.client = new OperationControlClient(config)
  }

  override providerInfo(provider: string) {
    return { id: provider, name: provider }
  }

  override providerRetryPolicy() {
    return NO_RETRIES
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [await this.resolveModel(provider, this.config.model)]
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== this.config.provider || model !== this.config.model) throw denied()
    return Promise.resolve({
      provider, id: model, name: model,
      inputModalities: ['text'], compaction: 'unsupported',
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal === undefined
      ? this.lifetime.signal : AbortSignal.any([options.signal, this.lifetime.signal])
    const pending = this.dispatch(options, signal)
    this.active.add(pending)
    let chunks: ModelObservation
    try {
      chunks = await pending
    } finally {
      this.active.delete(pending)
    }
    signal.throwIfAborted()
    yield* chunks
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(new LlmError('The mediated model adapter was unloaded.', 'ABORTED'))
    await Promise.allSettled(this.active)
  }

  private async dispatch(options: GenerateOptions, signal: AbortSignal): Promise<ModelObservation> {
    const { sessionId } = options
    if (sessionId === undefined) throw LlmError.fromFailure({ message: 'Mediated model requests require a Session.', code: 'MODEL_SESSION_REQUIRED' })
    signal.throwIfAborted()
    const modelRequest = projectModelRequest(options)
    const requestKey = randomUUID()
    const issued = await this.client.propose({ requestKey, sessionId, modelRequest }, signal).catch((cause: unknown) => {
      signal.throwIfAborted()
      if (!(cause instanceof OperationControlError)) throw cause
      const message = cause.code === 'authority-unavailable'
        ? `Model proposal ${requestKey} has no confirmed reply. Inspect the operation authority.` : cause.message
      throw LlmError.fromFailure({ message, code: cause.code }, { cause })
    })
    if (issued.state !== 'issued') {
      throw LlmError.fromFailure({ message: issued.state === 'pending-evidence' ? `${WITNESS_WAITING_MESSAGE} Operation: ${issued.id}.`
        : `Model operation ${issued.id} is ${issued.state}. Inspect its authority record before continuing.`, code: 'MODEL_NOT_ISSUED' })
    }
    let result
    try {
      result = await this.client.execute(issued.id, signal)
    } catch (cause: unknown) {
      if (signal.aborted) {
        const canceled = await this.client.cancel(issued.id).catch((cancelCause: unknown) => {
          throw LlmError.fromFailure({ message: `Model operation ${issued.id} has no confirmed cancellation reply. Query its authority record.`, code: 'MODEL_OUTCOME_UNKNOWN' }, { cause: cancelCause })
        })
        throw new LlmError(`Cancellation requested for model operation ${issued.id}. Authority state is ${canceled.state}.`, 'ABORTED', { cause })
      }
      throw LlmError.fromFailure({ message: `Model operation ${issued.id} has no confirmed reply. Query its authority record before trying again.`, code: 'MODEL_OUTCOME_UNKNOWN' }, { cause })
    }
    if (result.state !== 'settled' || result.outcome?.kind !== 'model-response' || result.receipt === undefined) {
      const code = result.outcome?.kind === 'unknown' ? result.outcome.code : 'MODEL_OUTCOME_UNKNOWN'
      throw LlmError.fromFailure({ message: `Model operation ${issued.id} is ${result.state}. Inspect its authority record before continuing.`, code })
    }
    return result.outcome.chunks
  }
}

/**
 * Register the mediated route and refuse model dispatch through any other adapter.
 * @param ctx - owner of the model adapter and dispatch guard.
 * @param config - authority connection and the allowed provider route and model ID.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  const adapter = new MediatedModelAdapter(resolved)
  ctx.llm.registerAdapter([resolved.provider], adapter)
  ctx.effect(() => () => adapter.dispose(), 'operation-control: stop active model requests')
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider === resolved.provider && options.model === resolved.model) {
      yield* next()
      return
    }
    yield { type: 'finish', reason: { kind: 'error', failure: denied().failure } }
  }, { prepend: true })
}
