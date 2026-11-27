/**
 * Practice inventory requests made by Assistant work, judged by the inventory the service reports to the test directly.
 * The model is scripted; the authority, witness, broker and service are real processes.
 */
import { randomUUID } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { expect, it } from 'vitest'
import { hostFixture } from '../../../packages/experimental/assistant/tests/harness.ts'
import { practicePermissions, startPracticeStack } from './stack.ts'

const requestText = ({ messages }: GenerateOptions) => messages.flatMap(message =>
  message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
const submit = (action: string, body: object) => JSON.stringify({ requestKey: randomUUID(), action, body: JSON.stringify(body) })

it.skipIf(process.platform === 'win32')('records each work outcome separately from the inventory change it did or did not cause', async (test) => {
  const stack = await startPracticeStack(test)
  const { boot } = await hostFixture(test)
  const { ctx, main, model } = await boot(2, 'assistant-main', undefined, {
    socketPath: stack.operationSocket, approvalSocketPath: stack.approvalSocket,
  })
  const signal = new AbortController().signal
  const decisions: ApprovalOutcome[] = []
  const asked: string[] = []
  ctx.on('approval/request', (request) => {
    asked.push(request.detail ?? '')
    return Promise.resolve(decisions.shift() ?? 'rejected')
  })
  expect(await stack.inventory()).toEqual({ pencil: 12, notebook: 5, eraser: 8 })

  /** Delegate one request, let the worker act, and return the stored work after the entrance hears the report. */
  async function run(key: string, prompt: string, act: (worker: Awaited<ReturnType<typeof model.next>>) => Promise<void>) {
    const work = await ctx.assistant.delegate(main, key, prompt, null, signal, practicePermissions)
    await act(await model.next(work.sessionId))
    ;(await model.next(main.id)).text('Noted.')
    await main.whenIdle()
    return ctx.assistant.list().find(item => item.id === work.id)!
  }

  // The owner approves the exact update. The worker's completed report stays open until the outcome is confirmed.
  decisions.push('allowed-once')
  const applied = await run('set-pencil-7', 'Set the pencil quantity to 7.', async (worker) => {
    worker.tools({ name: 'exec', args: { command: submit('set-quantity', { sku: 'pencil', quantity: 7 }) } })
    const observed = await model.next(worker.options.sessionId)
    expect(requestText(observed.options)).toContain('business completion is not verified')
    observed.tools({ name: 'report_work', args: { status: 'completed', result: 'Pencil quantity set to 7.' } })
  })
  expect(asked).toHaveLength(1)
  expect(applied).toMatchObject({ status: 'unknown', result: expect.stringContaining('Worker report (completed): Pencil quantity set to 7.') as string })
  const [update] = (await stack.client.businessOperations(applied.sessionId)).operations
  if (update === undefined) throw new Error('Expected the update operation')
  expect(await ctx.assistant.checkOutcome(main.id, applied.id, update.id, signal)).toEqual({ completion: 'succeeded' })
  // The owner's view reports the confirmed outcome; the stored work keeps the worker's unconfirmed report.
  expect((await ctx.assistant.workStatus(main.id, signal)).work.find(item => item.id === applied.id)).toMatchObject({
    status: 'unknown', operations: { kind: 'available', value: { business: [{ id: update.id, completion: 'succeeded' }] } },
  })
  expect(await stack.inventory()).toMatchObject({ pencil: 7 })

  // The worker claims an update it never requested. Nothing in the harness can tell; only the service state shows it.
  const claimed = await run('set-pencil-9', 'Set the pencil quantity to 9.', async (worker) => {
    worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Pencil quantity set to 9.' } })
  })
  expect(claimed).toMatchObject({ status: 'completed', result: 'Pencil quantity set to 9.' })
  expect(await stack.inventory()).toMatchObject({ pencil: 7 })

  // The owner declines the update; it is never sent.
  decisions.push('rejected')
  const declined = await run('set-pencil-3', 'Set the pencil quantity to 3.', async (worker) => {
    worker.tools({ name: 'exec', args: { command: submit('set-quantity', { sku: 'pencil', quantity: 3 }) } })
    const observed = await model.next(worker.options.sessionId)
    expect(requestText(observed.options)).toContain('"code":"broker-canceled"')
    observed.tools({ name: 'report_work', args: { status: 'failed', result: 'The owner declined the update.' } })
  })
  expect(asked).toHaveLength(2)
  expect(declined).toMatchObject({ status: 'failed' })
  expect(await stack.inventory()).toMatchObject({ pencil: 7 })
})
