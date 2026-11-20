/** Poll the owner status resource only while held by an entrance view. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

type WorkStatus = Extract<Awaited<ReturnType<Context['remote']['assistant']['workStatus']>>, { ok: true }>['value']

/** One observation and the connection generation in which it was read. */
export interface WorkStatusFrame {
  readonly generation: number
  readonly status: WorkStatus
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Work and authority observations for the configured owner entrance. */
    'assistant-work': WorkStatusFrame
  }
}

/** One address for the configured Assistant entrance in the current client. */
export const WORK_STATUS_ADDRESS = 'dsh-resource://assistant-work/entrance'

interface Dependencies {
  readonly connection: ConnectionGenerationState
  readonly read: (signal: AbortSignal) => Promise<RemoteResult<WorkStatus>>
  readonly visibility: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
}

interface StatusSource {
  readonly refresh: () => void
  readonly open: (signal: AbortSignal) => AsyncIterable<RemoteResult<WorkStatusFrame>>
}

/**
 * Make one foreground status provider with a coalesced explicit refresh.
 * @param deps - generation, visibility, and owner Remote read.
 * @returns Stream opener and manual invalidation for that resource.
 */
export function createStatusSource(deps: Dependencies): StatusSource {
  let refresh: (() => void) | undefined
  const disconnected: RemoteResult<WorkStatusFrame> = {
    ok: false, error: new RemoteError('gateway/internal', 'The Assistant connection is unavailable.', {}),
  }
  return {
    refresh: () => { refresh?.() },
    async *open(signal: AbortSignal): AsyncIterable<RemoteResult<WorkStatusFrame>> {
      let revision = 0
      let notify: (() => void) | undefined
      let delay: number | undefined
      let request: AbortController | undefined
      const wake = (): void => {
        revision++
        notify?.()
      }
      const invalidate = (): void => { request?.abort(); wake() }
      const waitForChange = async (started: number, delay?: number): Promise<void> => {
        if (signal.aborted || started !== revision) return
        const { promise, resolve } = Promise.withResolvers<void>()
        const finish = (): void => { resolve() }
        notify = finish
        signal.addEventListener('abort', finish, { once: true })
        const timer = delay === undefined ? undefined : setTimeout(finish, delay)
        try {
          await promise
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          notify = undefined
        }
      }
      refresh = wake
      const unsubscribe = deps.connection.subscribe(invalidate)
      deps.visibility.addEventListener('visibilitychange', invalidate)
      try {
        while (!signal.aborted) {
          const started = revision
          const generation = deps.connection.getSnapshot()
          if (generation === undefined) yield disconnected
          if (generation === undefined || deps.visibility.visibilityState === 'hidden') {
            await waitForChange(started)
            continue
          }
          request = new AbortController()
          const requestSignal = AbortSignal.any([signal, request.signal])
          const reply = await deps.read(requestSignal)
          request = undefined
          if (requestSignal.aborted) continue
          if (reply.ok) {
            delay = reply.value.refreshMs
            yield { ok: true, value: { generation: generation.id, status: reply.value } }
          } else {
            yield reply
          }
          await waitForChange(started, delay)
        }
      } finally {
        unsubscribe()
        deps.visibility.removeEventListener('visibilitychange', invalidate)
        if (refresh === wake) refresh = undefined
      }
    },
  }
}
