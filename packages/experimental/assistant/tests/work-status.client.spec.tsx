// @vitest-environment jsdom
/** The owner dock retains worker and business outcomes separately through actions and connection loss. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyResources, inject as resourceInject } from '@deepseek-ai/dsh-client-resources/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConversationEntrance } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { act, fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { createStatusSource, type WorkStatusFrame } from '../src/client/status-source.ts'

type Status = WorkStatusFrame['status']
type Authority = Extract<Status['authority'], { kind: 'available' }>['value']
type Row = Status['work'][number]
type Operation = Extract<NonNullable<Row['operations']>, { kind: 'available' }>['value']['business'][number]
type Remote = Context['remote']['assistant']

const entrance = brandString<SessionId>('assistant')
const worker = brandString<SessionId>('worker')
const workId = brandString<Row['id']>('work-1')
const operationId = brandString<Operation['id']>('operation-1')
const outcomeCounts = { unconfirmed: 1, pending: 0, succeeded: 0, failed: 0 }
const authority: Authority = {
  expiresAt: 1800000000000, expired: false, maxOperations: 8, reserved: 5, remaining: 3,
  pendingApprovals: 1, unknown: 0,
}
const base = { refreshMs: 2_500, authority: { kind: 'available', value: authority }, work: [] } as const satisfies Status
const operation: Operation = {
  id: operationId, action: 'publish', dispatch: 'unconfirmed', completion: 'unconfirmed', canReconcile: true, unattended: false,
}

function snapshot(state: Row['status'], effect = operation): Status {
  const counts = effect.completion === 'succeeded' ? { ...outcomeCounts, unconfirmed: 0, succeeded: 1 }
    : effect.completion === 'failed' ? { ...outcomeCounts, unconfirmed: 0, failed: 1 } : outcomeCounts
  return { ...base, work: [{
    id: workId, sessionId: worker, prompt: 'Publish the release', status: state, inspectable: true,
    result: state === 'canceled' ? 'Stopped by the owner.' : null,
    operations: { kind: 'available', value: { pendingApprovals: 0, unknown: effect.completion === 'succeeded' || effect.completion === 'failed' ? 0 : 1,
      businessCompletion: counts, business: [effect], truncated: false } },
  }] }
}

function fixtureConnection() {
  let current: ConnectionGeneration | undefined = { id: 1, host: { home: '/home/test' } }
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish(id?: number) {
      current = id === undefined ? undefined : { id, host: { home: '/home/test' } }
      for (const listener of listeners) listener()
    },
  }
}

it('drops an in-flight answer on disconnect, refreshes once after reconnect, and ends on release', async (test) => {
  const connection = fixtureConnection()
  const lifetime = new AbortController()
  const requested = Promise.withResolvers<AbortSignal>()
  const answer = Promise.withResolvers<{ ok: true; value: Status }>()
  const read = vi.fn<(signal: AbortSignal) => Promise<{ ok: true; value: Status }>>()
    .mockResolvedValue({ ok: true, value: base })
    .mockImplementationOnce((signal) => { requested.resolve(signal); return answer.promise })
  const source = createStatusSource({ connection, read, visibility: document })
  const iterator = source.open(lifetime.signal)[Symbol.asyncIterator]()
  test.onTestFinished(async () => {
    lifetime.abort()
    answer.resolve({ ok: true, value: base })
    await iterator.return?.()
  })

  const first = iterator.next()
  const signal = await requested.promise
  source.refresh()
  source.refresh()
  expect(read).toHaveBeenCalledTimes(1)
  connection.publish()
  expect(signal.aborted).toBe(true)
  answer.resolve({ ok: true, value: base })
  expect(await first).toMatchObject({ done: false, value: { ok: false } })
  expect(read).toHaveBeenCalledTimes(1)

  connection.publish(2)
  expect(await iterator.next()).toMatchObject({ done: false, value: { ok: true, value: { generation: 2, status: base } } })
  expect(read).toHaveBeenCalledTimes(2)
  lifetime.abort()
  expect(await iterator.next()).toMatchObject({ done: true })
  expect(connection.listeners.size).toBe(0)
})

it('shows approval and budget beside separate work and business outcomes, and keeps effects after stopping', async (test) => {
  const runtime = await SlotTestRuntime.create()
  test.onTestFinished(async () => { await runtime.dispose() })
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('en')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const connection = fixtureConnection()
  runtime.ctx.provide('connection', { generation: connection } as never)
  const openSession = vi.fn()
  const registered = Promise.withResolvers<ConversationEntrance>()
  runtime.ctx.provide('uiWorkspace', { registerConversationEntrance(provider: ConversationEntrance) { registered.resolve(provider); return () => {} }, openSession } as never)
  vi.spyOn(runtime.remote, '$mount').mockResolvedValue(async () => {})
  let state = snapshot('running')
  const workStatus = vi.fn<Remote['workStatus']>(async () => ({ ok: true, value: state }))
  const stopWork = vi.fn<Remote['stopWork']>(async () => {
    state = snapshot('canceled')
    return { ok: true, value: { status: 'canceled' } }
  })
  const checkOutcome = vi.fn<Remote['checkOutcome']>(async () => {
    state = snapshot('canceled', {
      ...operation, completion: 'succeeded', receiptId: 'broker-receipt-1', canReconcile: false, unattended: true,
    })
    return { ok: true, value: { completion: 'succeeded' } }
  })
  runtime.remote.provideNamespaces({ assistant: {
    entrance: async () => ({ ok: true, value: { sessionId: entrance } }), workStatus, stopWork, checkOutcome,
  } })
  await runtime.mount({ apply: applyResources, inject: resourceInject })
  await runtime.declare({ 'conversation.input.status': { kind: 'list', scope: 'session' } })
  await runtime.sessions.add({ id: entrance })
  await runtime.sessions.add({ id: worker })
  const retained = runtime.sessions.retainFor(runtime.ctx, entrance)
  const other = runtime.sessions.retainFor(runtime.ctx, worker)
  await Promise.all([retained.ready, other.ready])
  const mounted = await runtime.mount(Object.assign((ctx: Context) => apply(ctx), { inject }))
  await (await registered.promise).resolve(test.signal)
  const input = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] } as const
  const zone = { session: retained.binding.session.getSnapshot(), input }
  const rendered = runtime.renderSlot('conversation.input.status', zone, { session: retained })
  const view = rendered.view

  expect(await view.findByText('Waiting for approval (1)')).toBeDefined()
  expect(view.getByText('3 left · 5 of 8 reserved')).toBeDefined()
  state = snapshot('unknown')
  act(() => { runtime.remote.emit('api-session/status', [entrance, true]) })
  expect(await view.findByText('Work outcome unknown')).toBeDefined()
  state = snapshot('running')
  act(() => { runtime.remote.emit('api-session/status', [entrance, false]) })
  expect(await view.findByText('Running')).toBeDefined()
  expect(view.queryByText('Publish the release')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Assistant work' }))
  expect(view.getByText('External outcome unconfirmed')).toBeDefined()
  fireEvent.click(view.getByRole('button', { name: 'Inspect session' }))
  expect(openSession).toHaveBeenCalledWith(worker)

  await act(async () => { connection.publish() })
  expect(view.getByText('Status may be out of date')).toBeDefined()
  expect(view.getByRole<HTMLButtonElement>('button', { name: 'Stop work' }).disabled).toBe(true)
  await act(async () => { connection.publish(2) })

  fireEvent.click(view.getByRole('button', { name: 'Stop work' }))
  expect(await view.findByText('Stopped by the owner.')).toBeDefined()
  expect(view.getByText('External outcome unconfirmed')).toBeDefined()
  expect(stopWork).toHaveBeenCalledWith(entrance, workId, expect.any(AbortSignal))

  checkOutcome.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Read failed', {}) })
  fireEvent.click(view.getByRole('button', { name: 'Check outcome' }))
  expect((await view.findByRole('alert')).textContent).toContain('Couldn’t check the outcome.')
  expect(view.getByText('External outcome unconfirmed')).toBeDefined()
  fireEvent.click(view.getByRole('button', { name: 'Check outcome' }))
  expect(await view.findByText('External success confirmed')).toBeDefined()
  expect(view.getByText('Receipt broker-receipt-1')).toBeDefined()
  expect(view.getByText('Sent without approval')).toBeDefined()
  expect(view.queryByText('Needs attention (1)')).toBeNull()
  expect(checkOutcome).toHaveBeenLastCalledWith(entrance, workId, operationId, expect.any(AbortSignal))

  state = snapshot('unknown')
  const workerReport = '一度だけ送信しました。結果は未確認です。'
  state = { ...state, work: state.work.map(work => ({
    ...work, result: `The script ran, but the outside request's result is unknown. It may or may not have taken effect.\n\nWorker report (completed): ${workerReport}`,
  })) }
  await act(async () => { connection.publish(3) })
  expect((await view.findAllByText('Work outcome unknown'))[0]).toBeDefined()
  expect(view.getByText(workerReport)).toBeDefined()
  expect(view.queryByText(/The script ran, but the outside request/u)).toBeNull()
  state = snapshot('unknown', { ...operation, completion: 'succeeded', canReconcile: false })
  await act(async () => { connection.publish(4) })
  expect((await view.findAllByText('External success confirmed'))[0]).toBeDefined()
  expect(view.queryByText('Work outcome unknown')).toBeNull()
  expect(view.queryByText('Needs attention (1)')).toBeNull()
  expect(view.queryByText('Inspect the work and check unresolved outcomes before continuing.')).toBeNull()
  state = snapshot('unknown', { ...operation, completion: 'failed', canReconcile: false })
  await act(async () => { connection.publish(5) })
  expect((await view.findAllByText('External failure confirmed'))[0]).toBeDefined()
  expect(view.queryByText('Work outcome unknown')).toBeNull()

  fireEvent.click(view.getByRole('button', { name: 'Assistant work' }))
  state = snapshot('failed')
  state = { ...state, work: state.work.map(work => ({ ...work, result: workerReport })) }
  await act(async () => { connection.publish(6) })
  expect(await view.findByText('Work failed')).toBeDefined()
  state = snapshot('failed', { ...operation, completion: 'succeeded', canReconcile: false })
  state = { ...state, work: state.work.map(work => ({ ...work, result: workerReport })) }
  await act(async () => { connection.publish(7) })
  expect(await view.findByText('External success confirmed')).toBeDefined()
  expect(view.queryByText('Work failed')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Assistant work' }))
  expect(view.getByText('Report before the outcome check · Work failed')).toBeDefined()
  expect(view.getByText(workerReport)).toBeDefined()

  state = { ...state, authority: { kind: 'unavailable', code: 'configuration-evidence-unavailable' } }
  await act(async () => { connection.publish(8) })
  const witness = await view.findByText("The witness service is not confirming records. This request did not run or send anything. Check Vardock's services with pnpm vardock doctor. Vardock recovers automatically when the witness returns.")
  expect(witness.title).toBe('configuration-evidence-unavailable')
  expect(view.queryByText('Authority status unavailable (configuration-evidence-unavailable)')).toBeNull()

  rendered.update({ session: other.binding.session.getSnapshot(), input }, { session: other })
  expect(view.queryByRole('region', { name: 'Assistant work' })).toBeNull()
  await mounted.dispose()
  expect(connection.listeners.size).toBe(0)
})
