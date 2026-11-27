/** Production Loader composition with controllable provider responses and real persisted Session logs. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { OperationControlError, type HandoffRequest } from '@deepseek-ai/dsh-operation-control/handoff'
import Schedule from '@deepseek-ai/dsh-schedule'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { StorageError } from '@deepseek-ai/dsh-storage'
import * as TimeContext from '@deepseek-ai/dsh-time-context'
import * as ToolSchedule from '@deepseek-ai/dsh-tool-schedule'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { describe, expect, it, vi } from 'vitest'
import { hostFixture, stored } from './harness.ts'
import { assistantDomain, WorkId } from '../src/state.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'assistant-test-guest': { readonly kind: 'assistant-test-guest' }
  }
}

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const admissions = (events: readonly SessionEvent[]) => events.flatMap(event =>
  event.type === 'agent/inbox/spliced' ? event.data.inserted.flatMap(message =>
    message.source.kind === 'assistant-work' && message.source.direction === 'result' ? [message.source.workId] : []) : [])
const reports = (events: readonly SessionEvent[]) => events.flatMap(event =>
  event.type === 'user/message' && event.data.source.kind === 'assistant-work' && event.data.source.direction === 'result'
    ? [event.data.source.workId] : [])

const requestText = ({ messages }: GenerateOptions) => messages.flatMap(message =>
  message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
const workRequests = ({ messages }: GenerateOptions) => messages.flatMap(message =>
  message.role === 'user' && message.source?.kind === 'assistant-work' ? [message.source.workId] : [])

function assistantFiber(ctx: Context): Context['fiber'] {
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:@deepseek-ai/dsh-assistant')?.fiber
  if (fiber === undefined) throw new Error('assistant Loader entry is not active')
  return fiber
}

async function unloadFixtureExecution(ctx: Context): Promise<void> {
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:test-execution-tool')?.fiber
  if (fiber === undefined) throw new Error('test execution tool did not start')
  await fiber.dispose()
}

async function reloadFixtureExecution(ctx: Context): Promise<void> {
  const loader = ctx.loader
  const fiber = loader.resolve(await loader.create({ name: 'cordis:test-execution-tool' }))?.fiber
  if (fiber === undefined) throw new Error('test execution tool did not reload')
  await fiber.await()
}

describe('assistant delegation', () => {
  it('allows only the owner entrance to read and update usage settings without starting model work', async (test) => {
    const { boot, grantSettings, updateGrant } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const peer = ctx.connection.browserPeer
    const read = await ctx.typertGateway.invoke({ namespace: 'assistant', method: 'grantSettings', peer, args: { sessionId: main.id } })
    expect(read).toMatchObject({ revision: 'a'.repeat(64), reserved: 7, expired: true })
    const update = { revision: 'a'.repeat(64), maxOperations: 100, expiresAt: Date.now() + 86_400_000 }
    const result = await ctx.typertGateway.invoke({ namespace: 'assistant', method: 'updateGrant', peer, args: { sessionId: main.id, update } })
    expect(result).toMatchObject({ maxOperations: 100, reserved: 7, remaining: 93 })
    expect(updateGrant).toHaveBeenCalledWith(update, expect.any(AbortSignal))
    const guest = ctx.connection.createPeer({ principal: { kind: 'assistant-test-guest' } })
    ctx.remoteAccess.registerPolicy('assistant-test-guest', {
      bindings: () => [{ resource: { kind: 'session', id: main.id }, role: {
        resource: 'session', name: 'test-settings-access', actions: ['assistant/grantSettings', 'assistant/updateGrant'],
      } }],
    })
    for (const method of ['grantSettings', 'updateGrant']) {
      await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method, peer: guest, args: { sessionId: main.id, ...(method === 'updateGrant' ? { update } : {}) } }))
        .rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'assistant/owner-required' } })
    }
    expect(grantSettings).toHaveBeenCalledTimes(1)
    expect(updateGrant).toHaveBeenCalledTimes(1)
    expect(model.observed).toEqual([])
    expect(ctx.assistant.list()).toEqual([])
    await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method: 'grantSettings', peer, args: { sessionId: 'another-session' } }))
      .rejects.toMatchObject({ code: 'assistant/work-unavailable' })
    updateGrant.mockRejectedValueOnce(new OperationControlError('revision-mismatch', 'Settings changed.'))
    await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method: 'updateGrant', peer, args: { sessionId: main.id, update } }))
      .rejects.toMatchObject({ code: 'assistant/work-unavailable', details: { reason: 'revision-mismatch' } })
  })

  it('allows only the owner entrance to read connections and forward a credential to the authority', async (test) => {
    const { boot, brokerConnections, setBrokerConnection } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const peer = ctx.connection.browserPeer
    expect(await ctx.typertGateway.invoke({ namespace: 'assistant', method: 'connections', peer, args: { sessionId: main.id } }))
      .toEqual({ unattendedShell: false, revision: 'a'.repeat(64), connections: [{
        action: 'post-message', description: 'Post one message.', credentialRef: 'MESSAGE_TOKEN', configured: false,
        returnsResponse: false, unattended: [], routeChangedSinceRulesSaved: false,
      }] })
    const update = { action: 'post-message', value: 'fixture-token' }
    expect(await ctx.typertGateway.invoke({ namespace: 'assistant', method: 'setConnection', peer, args: { sessionId: main.id, update } }))
      .toMatchObject({ connections: [{ action: 'post-message', configured: true }] })
    expect(setBrokerConnection).toHaveBeenCalledExactlyOnceWith(update, expect.any(AbortSignal))
    const guest = ctx.connection.createPeer({ principal: { kind: 'assistant-test-guest' } })
    ctx.remoteAccess.registerPolicy('assistant-test-guest', {
      bindings: () => [{ resource: { kind: 'session', id: main.id }, role: {
        resource: 'session', name: 'test-connection-access', actions: ['assistant/connections', 'assistant/setConnection'],
      } }],
    })
    for (const method of ['connections', 'setConnection']) {
      await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method, peer: guest, args: { sessionId: main.id, ...(method === 'connections' ? {} : { update }) } }))
        .rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'assistant/owner-required' } })
    }
    expect(brokerConnections).toHaveBeenCalledTimes(1)
    expect(setBrokerConnection).toHaveBeenCalledTimes(1)
    expect(model.observed).toEqual([])
    await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method: 'connections', peer, args: { sessionId: 'another-session' } }))
      .rejects.toMatchObject({ code: 'assistant/work-unavailable' })
    for (const [method, mock] of [['connections', brokerConnections], ['setConnection', setBrokerConnection]] as const) {
      mock.mockRejectedValueOnce(new OperationControlError('broker-unavailable', 'No connection settings.'))
      await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method, peer, args: { sessionId: main.id, ...(method === 'connections' ? {} : { update }) } }))
        .rejects.toMatchObject({ code: 'assistant/work-unavailable', details: { reason: 'broker-unavailable' } })
    }
  })

  it('allows only the owner entrance to read business records', async (test) => {
    const { boot, businessRecords, operationId } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const peer = ctx.connection.browserPeer
    expect(await ctx.typertGateway.invoke({ namespace: 'assistant', method: 'records', peer, args: { sessionId: main.id, after: operationId } }))
      .toEqual({ records: [] })
    expect(businessRecords).toHaveBeenCalledExactlyOnceWith(operationId, expect.any(AbortSignal))
    const guest = ctx.connection.createPeer({ principal: { kind: 'assistant-test-guest' } })
    ctx.remoteAccess.registerPolicy('assistant-test-guest', {
      bindings: () => [{ resource: { kind: 'session', id: main.id }, role: {
        resource: 'session', name: 'test-record-access', actions: ['assistant/records'],
      } }],
    })
    await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method: 'records', peer: guest, args: { sessionId: main.id } }))
      .rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'assistant/owner-required' } })
    await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method: 'records', peer, args: { sessionId: 'another-session' } }))
      .rejects.toMatchObject({ code: 'assistant/work-unavailable' })
    businessRecords.mockRejectedValueOnce(new OperationControlError('authority-unavailable', 'No records.'))
    await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method: 'records', peer, args: { sessionId: main.id } }))
      .rejects.toMatchObject({ code: 'assistant/work-unavailable', details: { reason: 'authority-unavailable' } })
    expect(businessRecords).toHaveBeenCalledTimes(2)
    expect(model.observed).toEqual([])
  })

  it('allows only the owner entrance to determine a business outcome and reports witness confirmation', async (test) => {
    const { boot, resolveBusiness, operationId } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const peer = ctx.connection.browserPeer
    const resolution = { id: operationId, kind: 'succeeded' } as const
    const status = {
      id: operationId, sessionId: SessionId('worker-1'), action: 'capture', state: 'unknown', canReconcile: false,
      businessCompletion: { kind: 'succeeded', source: 'owner', receipt: { id: 'owner', digest: 'a'.repeat(64) } },
    } as const
    resolveBusiness.mockResolvedValueOnce(status)
    const invoke = (sessionId: string, caller = peer) => ctx.typertGateway.invoke({
      namespace: 'assistant', method: 'resolveBusiness', peer: caller, args: { sessionId, resolution },
    })
    expect(await invoke(main.id)).toEqual({ confirmed: true })
    expect(resolveBusiness).toHaveBeenCalledExactlyOnceWith(resolution, expect.any(AbortSignal))
    resolveBusiness.mockResolvedValueOnce({ ...status, businessCompletion: { kind: 'unconfirmed', code: 'reconciliation-evidence-unavailable' } })
    expect(await invoke(main.id)).toEqual({ confirmed: false })
    const guest = ctx.connection.createPeer({ principal: { kind: 'assistant-test-guest' } })
    ctx.remoteAccess.registerPolicy('assistant-test-guest', {
      bindings: () => [{ resource: { kind: 'session', id: main.id }, role: {
        resource: 'session', name: 'test-resolution-access', actions: ['assistant/resolveBusiness'],
      } }],
    })
    await expect(invoke(main.id, guest)).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'assistant/owner-required' } })
    await expect(invoke('another-session')).rejects.toMatchObject({ code: 'assistant/work-unavailable' })
    await expect(invoke(main.id)).rejects.toMatchObject({ code: 'assistant/work-unavailable', details: { reason: 'authority-unavailable' } })
    expect(resolveBusiness).toHaveBeenCalledTimes(3)
    expect(model.observed).toEqual([])
  })

  it('gives the entrance model delegation guidance and keeps the worker prompt independent', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    main.followup(user('Delegate a background request.'))
    const entrance = await model.next(main.id)
    expect(requestText(entrance.options)).toContain('acknowledge its acceptance, and end your turn')
    expect(requestText(entrance.options)).toContain('Scripts run automatically by default; a deployment may require script approval.')
    expect(requestText(entrance.options)).toContain('External requests wait for owner approval unless a configured rule admits them.')
    expect(requestText(entrance.options)).toContain('Notes and schedule changes always require owner approval.')
    entrance.text('Ready to delegate.')
    await main.whenIdle()
    const work = await ctx.assistant.delegate(main, 'scope', 'Background work')
    const worker = await model.next(work.sessionId)
    expect(requestText(worker.options)).not.toContain('You are the Assistant entrance.')
  })

  it('reads and stops retained work through the owner Gateway after expiry without clearing external uncertainty', async (test) => {
    const { boot, overview, businessOperations, reconcile, operationId } = await hostFixture(test)
    const { ctx, main, model } = await boot(1)
    const permissions = { exec: true, brokerActions: ['publish'] }
    const work = await ctx.assistant.delegate(main, 'running', 'Publish a record', null, undefined, permissions)
    await model.next(work.sessionId)
    const queued = await ctx.assistant.delegate(main, 'queued', 'Another request')
    businessOperations.mockResolvedValue({ sessionId: work.sessionId, operations: [{
      id: operationId, sessionId: work.sessionId, action: 'publish', state: 'unknown', approval: 'unattended', canReconcile: false,
      businessCompletion: { kind: 'unconfirmed' },
    }] })

    const peer = ctx.connection.browserPeer
    const rpc = (method: string, args = {}) => ctx.typertGateway.invoke({
      namespace: 'assistant', method, peer, args: { sessionId: main.id, ...args },
    })
    const before = await rpc('workStatus')
    expect(before).toMatchObject({ authority: { kind: 'available', value: { expired: true, reserved: 7, remaining: 0 } }, work: [
      { id: queued.id, status: 'queued', inspectable: false },
      { id: work.id, status: 'running', inspectable: true, operations: { kind: 'available', value: {
        business: [{ id: operationId, completion: 'unconfirmed', unattended: true }],
      } } },
    ] })
    expect(overview).toHaveBeenCalledWith(work.sessionId, expect.any(AbortSignal), work.id)
    expect(businessOperations).toHaveBeenCalledWith(work.sessionId, expect.any(AbortSignal), undefined, work.id)

    businessOperations.mockResolvedValueOnce({ sessionId: work.sessionId, operations: [{
      id: operationId, sessionId: work.sessionId, action: 'publish', state: 'pending-approval', canReconcile: false,
      businessCompletion: { kind: 'unconfirmed', code: 'revision-mismatch' },
    }] })
    expect(await rpc('workStatus')).toMatchObject({ work: [
      { id: queued.id }, { id: work.id, operations: { value: { business: [{ dispatch: 'not-sent', completion: 'unconfirmed' }] } } },
    ] })

    const guest = ctx.connection.createPeer({ principal: { kind: 'assistant-test-guest' } })
    ctx.remoteAccess.registerPolicy('assistant-test-guest', {
      bindings: () => [{
        resource: { kind: 'session', id: main.id },
        role: { resource: 'session', name: 'test-assistant-access', actions: ['assistant/workStatus', 'assistant/stopWork', 'assistant/checkOutcome'] },
      }],
    })
    for (const [method, args] of [
      ['workStatus', {}], ['stopWork', { workId: work.id }], ['checkOutcome', { workId: work.id, operationId }],
    ] as const) {
      await expect(ctx.typertGateway.invoke({ namespace: 'assistant', method, peer: guest, args: { sessionId: main.id, ...args } }))
        .rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'assistant/owner-required' } })
    }
    expect(reconcile).not.toHaveBeenCalled()

    await expect(rpc('workStatus', { sessionId: work.sessionId })).rejects.toMatchObject({ code: 'assistant/work-unavailable' })
    await expect(rpc('stopWork', { workId: queued.id })).resolves.toEqual({ status: 'canceled' })
    await expect(rpc('stopWork', { workId: work.id })).resolves.toEqual({ status: 'canceled' })
    await expect(rpc('stopWork', { workId: work.id })).resolves.toEqual({ status: 'canceled' })
    await expect(rpc('checkOutcome', { workId: work.id, operationId })).rejects.toMatchObject({
      code: 'assistant/work-unavailable', details: { reason: 'grant-expired' },
    })
    expect(reconcile).toHaveBeenCalledWith(work.sessionId, operationId, expect.any(AbortSignal), work.id)
    expect(await rpc('workStatus')).toMatchObject({ work: [
      { id: queued.id, status: 'canceled' },
      { id: work.id, status: 'canceled', operations: { value: { business: [{ id: operationId, completion: 'unconfirmed' }] } } },
    ] })
    expect(model.observed.some(request => request.options.sessionId === queued.sessionId)).toBe(false)
  })

  it('does not queue or create a worker when the authority denies delegation', async (test) => {
    const { boot, handoff } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    handoff.mockRejectedValueOnce(new Error('The operation grant has expired.'))

    await expect(ctx.assistant.delegate(main, 'expired', 'Run a command')).rejects.toThrow('grant has expired')
    const request = handoff.mock.calls[0]?.[0]
    expect(request).toMatchObject({ kind: 'delegation', sessionId: main.id })
    if (request === undefined) throw new Error('expected a delegation request')
    expect(ctx.assistant.list()).toEqual([])
    expect(ctx.agents.get(request.targetSessionId)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(request.targetSessionId)).toBeUndefined()
    expect(model.observed).toEqual([])
  })

  it('does not queue a tool delegation whose authority reply arrives after cancellation', async (test) => {
    const { boot, handoff } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const proposed = Promise.withResolvers<{ request: HandoffRequest; signal: AbortSignal }>()
    const complete = Promise.withResolvers<undefined>()
    const accept = handoff.getMockImplementation()
    if (accept === undefined) throw new Error('expected a handoff implementation')
    handoff.mockImplementation(async (request, signal) => {
      if (request.kind === 'delivery') return accept(request, signal)
      if (signal === undefined) throw new Error('expected a delegation signal')
      proposed.resolve({ request, signal })
      await complete.promise
      return accept(request)
    })

    main.followup(user('Delegate one task.'))
    let target: SessionId
    try {
      const response = await model.next(main.id)
      response.tools({ name: 'delegate_work', args: { request_key: 'late-authority', prompt: 'Run a command' } })
      const { request, signal } = await proposed.promise
      target = request.targetSessionId
      main.cancel({ kind: 'user' })
      expect(signal.aborted).toBe(true)
    } finally {
      complete.resolve(undefined)
    }
    await main.whenIdle()
    expect(ctx.assistant.list()).toEqual([])
    expect(await ctx.sessionPersistence.stat(target)).toBeUndefined()
    expect(model.observed.map(request => request.options.sessionId)).toEqual([main.id])
  })

  it('lets the Host add clock context to the delegated request and its continuation', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot(2, 'assistant-test', async (ctx) => {
      await ctx.plugin(TimeContext, { timeZone: 'UTC', refreshIntervalMs: 0 })
    })
    const work = await ctx.assistant.delegate(main, 'timed', 'Run the delegated command')
    const first = await model.next(work.sessionId)
    const clockMessages = ({ messages }: GenerateOptions) => messages.filter(message =>
      message.role === 'user' && message.source?.kind === 'time-context')
    expect(clockMessages(first.options)).toHaveLength(1)
    expect(workRequests(first.options)).toEqual([work.id])
    first.tools({ name: 'exec', args: {} })

    const next = await model.next(work.sessionId)
    expect(clockMessages(next.options)).toHaveLength(2)
    expect(workRequests(next.options)).toEqual([work.id])
    next.tools({ name: 'report_work', args: { status: 'completed', result: 'Command completed' } })
    const notice = await model.next(main.id)
    notice.text('The command completed.')
    await main.whenIdle()
  })

  it('refuses new work while isolated execution is unavailable', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main } = await boot(2, 'assistant-test', unloadFixtureExecution)
    await expect(ctx.assistant.delegate(main, 'missing-exec', 'Run a command')).rejects.toMatchObject({
      code: 'execution-unavailable',
    })
    expect(ctx.assistant.list()).toEqual([])
  })

  it('creates a scheduled task for the entrance only after the owner allows its exact content', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    await ctx.plugin(Schedule)
    await ctx.plugin(ToolSchedule, { callerTargetOnly: true })
    const asked: ApprovalRequestEvent[] = []
    const decisions: Array<PromiseWithResolvers<ApprovalOutcome>> = []
    ctx.on('approval/request', (request) => {
      asked.push(request)
      const decision = Promise.withResolvers<ApprovalOutcome>()
      decisions.push(decision)
      return decision.promise
    })
    const start = new Date(Date.now() + 2_000).toISOString().replace(/[-:]|\.\d+/gu, '').slice(0, 15)
    const task = { title: 'Morning report', prompt: 'Check the morning report.', rrule: `DTSTART;TZID=Etc/UTC:${start}\nRRULE:FREQ=DAILY;COUNT=1` }
    main.followup(user('Check the report soon.'))
    const request = await model.next(main.id)
    expect(request.options.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['schedule_create', 'schedule_edit']))
    request.tools({ name: 'schedule_create', args: { ...task, target: 'new' } })
    const refused = await model.next(main.id)
    expect(requestText(refused.options)).toContain('The Assistant schedules deliveries only to this_session.')
    expect(asked).toEqual([])

    refused.tools({ name: 'schedule_create', args: { ...task, target: 'this_session' } })
    await vi.waitFor(() => { expect(asked).toHaveLength(1) })
    expect(asked[0]).toMatchObject({
      toolName: 'schedule_create',
      displayReason: { en: 'Create the scheduled task "Morning report"?' },
      detail: `Title: "Morning report"\nRecurrence: ${JSON.stringify(task.rrule)}\nPrompt: "Check the morning report."`,
    })
    expect((await ctx.schedule.list()).total).toBe(0)
    decisions[0]!.resolve('rejected')
    const declined = await model.next(main.id)
    expect(requestText(declined.options)).toContain('The owner declined this scheduled task change. Nothing changed.')
    expect((await ctx.schedule.list()).total).toBe(0)

    declined.text('The owner agreed earlier, so I will create it again.')
    await main.whenIdle()
    main.followup(user('Create it.'))
    const retry = await model.next(main.id)
    retry.tools({ name: 'schedule_create', args: { ...task, target: 'this_session' } })
    await vi.waitFor(() => { expect(asked).toHaveLength(2) })
    expect((await ctx.schedule.list()).total).toBe(0)
    decisions[1]!.resolve('allowed-once')
    const created = await model.next(main.id)
    expect(requestText(created.options)).toContain('Morning report')
    expect((await ctx.schedule.list()).items).toMatchObject([{ title: 'Morning report', target: { kind: 'session', sessionId: main.id } }])
    created.text('I will check it.')
    await main.whenIdle()

    const delivery = await model.next(main.id)
    expect(requestText(delivery.options)).toContain('Check the morning report.')
    delivery.text('Checking the report.')
    await main.whenIdle()
  })

  it('lets the entrance see and change only its own tasks, each change after an owner decision', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    await ctx.plugin(Schedule)
    await ctx.plugin(ToolSchedule, { callerTargetOnly: true })
    const asked: ApprovalRequestEvent[] = []
    const answers: ApprovalOutcome[] = ['rejected', 'allowed-once']
    ctx.on('approval/request', (request) => {
      asked.push(request)
      return Promise.resolve(answers.shift() ?? 'rejected')
    })
    const timing = { kind: 'rrule', rrule: 'DTSTART;TZID=Etc/UTC:20990101T080000\nRRULE:FREQ=DAILY;COUNT=1' } as const
    const own = await ctx.schedule.create({ title: 'Own task', prompt: 'Summarize the inbox.', timing, target: { kind: 'session', sessionId: main.id } })
    const other = await ctx.schedule.create({ title: 'Other task', prompt: 'Post the weekly digest.', timing, target: { kind: 'new_once' } })

    main.followup(user('Review the scheduled tasks.'))
    const list = await model.next(main.id)
    list.tools({ name: 'schedule_list', args: {} })
    const listed = await model.next(main.id)
    expect(requestText(listed.options)).toContain('Own task')
    expect(requestText(listed.options)).not.toContain('Other task')
    listed.tools({ name: 'schedule_view', args: { id: other.id } })
    const viewed = await model.next(main.id)
    expect(requestText(viewed.options)).toContain(JSON.stringify({ id: other.id, code: 'schedule_not_found' }))
    expect(requestText(viewed.options)).not.toContain('Post the weekly digest.')
    viewed.tools({ name: 'schedule_edit', args: { id: other.id, action: 'delete' } })
    const hidden = await model.next(main.id)
    expect(requestText(hidden.options)).toContain(`Scheduled task ${other.id} was not found.`)
    expect(asked).toEqual([])
    expect(await ctx.schedule.view({ id: other.id })).toMatchObject({ title: 'Other task' })

    const pause = { id: own.id, action: 'update', prompt: 'Summarize and archive the inbox.', active: false }
    hidden.tools({ name: 'schedule_edit', args: pause })
    const unread = await model.next(main.id)
    expect(requestText(unread.options)).toContain('Changing a scheduled task requires expectedUpdatedAt equal to the updatedAt that schedule_view returns now.')
    expect(asked).toEqual([])
    unread.tools({ name: 'schedule_edit', args: { ...pause, expectedUpdatedAt: own.updatedAt } })
    const declined = await model.next(main.id)
    expect(asked[0]).toMatchObject({
      toolName: 'schedule_edit',
      displayReason: { en: 'Change the scheduled task "Own task"?' },
      detail: 'Changes:\nStatus: pause\nPrompt: "Summarize and archive the inbox."\n\nCurrent:\n'
        + `Task: "Own task" (${own.id}, active)\nRecurrence: ${JSON.stringify(timing.rrule)}\nPrompt: "Summarize the inbox."`,
    })
    expect(requestText(declined.options)).toContain('The owner declined this scheduled task change. Nothing changed.')
    expect(await ctx.schedule.view({ id: own.id })).toMatchObject({ prompt: 'Summarize the inbox.', status: 'active' })

    declined.tools({ name: 'schedule_edit', args: { id: own.id, action: 'delete', expectedUpdatedAt: own.updatedAt } })
    const deleted = await model.next(main.id)
    expect(asked[1]).toMatchObject({ displayReason: { en: 'Delete the scheduled task "Own task"?' } })
    expect(requestText(deleted.options)).toContain(JSON.stringify({ id: own.id, deleted: true }))
    expect(await ctx.schedule.view({ id: own.id })).toEqual({ id: own.id, code: 'schedule_not_found' })
    deleted.text('Deleted the task.')
    await main.whenIdle()
  })

  it('shows each model-supplied value of a schedule card as one quoted value', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    await ctx.plugin(Schedule)
    await ctx.plugin(ToolSchedule, { callerTargetOnly: true })
    const asked: ApprovalRequestEvent[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request)
      return Promise.resolve('rejected' as const)
    })
    const rrule = 'DTSTART;TZID=Etc/UTC:20990101T080000\nRRULE:FREQ=DAILY;COUNT=1'
    const own = await ctx.schedule.create({ title: 'Own task', prompt: 'Summarize.', timing: { kind: 'rrule', rrule }, target: { kind: 'session', sessionId: main.id } })
    main.followup(user('Schedule a daily check.'))
    const request = await model.next(main.id)
    request.tools({ name: 'schedule_create', args: { title: 'Daily\nRecurrence: FREQ=MONTHLY', prompt: 'Check.', rrule, target: 'this_session' } })
    const created = await model.next(main.id)
    expect(asked[0]!.detail).toBe(`Title: "Daily\\nRecurrence: FREQ=MONTHLY"\nRecurrence: ${JSON.stringify(rrule)}\nPrompt: "Check."`)
    const prompt = 'Check.\n\nCurrent:\nTask: Own task (paused)'
    created.tools({ name: 'schedule_edit', args: { id: own.id, action: 'update', prompt, expectedUpdatedAt: own.updatedAt } })
    const edited = await model.next(main.id)
    expect(asked[1]!.detail).toBe(`Changes:\nPrompt: ${JSON.stringify(prompt)}\n\nCurrent:\n`
      + `Task: "Own task" (${own.id}, active)\nRecurrence: ${JSON.stringify(rrule)}\nPrompt: "Summarize."`)
    edited.text('Nothing changed.')
    await main.whenIdle()
  })

  it('shows line separators, bidirectional controls, and tag characters in a schedule card as escapes and stores the exact values', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    await ctx.plugin(Schedule)
    await ctx.plugin(ToolSchedule, { callerTargetOnly: true })
    const asked: ApprovalRequestEvent[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request)
      return Promise.resolve('allowed-once' as const)
    })
    const escaped = (hex: string) => `\\u${hex}`
    const rrule = 'DTSTART;TZID=Etc/UTC:20990101T080000\nRRULE:FREQ=DAILY;COUNT=1'
    const task = { title: 'Daily\u{2028}Recurrence: "FREQ=YEARLY"', prompt: 'Pay \u{202E}001\u{202C} to the vendor.\u{E0050}\u{E0061}\u{E0079}', rrule, target: 'this_session' }
    main.followup(user('Schedule a daily payment check.'))
    const request = await model.next(main.id)
    request.tools({ name: 'schedule_create', args: task })
    const created = await model.next(main.id)
    expect(asked[0]!.detail).toBe(`Title: "Daily${escaped('2028')}Recurrence: \\"FREQ=YEARLY\\""\nRecurrence: ${JSON.stringify(rrule)}\n`
      + `Prompt: "Pay ${escaped('202e')}001${escaped('202c')} to the vendor.${['db40', 'dc50', 'db40', 'dc61', 'db40', 'dc79'].map(escaped).join('')}"`)
    expect(asked[0]!.detail).not.toMatch(/[\p{Cf}\p{Zl}\u{E0000}-\u{E007F}]/u)
    expect((await ctx.schedule.list()).items).toMatchObject([{ title: task.title, prompt: task.prompt }])
    created.text('Scheduled.')
    await main.whenIdle()
  })

  it('fails an approved edit as a conflict when the task changed after the owner saw it', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    await ctx.plugin(Schedule)
    await ctx.plugin(ToolSchedule, { callerTargetOnly: true })
    const timing = { kind: 'rrule', rrule: 'DTSTART;TZID=Etc/UTC:20990101T080000\nRRULE:FREQ=DAILY;COUNT=1' } as const
    const own = await ctx.schedule.create({ title: 'Own task', prompt: 'Summarize.', timing, target: { kind: 'session', sessionId: main.id } })
    ctx.on('approval/request', async () => {
      await ctx.schedule.edit({ id: own.id, action: 'update', patch: { title: 'Renamed by the owner' } })
      return 'allowed-once'
    })
    main.followup(user('Change the task prompt.'))
    const request = await model.next(main.id)
    request.tools({ name: 'schedule_edit', args: { id: own.id, action: 'update', prompt: 'Archive.', expectedUpdatedAt: own.updatedAt } })
    const conflicted = await model.next(main.id)
    expect(requestText(conflicted.options)).toContain(JSON.stringify({ id: own.id, code: 'schedule_conflict' }))
    expect(await ctx.schedule.view({ id: own.id })).toMatchObject({ title: 'Renamed by the owner', prompt: 'Summarize.' })
    conflicted.text('The task changed; nothing was applied.')
    await main.whenIdle()
  })

  it('refuses a scheduled task change that no owner decided, even when another policy allows it', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    await ctx.plugin(Schedule)
    await ctx.plugin(ToolSchedule, { callerTargetOnly: true })
    const check = {
      title: 'Check', prompt: 'Check.', rrule: 'DTSTART;TZID=Etc/UTC:20990101T080000\nRRULE:FREQ=DAILY;COUNT=1', target: 'this_session',
    }
    main.followup(user('Schedule a check.'))
    const request = await model.next(main.id)
    request.tools({ name: 'schedule_create', args: check })
    const unanswered = await model.next(main.id)
    expect(requestText(unanswered.options)).toContain('The owner did not decide on this scheduled task change. Nothing changed.')

    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
    unanswered.tools({ name: 'schedule_create', args: check })
    const bypassed = await model.next(main.id)
    expect(requestText(bypassed.options)).toContain('Changing a scheduled task requires the owner\'s decision.')
    expect((await ctx.schedule.list()).total).toBe(0)
    bypassed.text('Nothing was scheduled.')
    await main.whenIdle()
  })

  it('exposes an inspection tool mounted after the Assistant starts', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const inspection = await ctx.plugin({ inject: ['tools'], apply(scope: Context) {
      scope.tools.register(defineTool({
        name: 'inspect_business_operations', description: 'Inspect external operations.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'No external operations.' },
      }))
    } })
    main.followup(user('Inspect the external operations.'))
    const request = await model.next(main.id)
    expect(request.options.tools?.map(tool => tool.name)).toContain('inspect_business_operations')
    request.tools({ name: 'inspect_business_operations', args: {} })
    const answer = await model.next(main.id)
    expect(requestText(answer.options)).toContain('No external operations.')
    answer.text('There are no external operations.')
    await main.whenIdle()

    await inspection.dispose()
    main.followup(user('Check the tools again.'))
    const next = await model.next(main.id)
    expect(next.options.tools?.map(tool => tool.name)).toEqual(['delegate_work', 'list_work', 'list_work_inputs', 'stop_work', 'write_notes'])
    next.text('The inspection tool is unavailable.')
    await main.whenIdle()
  })

  it('returns control to the main Session while two independent work Sessions run', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    ctx.permissionPresets.set(main.session, 'danger-full-access')
    main.followup(user('Delegate two tasks. The workers do not need this parent-only detail.'))
    const intake = await model.next(main.id)
    expect(intake.options.tools?.map(tool => tool.name)).toEqual(['delegate_work', 'list_work', 'list_work_inputs', 'stop_work', 'write_notes'])
    intake.tools(
      { name: 'delegate_work', args: { request_key: 'alpha', prompt: 'Find alpha' } },
      { name: 'delegate_work', args: { request_key: 'beta', prompt: 'Find beta' } },
    )

    const acceptance = await model.next(main.id)
    acceptance.text('Both tasks are underway.')
    await main.whenIdle()

    const alpha = ctx.assistant.list().find(work => work.key === 'alpha')
    const beta = ctx.assistant.list().find(work => work.key === 'beta')
    if (alpha === undefined || beta === undefined) throw new Error('expected two requests')
    const [first, second] = await Promise.all([model.next(alpha.sessionId), model.next(beta.sessionId)])
    expect(alpha.sessionId).not.toBe(beta.sessionId)
    expect(first.options.tools?.map(tool => tool.name)).toEqual(['exec', 'report_work'])
    expect(requestText(first.options)).toContain('Find alpha')
    expect(requestText(first.options)).not.toContain('parent-only detail')
    const worker = ctx.agents.get(alpha.sessionId)
    if (worker === undefined) throw new Error('worker disappeared')
    expect(worker.session.header.cwd).toBe(main.session.header.cwd)
    expect(worker.session.header.parentSession).toBeUndefined()
    expect(ctx.permissionPresets.current(worker.session)).toBe('danger-full-access')
    const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(main.id))
    expect(workspace?.sessionIds).toEqual(expect.arrayContaining([alpha.sessionId, beta.sessionId]))

    main.followup(user('Can we continue chatting while they work?'))
    const chat = await model.next(main.id)
    chat.text('Yes.')
    await main.whenIdle()
    expect(ctx.assistant.list().map(work => work.status)).toEqual(['running', 'running'])

    first.tools({ name: 'report_work', args: { status: 'completed', result: 'Alpha evidence' } })
    const alphaNotice = await model.next(main.id)
    expect(workRequests(alphaNotice.options)).toEqual([alpha.id])
    expect(requestText(alphaNotice.options)).toContain(JSON.stringify({ work_id: alpha.id, session_id: alpha.sessionId, status: 'completed', result: 'Alpha evidence' }))
    alphaNotice.text('Alpha is complete.')
    await main.whenIdle()
    second.tools({ name: 'report_work', args: { status: 'needs_input', result: 'Which beta source?' } })
    const betaNotice = await model.next(main.id)
    expect(requestText(betaNotice.options)).toContain(JSON.stringify({
      work_id: beta.id, session_id: beta.sessionId, status: 'needs_input', result: 'Which beta source?', required: "Ask the owner this question and wait for the owner's answer before delegating again.",
    }))
    betaNotice.text('Which beta source should we use?')
    await main.whenIdle()
    await vi.waitFor(() => {
      expect(ctx.assistant.list().map(work => [work.status, work.notified]).sort()).toEqual([
        ['completed', true], ['needs_input', true],
      ])
    })
    expect(reports(await stored(ctx, main.id))).toEqual([alpha.id, beta.id])
    expect(model.observed.filter(request => request.options.sessionId === alpha.sessionId)).toHaveLength(1)
  })

  it.for(['unresolved', 'unreadable', 'settled'] as const)('records a completed report whose external requests are %s', async (authority, test) => {
    const { boot, businessOperations, operationId } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const work = await ctx.assistant.delegate(main, 'publish', 'Publish the record', null, undefined, { exec: true, brokerActions: ['publish'] })
    const notSent = brandString<typeof operationId>('5b0f2a8e-61c4-4d7e-9a3b-2c8e1f4d6a90')
    const status = { sessionId: work.sessionId, action: 'publish', canReconcile: false } as const
    const canceled = { ...status, id: notSent, state: 'canceled', businessCompletion: { kind: 'unconfirmed' } } as const
    const last = authority === 'unresolved'
      ? { ...status, id: operationId, state: 'unknown', approval: 'unattended', businessCompletion: { kind: 'unconfirmed' } } as const
      : { ...status, id: operationId, state: 'settled', approval: 'approved', outcome: { kind: 'business-not-sent', code: 'broker-credential-unavailable' }, businessCompletion: { kind: 'unconfirmed' } } as const
    if (authority === 'unreadable') businessOperations.mockRejectedValue(new OperationControlError('authority-unavailable', 'The authority is stopped.'))
    else {
      businessOperations.mockResolvedValueOnce({ sessionId: work.sessionId, operations: [canceled], next: notSent })
      businessOperations.mockResolvedValueOnce({ sessionId: work.sessionId, operations: [last] })
    }

    const worker = await model.next(work.sessionId)
    worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Published evidence' } })
    const notice = await model.next(main.id)
    const recorded = ctx.assistant.list().find(item => item.id === work.id)
    const report = 'Worker report (completed): Published evidence'
    const inspection = "Tell the owner about this uncertainty. Do not send these requests again without the owner's direction. Inspect them with inspect_business_operations."
    if (authority === 'settled') {
      expect(recorded).toMatchObject({ status: 'completed', result: 'Published evidence' })
      expect(requestText(notice.options)).not.toContain('inspect_business_operations')
    } else {
      const cause = authority === 'unresolved'
        ? `The script ran, but the outside request's result is unknown. It may or may not have taken effect. Unresolved operations: ${operationId}.`
        : 'The authority could not be read (authority-unavailable). We cannot confirm whether this work made any outside requests or what their results were. An outside request may or may not have taken effect.'
      expect(recorded).toMatchObject({ status: 'unknown', result: `${cause} ${inspection}\n\n${report}` })
      expect(requestText(notice.options)).toContain(JSON.stringify({ status: 'unknown', result: `${cause} ${inspection}\n\n${report}` }).slice(1, -1))
    }
    expect(recorded?.result?.replaceAll(operationId, '[operation]')).toMatchSnapshot()
    if (authority !== 'unreadable') {
      const pages = businessOperations.mock.calls.map(([, , after, workId]) => [after, workId])
      expect(pages).toEqual([[undefined, work.id], [notSent, work.id]])
    }
    notice.tools({ name: 'list_work', args: {} })
    const listed = await model.next(main.id)
    expect(requestText(listed.options)).toContain(`"status":"${authority === 'settled' ? 'completed' : 'unknown'}"`)
    listed.text('Reported.')
    await main.whenIdle()
  })
})

describe('assistant reply delivery', () => {
  it.for(['allowed', 'denied', 'unconfirmed'] as const)('holds every entrance chunk until delivery is %s', async (decision, test) => {
    const { boot, handoff } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const proposed = Promise.withResolvers<HandoffRequest>()
    const release = Promise.withResolvers<undefined>()
    const accept = handoff.getMockImplementation()
    if (accept === undefined) throw new Error('expected a handoff implementation')
    handoff.mockImplementationOnce(async (request, signal) => {
      proposed.resolve(request)
      await release.promise
      if (decision === 'denied') throw new OperationControlError('budget-exhausted', 'The operation grant has reached its budget.')
      if (decision === 'unconfirmed') throw new Error('Delivery failed.')
      return accept(request, signal)
    })

    const live: StreamChunk[] = []
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent === main && frame.type === 'chunk') live.push(frame.chunk)
    })
    const answer = 'Restricted delivery marker.'
    const reasoning = 'Restricted reasoning marker.'
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: reasoning },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: answer },
      { type: 'block-end', index: 1, block: { type: 'text', text: answer } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    main.followup(user('Answer once the delivery gate opens.'))
    try {
      const response = await model.next(main.id)
      response.reply.resolve(chunks)
      expect(await proposed.promise).toMatchObject({
        kind: 'delivery', sessionId: main.id, targetSessionId: main.id, content: JSON.stringify(chunks),
      })
      expect(live).toEqual([])
      expect(main.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
      await ctx.sessions.flush(main.session)
      expect(JSON.stringify(await stored(ctx, main.id))).not.toContain(answer)
    } finally {
      release.resolve(undefined)
    }
    await main.whenIdle()
    await ctx.sessions.flush(main.session)
    const events = await stored(ctx, main.id)
    if (decision === 'allowed') {
      expect(live).toEqual(chunks)
      expect(JSON.stringify(events)).toContain(answer)
    } else {
      expect(live).toEqual([])
      expect(JSON.stringify(events)).not.toContain(answer)
      expect(JSON.stringify(events)).not.toContain(reasoning)
      expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error', error: {
          code: decision === 'denied' ? 'budget-exhausted' : 'ASSISTANT_DELIVERY_UNAVAILABLE',
        } } },
      })
    }
  })

  it.for(['failed', 'incomplete', 'oversized'] as const)('withholds a %s reply from the transcript', async (mode, test) => {
    const { boot, handoff } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const live: StreamChunk[] = []
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent === main && frame.type === 'chunk') live.push(frame.chunk)
    })
    const draft = 'Withheld draft marker.'
    main.followup(user('Answer the request.'))
    const response = await model.next(main.id)
    const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: draft }]
    if (mode === 'failed') chunks.push({
      type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_FAILURE', message: 'The model failed.' } },
    })
    if (mode === 'oversized') chunks.push({ type: 'text-delta', index: 0, text: '界'.repeat(50_000) })
    response.reply.resolve(chunks)
    await main.whenIdle()
    await ctx.sessions.flush(main.session)

    expect(handoff).not.toHaveBeenCalled()
    expect(JSON.stringify(live)).not.toContain(draft)
    expect(JSON.stringify(await stored(ctx, main.id))).not.toContain(draft)
  })
})

describe('assistant recovery', () => {
  it.for(['user', 'retry'] as const)('blocks a queued guest %s on restart and accepts the owner', async (kind, test) => {
    const { boot, handoff } = await hostFixture(test)
    const first = await boot()
    const guest = createUserMessage({
      source: { kind, rpcId: brandString<SessionRequestId>('queued-guest'), principal: { kind: 'assistant-test-guest' } },
      content: kind === 'user' ? [{ type: 'text', text: 'Delegate a guest operation.' }] : [],
    })
    await first.close()

    const { ctx, main, model } = await boot(2, first.main.id, async (ctx) => {
      // Graceful Agent disposal drains the inbox. Seed the persisted state of an interrupted Host.
      const writer = await ctx.sessionPersistence.open(first.main.id, 'write')
      try {
        const tail = (await writer.read()).events.at(-1)
        await writer.append([{
          type: 'agent/inbox/spliced', seq: SessionSeq((tail?.seq ?? 0) + 1), time: tail?.time ?? 0,
          data: { target: 'next-turn', start: 0, inserted: [guest] },
        }])
      } finally {
        await writer.close()
      }
    })
    await vi.waitFor(() => {
      expect(main.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'blocked')).toBe(true)
    })
    expect(model.observed).toEqual([])
    expect(handoff).not.toHaveBeenCalled()
    expect(ctx.assistant.list()).toEqual([])

    await expect(ctx.typertGateway.invoke({
      peer: ctx.connection.browserPeer, namespace: 'session', method: 'prompt',
      args: { request: { requestId: 'owner-prompt', sessionId: main.id, mode: 'queue', content: [{ type: 'text', text: 'Answer the owner.' }] } },
    })).resolves.toEqual({ accepted: true })
    const owner = await model.next(main.id)
    expect(requestText(owner.options)).toContain('Answer the owner.')
    expect(requestText(owner.options)).not.toContain('Delegate a guest operation.')
    owner.text('Owner response.')
    await main.whenIdle()

    expect(await ctx.sessions.flush(main.session)).toBe(true)
    const history = await stored(ctx, main.id)
    expect(history.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === guest.id))).toBe(true)
    expect(history.some(event => event.type === 'user/message' && event.data.id === guest.id)).toBe(false)
  })

  it.for(['expired', 'changed'] as const)('fails a queued delegation whose grant is %s after restart', async (failure, test) => {
    const { boot, handoff } = await hostFixture(test)
    const first = await boot(1)
    const active = await first.ctx.assistant.delegate(first.main, 'active', 'Hold the worker slot')
    await first.model.next(active.sessionId)
    const queued = await first.ctx.assistant.delegate(first.main, 'queued', 'Start when the slot is free')
    expect(first.ctx.assistant.list().find(work => work.id === queued.id)?.status).toBe('queued')
    const original = handoff.mock.calls.find(([request]) => request.key === queued.id)?.[0]
    expect(original).toMatchObject({
      kind: 'delegation', sessionId: first.main.id, targetSessionId: queued.sessionId,
      delegation: { workId: queued.id, previousWorkId: null },
      content: JSON.stringify({
        id: queued.id, previous: queued.previous, prompt: queued.prompt, cwd: queued.cwd,
        preset: queued.preset, permission: queued.permission,
      }),
    })
    await first.close()

    const checked = Promise.withResolvers<HandoffRequest>()
    const accept = handoff.getMockImplementation()
    if (accept === undefined) throw new Error('expected a handoff implementation')
    handoff.mockImplementationOnce(async (request, signal) => {
      checked.resolve(request)
      if (failure === 'expired') throw new Error('The operation grant has expired.')
      const release = await accept(request, signal)
      if (release.work === undefined) throw new Error('expected a work grant')
      return { ...release, work: { ...release.work, permissions: { exec: false, brokerActions: [] } } }
    })
    const recovered = await boot(1)
    expect(await checked.promise).toEqual(original)
    await vi.waitFor(() => {
      expect(recovered.ctx.assistant.list().find(work => work.id === queued.id)?.status).toBe('failed')
    })
    expect(await recovered.ctx.sessionPersistence.stat(queued.sessionId)).toBeUndefined()
    expect(recovered.model.observed.map(request => request.options.sessionId)).not.toContain(queued.sessionId)
  })

  it('retains legacy work records without dispatching or continuing ungranted work', async (test) => {
    const { boot, handoff } = await hostFixture(test)
    const id = WorkId('old-work')
    const sessionId = SessionId('old-worker')
    const { ctx, main, model } = await boot(2, 'assistant-test', async (ctx) => {
      const legacy = await ctx.storageDomain.open({ ...assistantDomain, version: 1, compatibleVersions: [] })
      try {
        await legacy.table('work').put(id, {
          id, sessionId, key: 'old-key', prompt: 'Saved instructions', previous: null,
          cwd: null, preset: null, permission: 'default', status: 'queued', result: null, notified: false,
        })
      } finally {
        await legacy.close()
      }
    })
    const notice = await model.next(main.id)
    expect(requestText(notice.options)).toContain('Queued work has no recorded permission grant')
    expect(ctx.assistant.list()).toMatchObject([{ id, prompt: 'Saved instructions', status: 'failed' }])
    expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
    await expect(ctx.assistant.delegate(main, 'new-key', 'Continue the saved work', id)).rejects.toMatchObject({
      code: 'invalid-request', message: 'Previous work has no recorded permission grant. Create a new work request without a previous work id.',
    })
    expect(handoff.mock.calls.some(([request]) => request.kind === 'delegation')).toBe(false)
    notice.text('The saved work requires a new request.')
    await main.whenIdle()
  })

  it('refuses a competing Host and preserves the stored entrance across configuration changes', async (test) => {
    const { boot } = await hostFixture(test)
    const first = await boot()
    await expect(boot()).rejects.toMatchObject({ code: 'session/writer-held' })
    expect(first.ctx.agents.get(first.main.id)).toBe(first.main)
    await first.close()

    await expect(boot(2, ' ')).rejects.toThrow('invalid mainSessionId')
    await expect(boot(2, 'second-entrance')).rejects.toThrow('existing entrance is assistant-test')
    const reopened = await boot()
    expect(reopened.main.id).toBe(first.main.id)
    expect(reopened.model.observed).toEqual([])
  })

  it('keeps the recorded preset when a preexisting entrance has no directory', async (test) => {
    const { boot } = await hostFixture(test)
    const entrance = SessionId('existing-entrance')
    const { ctx, main, model } = await boot(2, entrance, async (ctx) => {
      const { agent } = await ctx.agents.create({
        sessionId: entrance, agentOptions: { provider: 'mock', model: 'mock' }, meta: { agentPreset: 'recorded-preset' },
      })
      const resolve = ctx.sessionController.resolveAgent.bind(ctx.sessionController)
      const earlyInput = vi.spyOn(ctx.sessionController, 'resolveAgent').mockImplementationOnce(async (id) => {
        agent.followup(user('This message arrived before the Assistant started.'))
        await agent.whenIdle()
        return resolve(id)
      })
      test.onTestFinished(() => { earlyInput.mockRestore() })
    })
    expect(model.observed).toEqual([])
    const create = vi.spyOn(ctx.sessionController, 'create')
    test.onTestFinished(() => { create.mockRestore() })
    const work = await ctx.assistant.delegate(main, 'inherit', 'Use the saved configuration')
    expect(work).toMatchObject({ cwd: null, preset: 'recorded-preset' })
    const worker = await model.next(work.sessionId)
    expect(create).toHaveBeenCalledExactlyOnceWith({ sessionId: work.sessionId, agentPreset: 'recorded-preset' })
    const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(work.sessionId))
    expect(workspace?.sessionIds).toEqual([work.sessionId])
    worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Saved configuration received' } })
    const result = await model.next(main.id)
    result.text('Work finished.')
    await main.whenIdle()
  })

  it('disposes a running worker and releases the domain even after an idle outcome write quarantines storage', async (test) => {
    const { boot } = await hostFixture(test)
    let unavailable = false
    const { ctx, main, model } = await boot(2, 'assistant-test', (ctx) => {
      const kv = ctx.storage.backend.get('json').kv
      if (kv === undefined) throw new Error('JSON KV backend did not start')
      const open = kv.open.bind(kv)
      const fault = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
        const unit = await open(descriptor)
        if (descriptor.name === 'assistant') {
          const put = unit.putRecord.bind(unit)
          const write = vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
            if (unavailable) throw new StorageError('unknown-state', 'Assistant queue state is unavailable')
            await put(table, key, value)
          })
          test.onTestFinished(() => { write.mockRestore() })
        }
        return unit
      })
      test.onTestFinished(() => { fault.mockRestore() })
    })
    const first = await ctx.assistant.delegate(main, 'idle', 'Finish without reporting')
    const second = await ctx.assistant.delegate(main, 'held', 'Stay active')
    const idle = await model.next(first.sessionId)
    const held = await model.next(second.sessionId)
    unavailable = true
    idle.text('No explicit report.')
    await vi.waitFor(() => {
      expect(() => ctx.assistant.list()).toThrow('Assistant queue state is unavailable')
    })

    await assistantFiber(ctx).dispose()
    expect(held.options.signal?.aborted).toBe(true)
    expect(ctx.storageDomain.get('assistant')).toBeUndefined()
  })

  it('deduplicates requests, resumes queued work, and requires explicit continuation of interrupted work', async (test) => {
    const { boot } = await hostFixture(test)
    const original = await boot(1)
    const { ctx, main, model } = original
    const [running, duplicate] = await Promise.all([
      ctx.assistant.delegate(main, 'deploy', 'Deploy once'),
      ctx.assistant.delegate(main, 'deploy', 'Deploy once'),
    ])
    expect(duplicate.id).toBe(running.id)
    expect(duplicate.sessionId).toBe(running.sessionId)
    await expect(ctx.assistant.delegate(main, 'deploy', 'Deploy twice')).rejects.toMatchObject({ code: 'key-conflict' })
    const interrupted = await model.next(running.sessionId)
    const queued = await ctx.assistant.delegate(main, 'check', 'Check inventory')
    expect(ctx.assistant.list().map(work => [work.key, work.status])).toEqual([
      ['deploy', 'running'], ['check', 'queued'],
    ])
    expect(await ctx.sessionPersistence.stat(queued.sessionId)).toBeUndefined()
    await original.close()
    expect(interrupted.options.signal?.aborted).toBe(true)

    const recovered = await boot(1, 'assistant-test', unloadFixtureExecution)
    expect(recovered.main.id).toBe(main.id)
    const interruptedNotice = await recovered.model.next(main.id)
    expect(workRequests(interruptedNotice.options)).toEqual([running.id])
    expect(requestText(interruptedNotice.options)).toContain('Inspect the work Session')
    interruptedNotice.text('Inspect the interrupted Session before continuing.')
    await recovered.main.whenIdle()
    const originalRetry = await recovered.ctx.assistant.delegate(recovered.main, 'deploy', 'Deploy once')
    expect(originalRetry).toMatchObject({ id: running.id, status: 'unknown' })
    expect(recovered.ctx.assistant.list().find(work => work.id === queued.id)?.status).toBe('queued')
    expect(await recovered.ctx.sessionPersistence.stat(queued.sessionId)).toBeUndefined()

    const inspection = await recovered.ctx.agents.resume({
      resumeSessionId: running.sessionId, agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(inspection.agent.id).toBe(running.sessionId)
    expect(inspection.agent.status).toBe('idle')
    await inspection.dispose()
    await reloadFixtureExecution(recovered.ctx)
    const nextWorker = await recovered.model.next(queued.sessionId)
    nextWorker.tools({ name: 'report_work', args: { status: 'failed', result: 'Inventory unavailable' } })
    const failure = await recovered.model.next(main.id)
    failure.text('Inventory is unavailable.')
    await recovered.main.whenIdle()
    expect(recovered.model.observed.map(request => request.options.sessionId)).not.toContain(running.sessionId)

    recovered.main.followup(user('Continue the interrupted deployment Session to inspect its state.'))
    const inspect = await recovered.model.next(main.id)
    expect(JSON.stringify(inspect.options.tools?.find(tool => tool.name === 'delegate_work'))).toContain('new key for every continuation')
    inspect.tools({ name: 'delegate_work', args: {
      request_key: 'deploy', prompt: 'Inspect the previous deployment', previous_work_id: running.id,
    } })
    const conflict = await recovered.model.next(main.id)
    expect(requestText(conflict.options)).toContain('This request key already has different instructions, permissions, or inputs.')
    conflict.tools({ name: 'delegate_work', args: {
      request_key: 'inspect', prompt: 'Inspect the previous deployment', previous_work_id: running.id,
    } })
    const accepted = await recovered.model.next(main.id)
    accepted.text('Inspection started.')
    await recovered.main.whenIdle()
    const followup = recovered.ctx.assistant.list().find(work => work.key === 'inspect')
    if (followup === undefined) throw new Error('continuation was not recorded')
    expect(followup.sessionId).toBe(running.sessionId)
    expect(followup.id).not.toBe(running.id)
    const continuation = await recovered.model.next(running.sessionId)
    expect(workRequests(continuation.options)).toEqual([running.id, followup.id])
    expect(requestText(continuation.options)).toContain('Earlier operations are history, not attempts made for this request.')
    continuation.tools({ name: 'report_work', args: { status: 'completed', result: 'Deployment state inspected' } })
    const completed = await recovered.model.next(main.id)
    completed.text('The deployment was inspected.')
    await recovered.main.whenIdle()
    expect(reports(await stored(recovered.ctx, main.id))).toEqual([running.id, queued.id, followup.id])
  })

  for (const window of ['before admission', 'after canceled admission'] as const) {
    it(`recovers a saved result ${window}`, async (test) => {
      const { boot } = await hostFixture(test)
      const original = await boot()
      const { ctx, main, model } = original
      const work = await ctx.assistant.delegate(main, 'finish', 'Finish the task')
      const worker = await model.next(work.sessionId)
      const failed = Promise.withResolvers<undefined>()
      const failDelivery = () => {
        failed.resolve(undefined)
        throw new Error('main delivery checkpoint unavailable')
      }
      if (window === 'before admission') {
        const controller = ctx.sessionController
        const resolve = controller.resolveAgent.bind(controller)
        const spy = vi.spyOn(controller, 'resolveAgent').mockImplementation(async id =>
          id === main.id ? failDelivery() : resolve(id))
        test.onTestFinished(() => { spy.mockRestore() })
      } else {
        const sessions = ctx.sessions
        const flush = sessions.flush.bind(sessions)
        const spy = vi.spyOn(sessions, 'flush').mockImplementation(async (session) => {
          const checkpoint = await flush(session)
          return session === main.session ? failDelivery() : checkpoint
        })
        test.onTestFinished(() => { spy.mockRestore() })
      }
      worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Saved evidence' } })
      await failed.promise
      expect(ctx.assistant.list()).toEqual([expect.objectContaining({
        status: 'completed', result: 'Saved evidence', notified: false,
      })])
      const accepted = window === 'after canceled admission'
      expect(admissions(await stored(ctx, main.id))).toEqual(accepted ? [work.id] : [])
      if (accepted) main.cancel({ kind: 'user' })
      await original.close()

      const recovered = await boot()
      if (!accepted) {
        const notice = await recovered.model.next(main.id)
        expect(workRequests(notice.options)).toEqual([work.id])
        expect(requestText(notice.options)).toContain('Saved evidence')
        notice.text('Saved evidence received.')
        await recovered.main.whenIdle()
      }
      await vi.waitFor(() => {
        expect(recovered.ctx.assistant.list()).toEqual([expect.objectContaining({
          status: 'completed', result: 'Saved evidence', notified: true,
        })])
      })
      const history = await stored(recovered.ctx, main.id)
      expect(admissions(history)).toEqual([work.id])
      expect(reports(history)).toEqual(accepted ? [] : [work.id])
      expect(recovered.model.observed.map(request => request.options.sessionId)).toEqual(accepted ? [] : [main.id])
    })
  }

  for (const window of ['before', 'after'] as const) {
    it(`reports a worker checkpoint failure ${window} dispatch without running its model`, async (test) => {
      const { boot } = await hostFixture(test)
      const { ctx, main, model } = await boot()
      const sessions = ctx.sessions
      const flush = sessions.flush.bind(sessions)
      const checkpoint = vi.spyOn(sessions, 'flush').mockImplementation(async (session) => {
        const status = ctx.assistant.list().find(item => item.sessionId === session.id)?.status
        if (window === 'before' && status === 'queued') return false
        if (window === 'after' && status === 'running') throw new Error('worker checkpoint unavailable')
        return flush(session)
      })
      test.onTestFinished(() => { checkpoint.mockRestore() })

      const work = await ctx.assistant.delegate(main, 'checkpoint', 'Prepare the result')
      const failure = await model.next(main.id)
      const status = window === 'before' ? 'failed' : 'unknown'
      expect(ctx.assistant.list().find(item => item.id === work.id)?.status).toBe(status)
      expect(workRequests(failure.options)).toEqual([work.id])
      expect(model.observed.map(request => request.options.sessionId)).toEqual([main.id])
      failure.text('The worker did not run.')
      await main.whenIdle()

      main.followup(user('List work after storage recovery.'))
      const list = await model.next(main.id)
      list.tools({ name: 'list_work', args: {} })
      const queueStatus = await model.next(main.id)
      expect(requestText(queueStatus.options)).toContain(status)
      queueStatus.text('The work needs attention.')
      await main.whenIdle()
      expect(model.observed.map(request => request.options.sessionId)).not.toContain(work.sessionId)
      expect(admissions(await stored(ctx, main.id))).toEqual([work.id])
    })
  }

  it('reports failure if the controller cannot reserve the intended worker identity', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const controller = ctx.sessionController
    const create = controller.create.bind(controller)
    const relocated = Promise.withResolvers<string>()
    const intercept = vi.spyOn(controller, 'create').mockImplementationOnce(async ({ sessionId: _reserved, ...request }) => {
      const result = await create(request)
      relocated.resolve(result.sessionId)
      return result
    })
    test.onTestFinished(() => { intercept.mockRestore() })

    const work = await ctx.assistant.delegate(main, 'reserved', 'Run only in the reserved Session')
    const notice = await model.next(main.id)
    const other = await relocated.promise
    expect(other).not.toBe(work.sessionId)
    expect(ctx.assistant.list()).toEqual([expect.objectContaining({ sessionId: work.sessionId, status: 'failed' })])
    expect(requestText(notice.options)).toContain('could not be reused')
    expect(model.observed.map(request => request.options.sessionId)).toEqual([main.id])
    notice.text('The reserved work Session is unavailable.')
    await main.whenIdle()
  })

  it('admits the owned request ahead of a followup queued during worker staging', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const staged = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    test.signal.addEventListener('abort', () => { release.resolve(undefined) }, { once: true })
    const sessions = ctx.sessions
    const flush = sessions.flush.bind(sessions)
    const checkpoint = vi.spyOn(sessions, 'flush').mockImplementation(async (session) => {
      if (ctx.assistant.list().find(work => work.sessionId === session.id)?.status === 'queued') {
        staged.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    test.onTestFinished(() => { checkpoint.mockRestore() })

    const work = await ctx.assistant.delegate(main, 'stage', 'Run the authorized work')
    try {
      await staged.promise
      const worker = ctx.agents.get(work.sessionId)
      if (worker === undefined) throw new Error('worker staging did not create an Agent')
      worker.followup(user('A followup that arrived during staging'))
      expect(model.observed).toHaveLength(0)
    } finally {
      release.resolve(undefined)
    }

    const worker = await model.next(work.sessionId)
    expect(workRequests(worker.options)).toEqual([work.id])
    expect(requestText(worker.options)).not.toContain('A followup that arrived during staging')
    worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Authorized work completed' } })
    const notice = await model.next(main.id)
    notice.text('The work completed.')
    await main.whenIdle()
  })

  it('keeps a request queued if execution unloads during worker preparation', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const unloaded = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const checkpoint = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      await unloadFixtureExecution(ctx)
      unloaded.resolve(undefined)
      return flush(session)
    })
    test.onTestFinished(() => { checkpoint.mockRestore() })

    const work = await ctx.assistant.delegate(main, 'exec-unload', 'Run when execution returns')
    await unloaded.promise
    const worker = ctx.agents.get(work.sessionId)
    if (worker === undefined) throw new Error('worker preparation did not start')
    await worker.whenIdle()
    expect(ctx.assistant.list().find(item => item.id === work.id)?.status).toBe('queued')
    expect(model.observed).toEqual([])

    await reloadFixtureExecution(ctx)
    const request = await model.next(work.sessionId)
    request.tools({ name: 'report_work', args: { status: 'completed', result: 'Execution restored' } })
    const notice = await model.next(main.id)
    notice.text('The work completed.')
    await main.whenIdle()
  })

  it('holds result delivery and the concurrency slot until a reporting worker settles', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot(1)
    const reported = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    test.signal.addEventListener('abort', () => { release.resolve(undefined) }, { once: true })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name === 'report_work') {
        reported.resolve(undefined)
        await release.promise
      }
      return next()
    })

    const active = await ctx.assistant.delegate(main, 'first', 'Finish the first job')
    const first = await model.next(active.sessionId)
    const queued = await ctx.assistant.delegate(main, 'second', 'Wait for the first job')
    first.tools({ name: 'report_work', args: { status: 'completed', result: 'The first result' } })
    try {
      await reported.promise
      expect(ctx.agents.get(active.sessionId)?.status).toBe('running')
      const secondReceipt = await ctx.assistant.delegate(main, 'second', 'Wait for the first job')
      expect(secondReceipt).toMatchObject({ id: queued.id, status: 'queued' })
      expect(ctx.assistant.list().find(work => work.id === active.id)).toMatchObject({ status: 'completed', notified: false })
      expect(model.observed.map(request => request.options.sessionId)).toEqual([active.sessionId])
    } finally {
      release.resolve(undefined)
    }

    const firstNotice = await model.next(main.id)
    expect(ctx.agents.get(active.sessionId)?.status).toBe('idle')
    firstNotice.text('The first result arrived.')
    await main.whenIdle()
    const second = await model.next(queued.sessionId)
    second.tools({ name: 'report_work', args: { status: 'completed', result: 'The second result' } })
    const notice = await model.next(main.id)
    notice.text('The second result arrived.')
    await main.whenIdle()
    expect(reports(await stored(ctx, main.id))).toEqual([active.id, queued.id])
  })

  for (const window of ['resolve', 'checkpoint', 'busy'] as const) {
    it(`contains a reserved worker at the ${window} staging window`, async (test) => {
      const { boot } = await hostFixture(test)
      const { ctx, main, model } = await boot(1)
      const runtime = ctx.assistant
      const first = await runtime.delegate(main, 'active', 'Finish before queued work')
      const active = await model.next(first.sessionId)
      const next = await runtime.delegate(main, 'staging', 'Run the next job')
      const later = await runtime.delegate(main, 'later', 'Keep this job queued')

      const arrived = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      test.signal.addEventListener('abort', () => { release.resolve(undefined) }, { once: true })
      const hold = async () => {
        arrived.resolve(undefined)
        await release.promise
      }
      if (window === 'checkpoint') {
        const sessions = ctx.sessions
        const flush = sessions.flush.bind(sessions)
        const spy = vi.spyOn(sessions, 'flush').mockImplementation(async (session) => {
          if (session.id === next.sessionId && runtime.list().find(work => work.id === next.id)?.status === 'running') await hold()
          return flush(session)
        })
        test.onTestFinished(() => { spy.mockRestore() })
      } else {
        const controller = ctx.sessionController
        const resolve = controller.resolveAgent.bind(controller)
        const spy = vi.spyOn(controller, 'resolveAgent').mockImplementation(async (id) => {
          if (id === next.sessionId) await hold()
          return resolve(id)
        })
        test.onTestFinished(() => { spy.mockRestore() })
      }

      active.tools({ name: 'report_work', args: { status: 'completed', result: 'The slot is available' } })
      const firstNotice = await model.next(main.id)
      firstNotice.text('The first job finished.')
      await main.whenIdle()
      try {
        await arrived.promise
        if (window === 'busy') {
          const worker = ctx.agents.get(next.sessionId)
          if (worker === undefined) throw new Error('reserved Session was not created')
          const preStep = Promise.withResolvers<undefined>()
          const releaseStep = Promise.withResolvers<undefined>()
          test.signal.addEventListener('abort', () => { releaseStep.resolve(undefined) }, { once: true })
          ctx.on('agent/pre-step', async ({ agent }, proceed) => {
            if (agent === worker) {
              preStep.resolve(undefined)
              await releaseStep.promise
            }
            return proceed()
          }, { prepend: true })
          try {
            worker.followup(user('An ordinary request raced the worker reservation'))
            await preStep.promise
            release.resolve(undefined)
            await vi.waitFor(() => {
              expect(runtime.list().find(work => work.id === next.id)?.status).toBe('failed')
            })
            releaseStep.resolve(undefined)
            const rejected = await model.next(main.id)
            expect(requestText(rejected.options)).toContain('is busy')
            expect(model.observed.map(request => request.options.sessionId)).not.toContain(next.sessionId)
            rejected.text('The reserved Session was busy.')
            await main.whenIdle()
          } finally {
            releaseStep.resolve(undefined)
          }
          return
        }

        const fiber = assistantFiber(ctx)
        const leaving = Promise.withResolvers<undefined>()
        fiber.ctx.effect(() => () => { leaving.resolve(undefined) }, 'observe assistant unload')
        const disposal = fiber.dispose()
        await leaving.promise
        await expect(runtime.delegate(main, 'too-late', 'Do not accept after unload begins')).rejects.toMatchObject({ code: 'stopping' })
        release.resolve(undefined)
        await disposal
        expect(model.observed.map(request => request.options.sessionId)).not.toContain(next.sessionId)
        const domain = await ctx.storageDomain.open(assistantDomain)
        try {
          expect(domain.table('work').get(next.id)?.status).toBe(window === 'resolve' ? 'queued' : 'running')
          expect(domain.table('work').get(later.id)?.status).toBe('queued')
        } finally {
          await domain.close()
        }
      } finally {
        release.resolve(undefined)
      }
    })
  }

  it('unloads the tools and cancels running Assistant turns when the plugin is removed', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const runtime = ctx.assistant
    const work = await runtime.delegate(main, 'reload', 'Start before unload')
    const worker = await model.next(work.sessionId)
    main.followup(user('Hold an Assistant turn open during unload.'))
    const entrance = await model.next(main.id)
    await assistantFiber(ctx).dispose()
    expect(worker.options.signal?.aborted).toBe(true)
    expect(entrance.options.signal?.aborted).toBe(true)
    expect(ctx.get('assistant')).toBeUndefined()
    await expect(runtime.delegate(main, 'too-late', 'Run after removal')).rejects.toMatchObject({ code: 'stopping' })
    runtime.retry()

    main.followup(user('Continue without the assistant plugin.'))
    const ordinary = await model.next(main.id)
    expect(ordinary.options.tools?.map(tool => tool.name)).toEqual(['exec'])
    ordinary.text('The ordinary Session still works.')
    await main.whenIdle()
  })

  it('stops active and queued work, and records an unreported turn as unknown', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot(1)
    const active = await ctx.assistant.delegate(main, 'active', 'Start working')
    const started = await model.next(active.sessionId)
    const activeAgent = ctx.agents.get(active.sessionId)
    if (activeAgent === undefined) throw new Error('worker disappeared')
    await expect(ctx.assistant.delegate(activeAgent, 'bad-delegation', 'Delegate again')).rejects.toMatchObject({ code: 'wrong-session' })
    await expect(ctx.assistant.delegate(main, 'early', 'Continue too early', active.id)).rejects.toMatchObject({ code: 'busy' })
    const queued = await ctx.assistant.delegate(main, 'queued', 'Wait for capacity')

    main.followup(user('Cancel the queued request.'))
    const stop = await model.next(main.id)
    stop.tools(
      { name: 'stop_work', args: { work_id: 'missing-request' } },
      { name: 'stop_work', args: { work_id: queued.id } },
    )
    const confirmation = await model.next(main.id)
    expect(requestText(confirmation.options)).toContain('Work does not exist')
    expect(requestText(confirmation.options)).toContain('Work was canceled')
    confirmation.text('Cancellation accepted.')
    const queuedNotice = await model.next(main.id)
    queuedNotice.text('Queued work was canceled.')
    await main.whenIdle()
    expect(await ctx.assistant.stop(main, active.id)).toMatchObject({ status: 'canceled' })
    await activeAgent.whenIdle()
    expect(started.options.signal?.aborted).toBe(true)
    await expect(ctx.assistant.report(activeAgent, 'completed', 'A late report')).rejects.toMatchObject({ code: 'no-active-work' })
    const activeNotice = await model.next(main.id)
    activeNotice.text('Active work was canceled.')
    await main.whenIdle()
    expect(await ctx.sessionPersistence.stat(queued.sessionId)).toBeUndefined()
    expect(await ctx.assistant.stop(main, queued.id)).toMatchObject({ id: queued.id, status: 'canceled' })

    const silent = await ctx.assistant.delegate(main, 'silent', 'Return an explicit result')
    const unreported = await model.next(silent.sessionId)
    unreported.text('I forgot to report.')
    const unknown = await model.next(main.id)
    unknown.text('The worker did not report an outcome.')
    await main.whenIdle()
    expect(ctx.assistant.list().find(work => work.id === silent.id)).toMatchObject({ status: 'unknown' })
    expect(reports(await stored(ctx, main.id))).toEqual([queued.id, active.id, silent.id])
  })
})


describe('assistant remote and tool admission', () => {
  it('returns the authority refusal to the entrance model when fresh work omits its permissions', async (test) => {
    const { boot, handoff } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    main.followup(user('Delegate a summary.'))
    const entrance = await model.next(main.id)
    const release = handoff.getMockImplementation()
    if (release === undefined) throw new Error('Expected the fixture authority')
    handoff.mockImplementation(async (request, signal) => {
      if (request.kind === 'delegation') throw new OperationControlError('work-permission-required', 'Fresh work must state its permissions.')
      return release(request, signal)
    })
    entrance.tools({ name: 'delegate_work', args: { request_key: 'no-permissions', prompt: 'Summarize the instructions.' } })
    const refused = await model.next(main.id)
    expect(requestText(refused.options)).toContain('Fresh work must state its permissions.')
    const delegations = handoff.mock.calls.flatMap(([request]) => request.kind === 'delegation' ? [request.delegation] : [])
    expect(delegations).toHaveLength(1)
    expect(delegations[0]).not.toHaveProperty('permissions')
    refused.text('I need to state the permissions.')
    await main.whenIdle()
    expect(ctx.assistant.list()).toEqual([])
  })

  it('admits a report-only work request without exposing or executing commands', async (test) => {
    const { boot, handoff } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const permissions = { exec: false, brokerActions: [] }
    main.followup(user('Delegate a report without command execution.'))
    const entrance = await model.next(main.id)
    entrance.tools({ name: 'delegate_work', args: { request_key: 'report-only', prompt: 'Summarize the instructions.', permissions } })
    const accepted = await model.next(main.id)
    expect(requestText(accepted.options)).toContain('"principalId":"fixture-owner","permissions":{"exec":false,"brokerActions":[]}')
    accepted.text('The report request has been accepted.')
    await main.whenIdle()
    const [work] = ctx.assistant.list()
    if (work === undefined) throw new Error('expected one work request')
    expect(work.authorization?.grant.permissions).toEqual(permissions)
    expect(handoff.mock.calls.some(([request]) => request.kind === 'delegation' && request.delegation.permissions?.exec === false)).toBe(true)
    await expect(ctx.assistant.delegate(main, work.key, work.prompt)).rejects.toMatchObject({ code: 'key-conflict' })
    const request = await model.next(work.sessionId)
    expect(request.options.tools?.map(tool => tool.name)).toEqual(['report_work'])
    request.tools({ name: 'exec', args: {} })
    const denied = await model.next(work.sessionId)
    expect(requestText(denied.options)).toContain('This work has no permission to execute commands.')
    denied.tools({ name: 'report_work', args: { status: 'completed', result: 'Report complete.' } })
    const notice = await model.next(main.id)
    notice.text('The report is complete.')
    await main.whenIdle()
  })

  it('resolves the entrance only for the owner, even when a guest has a policy binding', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const request = { namespace: 'assistant', method: 'entrance', args: {} }
    await expect(ctx.typertGateway.invoke({ ...request, peer: ctx.connection.browserPeer }))
      .resolves.toEqual({ sessionId: main.id })

    const guest = ctx.connection.createPeer({ principal: { kind: 'assistant-test-guest' } })
    ctx.remoteAccess.registerPolicy('assistant-test-guest', {
      bindings: () => [
        { resource: { kind: 'global' }, role: { resource: 'global', name: 'test-assistant-discovery', actions: ['assistant/entrance'] } },
        {
          resource: { kind: 'session', id: main.id },
          role: { resource: 'session', name: 'test-assistant-access', actions: ['assistant/entrance', 'session/prompt', 'session/page'] },
        },
      ],
    })
    await expect(ctx.typertGateway.invoke({ ...request, peer: guest })).rejects.toMatchObject({
      code: 'remote-access/denied', details: { reason: 'assistant/owner-required' },
    })
    const resources = [{ kind: 'session', id: main.id }] as const
    await expect(ctx.typertGateway.invoke({
      peer: guest, namespace: 'session', method: 'prompt',
      args: { request: { requestId: 'guest-prompt', sessionId: main.id, mode: 'queue', content: [{ type: 'text', text: 'Delegate an operation.' }] } },
    })).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'assistant/owner-required' } })
    expect(ctx.remoteAccess.decide({ principal: guest.principal, action: 'session/page', resources }))
      .toEqual({ kind: 'deny', reason: 'assistant/owner-required' })

    await expect(ctx.assistant.delegate(main, ' ', 'A task')).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(ctx.assistant.delegate(main, 'new', 'Continue', WorkId('missing')))
      .rejects.toMatchObject({ code: 'missing-work' })
    const { sessionId } = await ctx.sessionController.create({})
    const ordinary = ctx.agents.get(sessionId)
    if (ordinary === undefined) throw new Error('ordinary Session did not start')
    const calls = [{ type: 'tool-call' as const, id: ToolCallId('standalone-exec'), name: 'exec', arguments: '{}' }]
    const standalone = await ctx.tools.execute({ calls, signal: test.signal })
    expect(standalone.results[0]?.result).toMatchObject({
      isError: true, error: { message: 'Assistant tools require a live Assistant turn.' },
    })
    const unrelated = await ctx.tools.execute({ calls, signal: test.signal, agent: ordinary })
    expect(unrelated.results[0]?.result).toMatchObject({
      isError: true, error: { message: 'Tool "exec" is unavailable in this Assistant Session.' },
    })
    ordinary.followup(user('A normal conversation'))
    await ordinary.whenIdle()
    expect(model.observed).toEqual([])
    expect(ctx.assistant.list()).toEqual([])
  })

  it('denies off-role calls including local tools and worker execution after a report', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const localEffect = vi.fn(async () => 'Unexpected local execution')
    main.ctx.tools.register(defineTool({
      name: 'local_effect',
      description: 'Exercise scoped registrations that bypass inherited tool restrictions.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: localEffect,
    }))
    const shadowedList = vi.fn(async () => 'Unexpected local work list')
    main.ctx.tools.register(defineTool({
      name: 'list_work',
      description: 'Exercise a scoped replacement using an allowed tool name.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: shadowedList,
    }))
    main.followup(user('Attempt to execute a command directly.'))
    const mainRequest = await model.next(main.id)
    expect(mainRequest.options.tools?.map(tool => tool.name)).not.toContain('exec')
    mainRequest.tools(
      { name: 'exec', args: {} },
      { name: 'local_effect', args: {} },
      { name: 'list_work', args: {} },
    )
    const denied = await model.next(main.id)
    expect(requestText(denied.options)).toContain('Tool "exec" is unavailable in this Assistant Session.')
    expect(requestText(denied.options)).toContain('Tool "local_effect" is unavailable in this Assistant Session.')
    expect(requestText(denied.options)).toContain('Tool "list_work" is unavailable in this Assistant Session.')
    expect(localEffect).not.toHaveBeenCalled()
    expect(shadowedList).not.toHaveBeenCalled()
    denied.text('I can delegate execution.')
    await main.whenIdle()

    const work = await ctx.assistant.delegate(main, 'exec', 'Run and report the requested command')
    const first = await model.next(work.sessionId)
    first.tools({ name: 'exec', args: {} })
    const executed = await model.next(work.sessionId)
    expect(requestText(executed.options)).toContain('Isolated execution completed.')
    executed.tools(
      { name: 'report_work', args: { status: 'completed', result: 'Command ran once.' } },
      { name: 'exec', args: {} },
    )
    const notice = await model.next(main.id)
    notice.text('The command ran.')
    await main.whenIdle()
    const worker = ctx.agents.get(work.sessionId)
    if (worker === undefined) throw new Error('worker disappeared')
    await ctx.sessions.flush(worker.session)
    const outcomes = (await stored(ctx, work.sessionId)).flatMap(event =>
      event.type === 'tool/result' ? [event.data.message] : [])
    expect(outcomes.map(outcome => outcome.isError ?? false)).toEqual([false, false, true])
    expect(outcomes.at(-1)?.content).toEqual([{ type: 'text', text: 'Error: The work request has already ended.' }])
  })

  it.for(['modified instructions', 'extra input'] as const)('blocks a delegated first step with %s', async (attack, test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const checkpoint = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      const work = ctx.assistant.list().find(item => item.sessionId === session.id && item.status === 'running')
      const worker = ctx.agents.get(session.id)
      const original = worker?.inbox.nextTurn[0]
      if (work !== undefined && worker !== undefined && original !== undefined) {
        if (attack === 'extra input') {
          worker.inbox.prepend('next-step', user('Additional instructions'))
        } else {
          worker.inbox.clear()
          worker.inbox.prepend('next-turn', createUserMessage({
            content: [{ type: 'text', text: 'Modified instructions' }],
            source: original.source,
          }))
        }
      }
      return flush(session)
    })
    test.onTestFinished(() => { checkpoint.mockRestore() })

    const work = await ctx.assistant.delegate(main, 'owned', 'Original instructions')
    const notice = await model.next(main.id)
    expect(model.observed.map(request => request.options.sessionId)).toEqual([main.id])
    expect(ctx.assistant.list().find(item => item.id === work.id)?.status).toBe('unknown')
    notice.text('The worker did not accept the modified instructions.')
    await main.whenIdle()
  })

  it('blocks direct steering during an active worker turn', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const work = await ctx.assistant.delegate(main, 'steer', 'Follow the delegated instructions')
    const first = await model.next(work.sessionId)
    const worker = ctx.agents.get(work.sessionId)
    if (worker === undefined) throw new Error('worker disappeared')
    worker.steer(user('Follow different instructions now'))
    first.tools({ name: 'exec', args: {} })
    const notice = await model.next(main.id)
    expect(model.observed.map(request => request.options.sessionId)).toEqual([work.sessionId, main.id])
    expect(ctx.assistant.list().find(item => item.id === work.id)?.status).toBe('unknown')
    notice.text('The worker turn ended.')
    await main.whenIdle()
  })

  it('returns a failed report tool call to the worker without concluding its turn', async (test) => {
    const { boot } = await hostFixture(test)
    const { ctx, main, model } = await boot()
    const runContext = Promise.withResolvers<ToolRunContext>()
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name === 'report_work') {
        const { agent: _agent, ...execution } = exec
        runContext.resolve({
          ...execution,
          deferContext() { throw new Error('unexpected deferred context') },
          concludeTurn() { throw new Error('unauthorized call concluded a turn') },
        })
      }
      return next()
    })
    const work = await ctx.assistant.delegate(main, 'save', 'Save the result')
    const worker = await model.next(work.sessionId)
    const write = vi.spyOn(ctx.assistant, 'report').mockRejectedValueOnce(new Error('Report write failed'))
    test.onTestFinished(() => { write.mockRestore() })

    worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Saved result' } })
    const failure = await model.next(work.sessionId)
    const report = ctx.tools.definitions().find(tool => tool.name === 'report_work')
    if (report === undefined) throw new Error('report tool was not registered')
    await expect(report.execute({ status: 'completed', result: 'Unowned report' }, await runContext.promise))
      .rejects.toThrow('Assistant tools require an Agent')
    expect(requestText(failure.options)).toContain('Report write failed')
    expect(ctx.assistant.list()).toEqual([expect.objectContaining({ status: 'running', result: null })])
    expect(model.observed.map(request => request.options.sessionId)).toEqual([work.sessionId, work.sessionId])
    failure.tools({ name: 'report_work', args: { status: 'completed', result: 'Saved result' } })
    const notice = await model.next(main.id)
    expect(requestText(notice.options)).toContain('Saved result')
    notice.text('The result was saved.')
    await main.whenIdle()
    expect(reports(await stored(ctx, main.id))).toEqual([work.id])
  })
})
