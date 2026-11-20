// @vitest-environment jsdom
/** Assistant entrance registration and read-only composer policy. */
import type { Context } from '@deepseek-ai/cordis'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-assistant/remote'
import { UiConversation, type ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationEntrance } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

const sessionId = brandString<SessionId>('custom-assistant')
type Entrance = Context['remote']['assistant']['entrance']
const success = { ok: true, value: { sessionId } } as const
const failure = { ok: false, error: new RemoteError('gateway/internal', 'Lookup failed', {}) } as const
const plugin = Object.assign((ctx: Context) => apply(ctx), { inject })

async function fixture(test: { onTestFinished(fn: () => Promise<void>): void }) {
  const runtime = await SlotTestRuntime.create()
  test.onTestFinished(async () => { await runtime.dispose() })
  const entrance = vi.fn<Entrance>()
  const unregister = vi.fn()
  const registerConversationEntrance = vi.fn<(provider: ConversationEntrance) => () => void>(() => unregister)
  const disposeRemote = vi.fn(async () => {})
  const mountRemote = vi.spyOn(runtime.remote, '$mount').mockResolvedValue(disposeRemote)
  runtime.remote.provideNamespaces({ assistant: { entrance } })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('uiWorkspace', { registerConversationEntrance } as never)
  const provider = (): ConversationEntrance => {
    const value = registerConversationEntrance.mock.lastCall?.[0]
    if (value === undefined) throw new Error('Assistant entrance did not register')
    return value
  }
  return { runtime, entrance, locale, provider, registerConversationEntrance, unregister, mountRemote, disposeRemote }
}

it('registers the localized primary conversation and withdraws it on unload', async (test) => {
  const b = await fixture(test)
  b.entrance.mockResolvedValue(success)
  const conversation = new UiConversation(b.runtime.ctx, b.runtime.ctx.sessions)
  const mounted = await b.runtime.mount(plugin)
  expect(conversation.events.entries().map(definition => definition.kind)).toEqual(['assistant-artifacts'])
  const provider = b.provider()
  expect(provider.action).toBe('assistant/entrance')
  expect(provider.label()).toBe('Assistant')
  b.locale.setLocale('zh')
  expect(provider.label()).toBe('助手')
  expect(conversation.usesVerbatimAttachments(sessionId)).toBe(false)
  await expect(provider.resolve(new AbortController().signal)).resolves.toBe(sessionId)
  await expect(provider.resolve(new AbortController().signal)).resolves.toBe(sessionId)
  expect(conversation.usesVerbatimAttachments(sessionId)).toBe(true)
  expect(conversation.usesVerbatimAttachments(brandString<SessionId>('worker'))).toBe(false)
  expect(b.entrance).toHaveBeenCalledOnce()
  expect(b.mountRemote).toHaveBeenCalledOnce()
  await mounted.dispose()
  expect(conversation.usesVerbatimAttachments(sessionId)).toBe(false)
  expect(conversation.events.entries()).toEqual([])
  expect(b.unregister).toHaveBeenCalledOnce()
  expect(b.disposeRemote).toHaveBeenCalledOnce()
})

it('resolves again after a refused lookup and cancels an in-flight read on unload', async (test) => {
  const b = await fixture(test)
  const pending = Promise.withResolvers<Awaited<ReturnType<Entrance>>>()
  b.entrance.mockResolvedValueOnce(failure).mockReturnValueOnce(pending.promise)
  const mounted = await b.runtime.mount(plugin)
  const provider = b.provider()
  const signal = new AbortController().signal
  await expect(provider.resolve(signal)).rejects.toBe(failure.error)
  expect(provider.failureMessage(failure.error)).toBe('Couldn’t open Assistant. Select Assistant to retry.')
  const resolving = expect(provider.resolve(signal)).rejects.toThrow()
  await mounted.dispose()
  expect(b.entrance.mock.lastCall?.[0]?.aborted).toBe(true)
  pending.resolve(success)
  await resolving
})

it('refuses requests for a different preset before resolving the entrance', async (test) => {
  const b = await fixture(test)
  await b.runtime.mount(plugin)
  const provider = b.provider()
  await expect(provider.resolve(new AbortController().signal, 'cordis')).rejects.toThrow('configured preset')
  expect(b.entrance).not.toHaveBeenCalled()
})

it('withdraws the Remote if navigation registration fails', async (test) => {
  const b = await fixture(test)
  b.registerConversationEntrance.mockImplementationOnce(() => { throw new Error('Entrance unavailable') })
  await expect(apply(b.runtime.ctx)).rejects.toThrow('Entrance unavailable')
  expect(b.disposeRemote).toHaveBeenCalledOnce()
})

it('blocks the selected worker composer and clears the block on entrance navigation or unload', async (test) => {
  const b = await fixture(test)
  const worker = brandString<SessionId>('worker')
  const blocks = new Map<SessionId, ComposerBlock>()
  await b.runtime.sessions.add({ id: worker })
  await b.runtime.sessions.add({ id: sessionId })
  let selected = b.runtime.sessions.retain(worker, { source: 'mainView' })
  test.onTestFinished(() => { selected.release() })
  const select = (id: SessionId): void => {
    selected.release()
    selected = b.runtime.sessions.retain(id, { source: 'mainView' })
  }
  await b.runtime.mount({
    apply(ctx: Context) {
      ctx.provide('conversation', {
        blocks: {
          set(id: SessionId, block: ComposerBlock | undefined) {
            if (block === undefined) blocks.delete(id)
            else blocks.set(id, block)
          },
          storeFor(id: SessionId) { return { getSnapshot: () => blocks.get(id) } },
        },
      } as never)
    },
  })
  b.entrance.mockResolvedValueOnce(failure).mockResolvedValueOnce(success)
  const mounted = await b.runtime.mount(plugin)
  expect(blocks.get(worker)?.reason).toBe('Open Assistant to send messages.')
  b.locale.setLocale('zh')
  expect(blocks.get(worker)?.reason).toBe('打开助手即可发送消息')
  b.locale.setLocale('en')

  const workerBlock = blocks.get(worker)
  await expect(b.provider().resolve(new AbortController().signal)).resolves.toBe(sessionId)
  expect(blocks.get(worker)).toBe(workerBlock)
  select(sessionId)
  expect(blocks.size).toBe(0)

  select(worker)
  expect(blocks.get(worker)?.reason).toBe('Open Assistant to send messages.')
  await mounted.dispose()
  expect(blocks.size).toBe(0)
  select(sessionId)
  select(worker)
  expect(blocks.size).toBe(0)
})
