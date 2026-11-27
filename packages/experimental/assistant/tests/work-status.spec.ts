/** Owner status batches work observations, keeps every row in order, and stops asking an authority it cannot read. */
import { OperationControlError } from '@deepseek-ai/dsh-operation-control/handoff'
import { expect, it, vi, type TestContext } from 'vitest'
import { hostFixture } from './harness.ts'

/** Accept `count` requests through the coordinator; the first runs and the rest stay queued. */
async function retainedWork(test: TestContext, count: number, concurrency?: number) {
  const fixture = await hostFixture(test)
  const host = await fixture.boot(1, 'assistant-test', undefined, concurrency)
  const { ctx, main, model } = host
  for (let index = 0; index < count; index++) {
    const work = await ctx.assistant.delegate(main, `work-${index}`, `Request ${index}`)
    if (index === 0) await model.next(work.sessionId)
  }
  const read = () => ctx.typertGateway.invoke({
    namespace: 'assistant', method: 'workStatus', peer: ctx.connection.browserPeer, args: { sessionId: main.id },
  })
  const answer = fixture.overview.getMockImplementation()!
  fixture.overview.mockClear()
  /** Work ids the status read asked the authority about, and the number of entrance budget reads. */
  const asked = () => ({
    work: fixture.overview.mock.calls.flatMap(([, , workId]) => workId === undefined ? [] : [String(workId)]),
    entrance: fixture.overview.mock.calls.filter(([, , workId]) => workId === undefined).length,
  })
  return { ...fixture, ...host, read, answer, asked, newestFirst: ctx.assistant.list().reverse() }
}

it.for([undefined, 1, 2])('observes retained work in batches (concurrency %s) and returns every record newest first', async (configured, test) => {
  const { ctx, read, asked, newestFirst } = await retainedWork(test, 7, configured)
  const limit = configured ?? 4
  const release = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  test.onTestFinished(() => { release.resolve(undefined) })
  const stat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
  let active = 0
  let peak = 0
  const observed: string[] = []
  vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
    observed.push(id)
    peak = Math.max(peak, ++active)
    if (observed.length === limit) started.resolve(undefined)
    try { await release.promise; return await stat(id, options) } finally { active-- }
  })
  const reading = read()
  await started.promise
  const firstBatch = [...observed]
  release.resolve(undefined)
  expect(await reading).toMatchObject({
    work: newestFirst.map(({ id, sessionId, prompt, status, result }) => ({ id, sessionId, prompt, status, result })),
  })
  expect(firstBatch).toEqual(newestFirst.slice(0, limit).map(item => item.sessionId))
  expect(observed).toEqual(newestFirst.map(item => item.sessionId))
  expect(peak).toBe(limit)
  expect(asked()).toEqual({ work: newestFirst.map(item => item.id), entrance: 1 })
})

it('does not start another batch after the owner cancels the read', async (test) => {
  const { ctx, main } = await retainedWork(test, 5, 2)
  const release = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  test.onTestFinished(() => { release.resolve(undefined) })
  let calls = 0
  // This read ignores cancellation, so only the coordinator can keep the next batch from starting.
  vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(async () => {
    if (++calls === 2) started.resolve(undefined)
    await release.promise
    return undefined
  })
  const controller = new AbortController()
  const rejected = expect(ctx.assistant.workStatus(main.id, controller.signal)).rejects.toThrow('owner canceled')
  await started.promise
  controller.abort(new Error('owner canceled'))
  release.resolve(undefined)
  await rejected
  expect(calls).toBe(2)
})

it.for(['authority-unavailable', 'configuration-evidence-unavailable'] as const)(
  'asks about one batch only when the authority cannot be read (%s)', async (code, test) => {
    const { ctx, overview, read, asked, newestFirst } = await retainedWork(test, 7, 2)
    overview.mockImplementation(async () => { throw new OperationControlError(code, 'Fixture authority is down.') })
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    const unavailable = { kind: 'unavailable', code }
    expect(await read()).toMatchObject({
      authority: unavailable, work: newestFirst.map(({ id }) => ({ id, operations: unavailable })),
    })
    expect(asked()).toEqual({ work: newestFirst.slice(0, 2).map(item => item.id), entrance: 1 })
    expect(stat).toHaveBeenCalledTimes(7)
  })

it('stops asking when the authority stops answering after the budget read', async (test) => {
  const { overview, answer, read, asked, newestFirst } = await retainedWork(test, 7, 2)
  // The authority answers the budget read and the newest work, then nothing else.
  let answers = 2
  overview.mockImplementation(async (sessionId, signal, workId) => {
    if (answers-- > 0) return answer(sessionId, signal, workId)
    throw new OperationControlError('authority-unavailable', 'Fixture authority stopped.')
  })
  const unavailable = { kind: 'unavailable', code: 'authority-unavailable' }
  expect(await read()).toMatchObject({
    authority: { kind: 'available' },
    work: newestFirst.map(({ id }, index) => ({ id, operations: index === 0 ? { kind: 'available' } : unavailable })),
  })
  expect(asked()).toEqual({ work: newestFirst.slice(0, 2).map(item => item.id), entrance: 2 })
})

it('keeps asking about later work when only some work cannot be read', async (test) => {
  const { overview, answer, read, asked, newestFirst } = await retainedWork(test, 7, 2)
  const broken = new Set<string>(newestFirst.slice(0, 2).map(item => item.id))
  overview.mockImplementation(async (sessionId, signal, workId) => {
    if (workId !== undefined && broken.has(workId)) throw new OperationControlError('work-conflict', 'Fixture refused this work.')
    return answer(sessionId, signal, workId)
  })
  expect(await read()).toMatchObject({
    work: newestFirst.map(({ id }) => ({ id, operations: { kind: broken.has(id) ? 'unavailable' : 'available' } })),
  })
  expect(asked()).toEqual({ work: newestFirst.map(item => item.id), entrance: 2 })
})

it('reports no authority state for a record without a grant, and only public artifact metadata', async (test) => {
  const { ctx, overview, operationId, read, asked, newestFirst } = await retainedWork(test, 3, 1)
  const [first, second, oldest] = newestFirst
  const { authorization: _grant, ...ungranted } = oldest!
  const artifact = { name: 'report.md', bytes: 12, digest: 'a'.repeat(64) }
  const legacy = { ...ungranted, artifacts: [{ ...artifact, path: 'private/report.md', operationId, receiptDigest: 'b'.repeat(64) }] }
  const list = vi.spyOn(ctx.assistant, 'list').mockImplementation(() => [legacy, second!, first!])
  test.onTestFinished(() => { list.mockRestore() })
  overview.mockImplementation(async () => { throw new OperationControlError('authority-unavailable', 'Fixture authority is down.') })
  const { id, sessionId, prompt, status, result } = legacy
  expect(await read()).toHaveProperty('work.2', {
    id, sessionId, prompt, status, result, inspectable: true, artifacts: [artifact],
  })
  expect(asked()).toEqual({ work: [first!.id], entrance: 1 })
})

it.for([0, 1.5, 65])('rejects work status concurrency %s at load', async (limit, test) => {
  const { boot } = await hostFixture(test)
  await expect(boot(1, 'assistant-test', undefined, limit).then(() => undefined)).rejects.toThrow('workStatusConcurrency')
})
