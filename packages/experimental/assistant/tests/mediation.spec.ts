import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { expect, it, vi } from 'vitest'
import { hostFixture } from './harness.ts'
import { WorkId } from '../src/state.ts'

it('allows editing queued user input without changing the identity of a worker report', async (test) => {
  const { boot } = await hostFixture(test)
  const entrance = SessionId('managed-input-entrance')
  let disposeMain: (() => Promise<void>) | undefined
  const { ctx, main } = await boot(2, entrance, async (ctx) => {
    const handle = await ctx.agents.create({
      sessionId: entrance, agentOptions: { provider: 'mock', model: 'mock' },
    })
    disposeMain = () => handle.dispose()
  })
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'My queued request' }] })
  const report = createUserMessage({
    source: { kind: 'assistant-work', workId: WorkId('queued-report'), direction: 'result', form: 'notice', summary: 'Saved worker outcome' },
    content: [{ type: 'text', text: 'The worker could not complete the operation.' }],
  })
  main.inbox.prepend('next-turn', report)
  main.inbox.prepend('next-step', user)
  const decide = (request: unknown) => ctx.remoteAccess.decide({
    principal: ctx.connection.browserPeer.principal,
    action: 'session/updateQueue', resources: [{ kind: 'session', id: main.id }], args: { request },
  })
  expect(decide({ itemId: user.id })).toEqual({ kind: 'allow' })
  expect(decide({ itemId: report.id })).toEqual({ kind: 'deny', reason: 'assistant/managed-input' })
  expect(decide({ itemId: 'missing' })).toEqual({ kind: 'deny', reason: 'assistant/managed-input' })
  expect(decide(null)).toEqual({ kind: 'deny', reason: 'assistant/managed-input' })
  expect(main.inbox.nextTurn[0]).toStrictEqual(report)

  await disposeMain?.()
  expect(ctx.agents.get(main.id)).toBeUndefined()
  expect(decide({ itemId: user.id })).toEqual({ kind: 'deny', reason: 'assistant/managed-input' })
})

it('keeps owner conversation input at the entrance while allowing worker history', async (test) => {
  const { boot } = await hostFixture(test)
  const { ctx, main } = await boot()
  const work = await ctx.assistant.delegate(main, 'remote-mediation', 'Inspect a worker Session')
  const principal = ctx.connection.browserPeer.principal
  const decide = (action: RemoteAccessAction, id: SessionId) =>
    ctx.remoteAccess.decide({ principal, action, resources: [{ kind: 'session', id }] })
  const denied = { kind: 'deny', reason: 'assistant/entrance-required' }

  for (const action of ['session/prompt', 'session/updateQueue', 'session/cancel', 'session/fork'] as const) {
    expect(decide(action, work.sessionId)).toEqual(denied)
  }
  expect(ctx.remoteAccess.decide({ principal, action: 'commands/execute', resources: [{ kind: 'global' }] })).toEqual(denied)
  for (const action of ['workspace/follow', 'session/list', 'session/control', 'session/page', 'session/attachment'] as const) {
    expect(decide(action, work.sessionId)).toEqual({ kind: 'allow' })
  }
  expect(decide('session/prompt', main.id)).toEqual({ kind: 'allow' })
})

it('refuses worker interaction before reaching answerers', async (test) => {
  const { boot } = await hostFixture(test)
  const { ctx, main, model } = await boot()
  await ctx.plugin(UserQuestions)
  const work = await ctx.assistant.delegate(main, 'worker-interaction', 'Test the worker interaction policy')
  const request = await model.next(work.sessionId)
  const worker = ctx.agents.get(work.sessionId)
  if (worker === undefined) throw new Error('worker did not start')

  const approval = vi.fn(async () => 'allowed-once' as const)
  const answer = { answers: [{ id: 'confirmation', selected: ['Yes'] }] }
  const answerQuestion = vi.fn(async () => answer)
  ctx.on('approval/request', approval)
  ctx.on('user-questions/request', answerQuestion)

  await expect(ctx.approval.request({ agent: worker, toolName: 'exec' })).resolves.toBe('rejected')
  expect(approval).not.toHaveBeenCalled()
  const questions = [{ id: 'confirmation', question: 'Use the alternate source?' }]
  await expect(ctx.userQuestions.ask({ agent: worker, questions })).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  expect(answerQuestion).not.toHaveBeenCalled()
  await expect(ctx.userQuestions.ask({ agent: main, questions })).resolves.toEqual(answer)
  expect(answerQuestion).toHaveBeenCalledOnce()

  request.tools({ name: 'report_work', args: { status: 'needs_input', result: 'Use the alternate source?' } })
  const report = await model.next(main.id)
  await expect(ctx.approval.request({ agent: main, toolName: 'delegate_work' })).resolves.toBe('allowed-once')
  expect(approval).toHaveBeenCalledOnce()
  report.text('The worker asks whether to use the alternate source.')
  await main.whenIdle()
})
