/** Native exec dispatch through the Agent adapter's Unix authority protocol. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { digestEvidenceEvent } from '@deepseek-ai/dsh-operation-evidence/library'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome, type ApprovalPolicy, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi, type TestContext } from 'vitest'
import * as Adapter from '../src/agent.ts'
import { operationIdSchema, reconciliationAttemptIdSchema, reconciliationObservationEvent, reconciliationObservationSchema } from '../src/protocol.ts'

const id = '09901cbc-8cf6-4668-96ee-0e4774e2f872'
const sessionId = SessionId('work-session')
const command = " printf '%s\\n' '作業'\nexit 7\n"
const issued = { id, state: 'issued', admission: { id: `${id}-admission`, digest: 'a'.repeat(64) } }
const settled = {
  id,
  state: 'settled',
  admission: issued.admission,
  outcome: {
    kind: 'exited',
    observation: {
      exitCode: 7, stdout: '作業\n', stderr: 'partial', stdoutTruncated: false, stderrTruncated: true,
      containerId: 'b'.repeat(64), stopped: true,
    },
  },
  receipt: { id: `${id}-outcome`, digest: 'c'.repeat(64) },
}

interface Request {
  method: string | undefined
  path: string | undefined
  body: unknown
}

function reply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  response.end(JSON.stringify(body))
}

type Handlers = Readonly<Record<string, (response: ServerResponse, body: unknown) => void>>

async function listen(test: TestContext, socketPath: string, handlers: Handlers, holdReview = false): Promise<Request[]> {
  const requests: Request[] = []
  const server = createServer((request, response) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { text += chunk })
    request.once('end', () => {
      const body: unknown = JSON.parse(text)
      const handler = request.url === undefined ? undefined : handlers[request.url]
      if (handler === undefined && holdReview && request.url === '/wait-review') return
      requests.push({ method: request.method, path: request.url, body })
      if (handler === undefined) {
        response.writeHead(404).end()
        return
      }
      handler(response, body)
    })
  })
  test.onTestFinished(async () => {
    if (!server.listening) return
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    server.closeAllConnections()
    await closed
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return requests
}

async function fixture(
  test: TestContext,
  handlers: Handlers,
  approval?: { handlers: Handlers; policy?: ApprovalPolicy },
) {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'op-agent-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  test.onTestFinished(() => ctx.fiber.dispose())
  const socketPath = join(root, 'a.sock')
  const requests = await listen(test, socketPath, handlers, approval !== undefined)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  const mainSessionId = SessionId('assistant-main')
  const decisionPath = join(root, 'p.sock')
  const auditPath = join(root, 'approval-events.json')
  let decisions: Request[] = []
  let disposeApproval: (() => void | Promise<void>) | undefined
  if (approval !== undefined) {
    decisions = await listen(test, decisionPath, approval.handlers)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const approvalFiber = await ctx.plugin(ApprovalService, { policy: approval.policy ?? 'ask' })
    disposeApproval = () => approvalFiber.dispose()
    const session = ctx.sessions.create(mainSessionId)
    await ctx.agents.register({ id: session.id, session, ctx } as Agent)
    const audit: SessionEvent[] = []
    ctx.on('session/event', (subject, event) => {
      if (subject === session && (event.type === 'approval/asked' || event.type === 'approval/decided')) audit.push(event)
    })
    ctx.on('session/flush', async (subject) => {
      if (subject === session) await writeFile(auditPath, JSON.stringify(audit))
    })
  }
  const adapter = await ctx.plugin(Adapter, {
    socketPath,
    ...(approval === undefined ? {} : { approval: { socketPath: decisionPath, mainSessionId } }),
  })

  return {
    ctx, decisions, mainSessionId,
    requests,
    disposeAdapter: () => adapter.dispose(), disposeApproval,
    readAudit: (): unknown => JSON.parse(readFileSync(auditPath, 'utf8')),
    run: async (signal = new AbortController().signal) => {
      const { results } = await ctx.tools.execute({
        agent: { id: sessionId } as Agent,
        calls: [{ type: 'tool-call', name: 'exec', id: ToolCallId('model-call'), arguments: JSON.stringify({ command }) }],
        signal,
      })
      return results[0]?.result
    },
  }
}

const uuidV4: unknown = expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
const mentionsOperation: unknown = expect.stringContaining(id)
const proposal = {
  method: 'POST',
  path: '/propose',
  body: { requestKey: uuidV4, sessionId, command },
}
const execution = { method: 'POST', path: '/execute', body: { id } }
const cancellation = { method: 'POST', path: '/cancel', body: { id } }
const review = { sessionId, command, revision: 'e'.repeat(64), payloadDigest: createHash('sha256').update(command).digest('hex') }
const pendingApproval = { id, state: 'pending-approval', review }
const canceled = { id, state: 'canceled' }

function approvalDecision(decision: 'approve' | 'deny'): Request {
  return { method: 'POST', path: '/decide', body: { id, revision: review.revision, payloadDigest: review.payloadDigest, decision } }
}

const childId = '4763279b-d088-4f75-9071-1b143822714c'
const business = {
  parentId: id, action: 'test.submit', method: 'POST', endpoint: 'https://example.invalid/intake?team=qa',
  credentialRef: 'TEST_BROKER_TOKEN', body: '{\n  "message": "作業"\n}',
}
const childReview = {
  sessionId, revision: review.revision,
  payloadDigest: createHash('sha256').update(JSON.stringify([
    id, business.action, business.method, business.endpoint, business.credentialRef, business.body,
  ])).digest('hex'),
  business,
}
const pendingChild = { id: childId, state: 'pending-approval', review: childReview }
const issuedChild = { id: childId, state: 'issued', admission: { id: `${childId}-admission`, digest: '1'.repeat(64) } }
const settledChild = {
  ...issuedChild, state: 'settled', outcome: { kind: 'business-response', statusCode: 202 },
  receipt: { id: `${childId}-outcome`, digest: '2'.repeat(64) },
}
const canceledChild = { id: childId, state: 'canceled', receipt: { id: `${childId}-revocation`, digest: '3'.repeat(64) } }
const childCancellation = { method: 'POST', path: '/cancel', body: { id: childId } }
const unknownParent = {
  id, state: 'unknown', admission: issued.admission, outcome: { kind: 'unknown', code: 'EXEC_CANCELLED' },
  receipt: settled.receipt,
}

const inspectTool = 'inspect_business_operations'
const lookup = (id: string): Request => ({ method: 'POST', path: '/reconcile', body: { sessionId, id } })
const list = (after?: string): Request => ({ method: 'POST', path: '/business-operations', body: { sessionId, ...(after === undefined ? {} : { after }) } })
const unconfirmed = {
  id: childId, sessionId, action: business.action,
  state: 'unknown', approval: 'approved', outcome: { kind: 'unknown', code: 'broker-transport-failed' },
  canReconcile: true, businessCompletion: { kind: 'unconfirmed' },
}
const succeeded = (() => {
  const outcome = reconciliationObservationSchema.parse({ kind: 'succeeded', receiptId: 'provider-receipt' })
  const attempt = reconciliationAttemptIdSchema.parse('0f73aee2-d481-4176-9fe3-680e62426776')
  const event = reconciliationObservationEvent(operationIdSchema.parse(childId), attempt, outcome)
  return {
    ...unconfirmed, canReconcile: false,
    businessCompletion: { ...outcome, receipt: { id: event.id, digest: digestEvidenceEvent(event) } },
  }
})()

async function inspector(test: TestContext, handlers: Handlers) {
  const host = await fixture(test, handlers, { handlers: {} })
  const main = host.ctx.agents.get(host.mainSessionId)!
  const worker = { id: sessionId } as Agent
  const selection = { provider: 'test', model: 'test' }
  const resolve = (agent: Agent, signal = new AbortController().signal) =>
    host.ctx.tools.resolve({ agent, modelSelection: selection, signal })
  return {
    ...host, main, worker, resolve,
    async call(name: string, args: Record<string, unknown>, agent = main, signal = new AbortController().signal) {
      const toolSet = await resolve(agent, signal)
      try {
        const { results } = await host.ctx.tools.execute({
          agent, signal, toolSet,
          calls: [{ type: 'tool-call', name, id: ToolCallId('inspect'), arguments: JSON.stringify(args) }],
        })
        return results[0]?.result
      } finally {
        toolSet.dispose()
      }
    },
    inspect(args: Record<string, unknown> = {}, agent = main, signal = new AbortController().signal) {
      return this.call(inspectTool, { session_id: sessionId, ...args }, agent, signal)
    },
  }
}

function businessDecision(decision: 'approve' | 'deny'): Request {
  return { method: 'POST', path: '/decide', body: { id: childId, revision: childReview.revision, payloadDigest: childReview.payloadDigest, decision } }
}

function isParent(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'id' in body && body.id === id
}

async function businessFixture(
  test: TestContext, handlers: Handlers, childDecision: 'approve' | 'deny' | 'revision-mismatch' = 'approve', child: unknown = pendingChild,
) {
  const executing = Promise.withResolvers<ServerResponse>()
  const watchingAgain = Promise.withResolvers<undefined>()
  let offered = false
  let auditAtChildDecision: unknown
  const adapter = await fixture(test, {
    '/propose': (response) => { reply(response, pendingApproval) },
    '/execute': (response) => { executing.resolve(response) },
    '/wait-review': (response) => {
      if (offered) {
        watchingAgain.resolve(undefined)
        return
      }
      offered = true
      void executing.promise.then(() => { reply(response, { review: child }) })
    },
    ...handlers,
  }, { handlers: {
    '/decide': (response, body) => {
      if (isParent(body)) {
        reply(response, issued)
      } else {
        auditAtChildDecision = adapter.readAudit()
        if (childDecision === 'revision-mismatch') {
          reply(response, { code: childDecision, message: 'The operation grant limits changed before execution.', operationId: childId }, 400)
        } else {
          reply(response, childDecision === 'approve' ? issuedChild : canceledChild)
        }
      }
    },
  } })
  const prompted = Promise.withResolvers<ApprovalRequest>()
  const answer = Promise.withResolvers<ApprovalOutcome>()
  test.onTestFinished(() => { answer.resolve('cancelled') })
  adapter.ctx.on('approval/request', (request) => {
    if (request.detail === command) return Promise.resolve<ApprovalOutcome>('allowed-once')
    prompted.resolve(request)
    return answer.promise
  })
  return {
    ...adapter, prompted: prompted.promise, answer: answer.resolve, watchingAgain: watchingAgain.promise,
    auditAtChildDecision: () => auditAtChildDecision,
    completeParent: async (status: unknown = settled) => { reply(await executing.promise, status) },
  }
}

describe.skipIf(process.platform === 'win32')('Agent exec authority adapter over a POSIX socket', () => {
  it('lists saved business operations without looking them up unless asked', async (test) => {
    const page = { sessionId, operations: [unconfirmed] }
    const host = await inspector(test, { '/business-operations': (response) => { reply(response, page) } })
    expect(await host.inspect({ after: id })).toMatchObject({ isError: false, value: JSON.stringify(page) })
    expect(host.requests).toEqual([list(id)])
    expect(await host.inspect({ after: 'invalid' })).toMatchObject({ isError: true, error: { info: { code: 'BUSINESS_INSPECTION_INVALID' } } })
    expect(host.requests).toEqual([list(id)])
  })

  it('looks up eligible operations once and keeps other results when a reply is unavailable', async (test) => {
    const unavailable = { ...unconfirmed, id }
    const canceled = {
      id: randomUUID(), sessionId, action: business.action, state: 'canceled', canReconcile: false,
      businessCompletion: { kind: 'unconfirmed' },
    }
    const host = await inspector(test, {
      '/business-operations': (response) => { reply(response, { sessionId, operations: [unavailable, canceled, unconfirmed] }) },
      '/reconcile': (response, body) => {
        if (isParent(body)) reply(response, { code: 'authority-unavailable', message: 'The lookup reply is unavailable.' }, 503)
        else reply(response, succeeded)
      },
    })
    expect(await host.inspect({ reconcile: true })).toMatchObject({
      isError: false,
      value: JSON.stringify({ sessionId, operations: [{ ...unavailable, reconciliationError: 'authority-unavailable' }, canceled, succeeded] }),
    })
    expect(host.requests).toEqual([list(), lookup(id), lookup(childId)])
    expect(host.decisions).toEqual([])
  })

  it('lists permitted business actions only for the registered main Agent and unloads its tool', async (test) => {
    const listTool = 'list_business_actions'
    const actions = { actions: [{ action: 'capture', description: 'Capture a payment. The body is {"amount": number}.' }, { action: 'refund' }] }
    const host = await inspector(test, { '/business-actions': (response) => { reply(response, actions) } })
    expect(await host.call(listTool, {})).toMatchObject({ isError: false, value: JSON.stringify(actions) })
    expect(host.requests).toEqual([{ method: 'POST', path: '/business-actions', body: {} }])
    expect(await host.call(listTool, {}, host.worker)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })

    const tool = host.ctx.tools.get(listTool)!
    const callId = ToolCallId('direct-listing')
    await expect(tool.execute({}, {
      agent: { id: host.mainSessionId } as Agent,
      name: listTool, callId, rootCallId: callId, token: Symbol() as ToolExecutionToken,
      signal: new AbortController().signal, arguments: {}, concludeTurn: () => {}, deferContext: () => {},
    })).rejects.toMatchObject({ code: 'BUSINESS_ACTIONS_FORBIDDEN' })
    await host.disposeAdapter()
    expect(host.ctx.tools.get(listTool)).toBeUndefined()
    expect(host.requests).toHaveLength(1)
  })

  it('admits inspection only for the registered main Agent and unloads its tool', async (test) => {
    const host = await inspector(test, {})
    const workerTools = await host.resolve(host.worker)
    expect(host.ctx.tools.schemas(host.worker, workerTools).map(tool => tool.name)).toEqual(['exec'])
    workerTools.dispose()
    expect(await host.inspect({}, host.worker)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })

    const tool = host.ctx.tools.get(inspectTool)!
    const callId = ToolCallId('direct-inspection')
    const args = { session_id: sessionId, reconcile: true }
    await expect(tool.execute(args, {
      agent: { id: host.mainSessionId } as Agent,
      name: inspectTool, callId, rootCallId: callId, token: Symbol() as ToolExecutionToken,
      signal: new AbortController().signal, arguments: args, concludeTurn: () => {}, deferContext: () => {},
    })).rejects.toMatchObject({ code: 'BUSINESS_INSPECTION_FORBIDDEN' })
    await host.disposeAdapter()
    expect(host.ctx.tools.get(inspectTool)).toBeUndefined()
    expect(host.requests).toEqual([])
  })

  it('cancels a waiting inspection when the adapter unloads', async (test) => {
    const entered = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    const host = await inspector(test, {
      '/business-operations': (response) => { reply(response, { sessionId, operations: [unconfirmed] }) },
      '/reconcile': (response) => {
        response.once('close', () => { closed.resolve(undefined) })
        entered.resolve(undefined)
      },
    })
    const result = host.inspect({ reconcile: true })
    await entered.promise
    await host.disposeAdapter()
    await closed.promise
    expect(await result).toMatchObject({ isError: true })
    expect(host.requests).toEqual([list(), lookup(childId)])
  })

  it('fails startup when approval is configured without its Host services', async (test) => {
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await expect(Adapter.apply(ctx, {
      socketPath: '/test/propose.sock',
      approval: { socketPath: '/test/decide.sock', mainSessionId: 'assistant-main' },
    })).rejects.toThrow('Execution approval requires the Host agents and approval services.')
  })

  it('proposes the exact Session script and renders the witnessed result of its issued operation', async (test) => {
    const { requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, issued) },
      '/execute': (response) => { reply(response, settled) },
    })
    const result = await run()
    expect(requests).toEqual([proposal, execution])
    expect(result).toMatchObject({
      isError: false,
      content: [{
        type: 'text',
        text: `Exit status: 7\n\nstdout:\n作業\n\nstderr (truncated):\npartial\nOperation: ${id}\nEvidence: ${settled.receipt.digest}`,
      }],
    })
  })

  it('rejects execution while admission evidence is pending', async (test) => {
    const { requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, { id, state: 'pending-evidence' }) },
    })
    const pendingEvidence: unknown = expect.stringContaining("This operation did not run or send anything. Check Vardock's services with pnpm vardock doctor.")
    expect(await run()).toMatchObject({
      isError: true,
      error: { info: { code: 'EXEC_NOT_ISSUED' }, message: pendingEvidence },
    })
    expect(requests).toEqual([proposal])
  })

  it.for(['wrong operation ID', 'lost reply'])('reports an unknown outcome after a %s without dispatching again', async (failure, test) => {
    const { requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, issued) },
      '/execute': (response) => {
        if (failure === 'lost reply') {
          response.destroy()
          return
        }
        const differentId = randomUUID()
        reply(response, {
          ...settled, id: differentId,
          admission: { ...issued.admission, id: `${differentId}-admission` },
          receipt: { ...settled.receipt, id: `${differentId}-outcome` },
        })
      },
    })
    expect(await run()).toMatchObject({
      isError: true,
      error: { info: { code: 'EXEC_UNKNOWN' }, message: mentionsOperation },
    })
    expect(requests).toEqual([proposal, execution])
  })

  it('requests cancellation for the issued operation and waits for its authority reply', async (test) => {
    const executing = Promise.withResolvers<undefined>()
    const canceling = Promise.withResolvers<ServerResponse>()
    const { requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, issued) },
      '/execute': () => { executing.resolve(undefined) },
      '/cancel': (response) => { canceling.resolve(response) },
    })
    const abort = new AbortController()
    const pending = run(abort.signal)
    let completed = false
    void pending.then(() => { completed = true }, () => { completed = true })
    await executing.promise
    abort.abort()
    const response = await canceling.promise
    expect(completed).toBe(false)
    reply(response, {
      id, state: 'unknown', admission: issued.admission,
      outcome: { kind: 'unknown', code: 'EXEC_CANCELLED' },
      receipt: settled.receipt,
    })
    expect(await pending).toMatchObject({
      isError: true,
      error: { info: { code: 'EXEC_CANCELLED' }, message: mentionsOperation },
    })
    expect(requests).toEqual([proposal, execution, cancellation])
  })

  it('audits the exact worker command in an idle main Session before issuing or executing it', async (test) => {
    let auditAtDecision: unknown
    const workId = '7'.repeat(64)
    const principalId = 'assistant-principal'
    const { ctx, decisions, mainSessionId, requests, readAudit, run } = await fixture(test, {
      '/propose': (response) => { reply(response, { ...pendingApproval, review: { ...review, workId, principalId } }) },
      '/execute': (response) => { reply(response, settled) },
    }, {
      handlers: {
        '/decide': (response) => {
          auditAtDecision = readAudit()
          reply(response, issued)
        },
      },
    })
    const prompted = Promise.withResolvers<ApprovalRequest>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    ctx.on('approval/request', (request) => {
      prompted.resolve(request)
      return answer.promise
    })
    const running = run()
    expect(await prompted.promise).toMatchObject({
      agent: { id: mainSessionId }, toolName: 'exec', detail: command,
      displayReason: {
        en: `Run this shell script in the isolated /workspace? Work ${workId.slice(0, 8)}… (principal ${principalId}) requested it.`,
        zh: `在隔离的 /workspace 中运行此 shell 脚本？ 请求来自工作 ${workId.slice(0, 8)}…（主体 ${principalId}）。`,
      },
    })
    expect(requests).toEqual([proposal])
    expect(decisions).toEqual([])
    expect(readAudit()).toMatchObject([{ type: 'approval/asked', data: {
      reason: `Execution ${id} for work Session ${sessionId}, work ${workId}, principal ${principalId}, grant ${review.revision}, payload ${review.payloadDigest}.`,
    } }])
    answer.resolve('allowed-once')
    expect(await running).toMatchObject({ isError: false })
    expect(auditAtDecision).toMatchObject([
      { type: 'approval/asked' },
      { type: 'approval/decided', data: { outcome: 'allowed-once' } },
    ])
    expect(requests).toEqual([proposal, execution])
    expect(decisions).toEqual([approvalDecision('approve')])
  })

  it.for(['broker-unavailable', 'broker-parent-inactive'])('stops waiting for business reviews after %s', async (code, test) => {
    const executing = Promise.withResolvers<ServerResponse>()
    const watching = Promise.withResolvers<undefined>()
    const { ctx, decisions, requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, pendingApproval) },
      '/execute': (response) => { executing.resolve(response) },
      '/wait-review': (response) => {
        reply(response, { code, message: 'No further business review', operationId: id }, 400)
        watching.resolve(undefined)
      },
    }, { handlers: { '/decide': (response) => { reply(response, issued) } } })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const running = run()
    await watching.promise
    reply(await executing.promise, settled)
    expect(await running).toMatchObject({ isError: false })
    expect(decisions).toEqual([approvalDecision('approve')])
    expect(requests.filter(request => request.path === '/cancel')).toEqual([])
  })

  it.for(['approved', 'rejected', 'not sent', 'lost status'] as const)('reviews the exact business request and reports %s separately', async (result, test) => {
    const childDecision = result === 'rejected' ? 'deny' : 'approve'
    const host = await businessFixture(test, {
      '/status': (response) => {
        if (result === 'lost status') response.destroy()
        else reply(response, result === 'not sent'
          ? { ...settledChild, outcome: { kind: 'business-not-sent', code: 'broker-credential-unavailable' } }
          : childDecision === 'deny' ? canceledChild : settledChild)
      },
    }, childDecision)
    const running = host.run()
    const detail = `POST ${business.endpoint}\nCredential: ${business.credentialRef}\n\nJSON\n${business.body}`
    expect(await host.prompted).toMatchObject({
      agent: { id: host.mainSessionId }, toolName: 'exec', detail,
      displayReason: { en: `Send the external request "test.submit"? Work session ${sessionId} requested it.` },
    })
    expect(host.decisions).toEqual([approvalDecision('approve')])
    const outcome = childDecision === 'deny' ? 'rejected' : 'allowed-once'
    host.answer(outcome)
    await host.watchingAgain
    await host.completeParent()

    const message = result === 'approved' ? `HTTP 202 observed; business completion is not verified; evidence ${settledChild.receipt.digest}`
      : result === 'rejected' ? `canceled; evidence ${canceledChild.receipt.digest}`
        : result === 'not sent' ? `not sent (broker-credential-unavailable); evidence ${settledChild.receipt.digest}`
          : 'result unknown. Inspect its authority record before continuing.'
    const summary: unknown = expect.stringContaining(`External operation ${childId}: ${message}`)
    expect(await running).toMatchObject({ isError: false, content: [{ type: 'text', text: summary }] })
    expect(host.decisions).toEqual([approvalDecision('approve'), businessDecision(childDecision)])
    expect(host.auditAtChildDecision()).toMatchObject([
      { type: 'approval/asked' }, { type: 'approval/decided' },
      { type: 'approval/asked' }, { type: 'approval/decided', data: { outcome } },
    ])
    expect(host.requests.filter(request => request.path === '/execute')).toEqual([execution])
    expect(host.requests.filter(request => request.path === '/cancel')).toEqual([])
    expect(host.requests).toContainEqual({ method: 'POST', path: '/status', body: { id: childId } })
  })

  it('tells the owner that an earlier request to the action with an unresolved outcome precedes the reviewed one', async (test) => {
    const earlier = '6d0c3a8e-5f41-4b2a-9c1e-0a7d6f2b9e13'
    const notice = {
      en: `An earlier request to this action, operation ${earlier.slice(0, 8)}…, has an unresolved outcome. Approving may repeat its effect.`,
      zh: `此操作的较早请求（操作 ${earlier.slice(0, 8)}…）结果尚未确认。批准可能会重复其效果。`,
    }
    const presentation = { title: { en: 'Capture the payment?', zh: '确认收款？', ja: '支払いを確定しますか？' }, detail: 'Capture 5 EUR' }
    const host = await businessFixture(test, {}, 'deny', { ...pendingChild, review: { ...childReview, presentation, repeats: earlier } })
    const running = host.run()
    const prompt = await host.prompted
    expect(prompt.reason).toContain(`, repeats unresolved operation ${earlier}.`)
    expect(prompt).toMatchObject({
      displayReason: {
        en: `Capture the payment? Work session ${sessionId} requested it. ${notice.en}`,
        zh: `确认收款？ 请求来自工作会话 ${sessionId}。 ${notice.zh}`,
        ja: `支払いを確定しますか？ 作業セッション ${sessionId} からのリクエストです。 この操作への以前のリクエスト（操作 ${earlier.slice(0, 8)}…）の結果が未確認です。承認すると効果が重複する可能性があります。`,
      },
    })
    expect(Object.keys(prompt.displayReason ?? {}).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    for (const text of Object.values(prompt.displayReason ?? {})) expect(text).not.toContain(earlier)
    host.answer('rejected')
    await host.watchingAgain
    await host.completeParent()
    await running
    expect(host.decisions).toEqual([approvalDecision('approve'), businessDecision('deny')])
  })

  it('withdraws the child and cancels the parent once when nested approval is unavailable', async (test) => {
    const cancelingParent = Promise.withResolvers<ServerResponse>()
    const host = await businessFixture(test, {
      '/cancel': (response, body) => {
        if (isParent(body)) cancelingParent.resolve(response)
        else reply(response, canceledChild)
      },
    })
    const running = host.run()
    await host.prompted
    host.answer('unavailable')
    reply(await cancelingParent.promise, unknownParent)
    await host.completeParent(unknownParent)

    expect(await running).toMatchObject({ isError: true })
    expect(host.decisions).toEqual([approvalDecision('approve')])
    expect(host.requests.filter(request => request.path === '/cancel')).toEqual([childCancellation, cancellation])
    expect(host.requests.filter(request => request.path === '/execute')).toEqual([execution])
  })

  it('lets the parent continue after the authority refuses a stale child approval and confirms cancellation', async (test) => {
    const host = await businessFixture(test, {
      '/cancel': (response) => { reply(response, canceledChild) },
      '/status': (response) => { reply(response, canceledChild) },
    }, 'revision-mismatch')
    const running = host.run()
    await host.prompted
    host.answer('allowed-once')
    await Promise.race([host.watchingAgain, running.then(() => {
      throw new Error('The worker settled before it resumed waiting for child reviews.')
    })])
    await host.completeParent()

    const summary: unknown = expect.stringContaining(`External operation ${childId}: canceled`)
    expect(await running).toMatchObject({ isError: false, content: [{ type: 'text', text: summary }] })
    expect(host.decisions).toEqual([approvalDecision('approve'), businessDecision('approve')])
    expect(host.requests.filter(request => request.path === '/cancel')).toEqual([childCancellation])
  })

  it('withdraws a nested prompt on parent settlement and discards a late approval', async (test) => {
    const host = await businessFixture(test, {
      '/cancel': (response) => { reply(response, canceledChild) },
      '/status': (response) => { reply(response, canceledChild) },
    })
    const running = host.run()
    await host.prompted
    await host.completeParent()
    expect(await running).toMatchObject({ isError: false })
    host.answer('allowed-once')

    expect(host.readAudit()).toMatchObject([
      { type: 'approval/asked' }, { type: 'approval/decided' },
      { type: 'approval/asked' }, { type: 'approval/decided', data: { outcome: 'cancelled' } },
    ])
    expect(host.decisions).toEqual([approvalDecision('approve')])
    expect(host.requests.filter(request => request.path === '/cancel')).toEqual([childCancellation])
  })

  it('cancels the parent once when the worker aborts during a nested prompt', async (test) => {
    const host = await businessFixture(test, {
      '/cancel': (response, body) => { reply(response, isParent(body) ? unknownParent : canceledChild) },
    })
    const abort = new AbortController()
    const running = host.run(abort.signal)
    await host.prompted
    abort.abort()
    expect(await running).toMatchObject({ isError: true, error: { info: { code: 'EXEC_CANCELLED' } } })

    expect(host.decisions).toEqual([approvalDecision('approve')])
    const cancellations = host.requests.filter(request => request.path === '/cancel')
    expect(cancellations).toHaveLength(2)
    expect(cancellations).toEqual(expect.arrayContaining([childCancellation, cancellation]))
  })

  it.for(['rejected', 'unavailable', 'cancelled', 'never'] as const)('stops execution when main Session approval is %s', async (result, test) => {
    const withdraw = result === 'unavailable' || result === 'cancelled'
    const { ctx, decisions, requests, readAudit, run } = await fixture(test, {
      '/propose': (response) => { reply(response, pendingApproval) },
      '/cancel': (response) => { reply(response, canceled) },
    }, {
      handlers: { '/decide': (response) => { reply(response, canceled) } },
      policy: result === 'never' ? 'never' : 'ask',
    })
    let prompted = false
    if (result !== 'unavailable') {
      ctx.on('approval/request', () => {
        prompted = true
        return Promise.resolve<ApprovalOutcome>(result === 'never' ? 'rejected' : result)
      })
    }
    const code = result === 'unavailable' ? 'EXEC_APPROVAL_UNAVAILABLE' : result === 'cancelled' ? 'EXEC_CANCELLED' : 'EXEC_APPROVAL_DENIED'
    expect(await run()).toMatchObject({ isError: true, error: { info: { code } } })
    expect(prompted).toBe(result === 'rejected' || result === 'cancelled')
    expect(readAudit()).toMatchObject([
      { type: 'approval/asked' },
      { type: 'approval/decided', data: { outcome: result === 'never' ? 'rejected' : result } },
    ])
    expect(requests).toEqual(withdraw ? [proposal, cancellation] : [proposal])
    expect(decisions).toEqual(withdraw ? [] : [approvalDecision('deny')])
  })

  it('withdraws an active review on approval service replacement and uses the new policy', async (test) => {
    const { ctx, decisions, requests, run, disposeApproval } = await fixture(test, {
      '/propose': (response) => { reply(response, pendingApproval) },
      '/cancel': (response) => { reply(response, canceled) },
    }, { handlers: { '/decide': (response) => { reply(response, canceled) } } })
    if (disposeApproval === undefined) throw new Error('The test needs an active approval service')
    const prompted = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let prompts = 0
    ctx.on('approval/request', () => {
      prompts++
      prompted.resolve(undefined)
      return answer.promise
    })
    const active = run()
    await prompted.promise
    await disposeApproval()
    expect(await active).toMatchObject({ isError: true, error: { info: { code: 'EXEC_CANCELLED' } } })
    expect(ctx.tools.get('exec')).toBeUndefined()
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await vi.waitFor(() => { expect(ctx.tools.get('exec')).toBeDefined() })
    answer.resolve('allowed-once')
    expect(await run()).toMatchObject({ isError: true, error: { info: { code: 'EXEC_APPROVAL_DENIED' } } })
    expect(prompts).toBe(1)
    expect(requests).toEqual([proposal, cancellation, proposal])
    expect(decisions).toEqual([approvalDecision('deny')])
  })

  it('runs a shell operation the authority issued without review and keeps watching for business reviews', async (test) => {
    const executing = Promise.withResolvers<ServerResponse>()
    const watching = Promise.withResolvers<undefined>()
    const { ctx, decisions, requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, issued) },
      '/execute': (response) => { executing.resolve(response) },
      '/wait-review': (response) => {
        reply(response, { code: 'broker-unavailable', message: 'No further business review', operationId: id }, 400)
        watching.resolve(undefined)
      },
    }, { handlers: {} })
    ctx.on('approval/request', () => { throw new Error('unexpected approval question') })
    const running = run()
    await watching.promise
    reply(await executing.promise, settled)
    expect(await running).toMatchObject({ isError: false })
    expect(decisions).toEqual([])
    expect(requests.filter(request => request.path === '/cancel')).toEqual([])
  })

  it.for([
    { id, state: 'pending-evidence' },
    { ...pendingApproval, review: { ...review, sessionId: SessionId('another-work-session') } },
    { ...pendingApproval, review: { ...review, command: 'exit 0', payloadDigest: createHash('sha256').update('exit 0').digest('hex') } },
  ])('withdraws an operation without an exact approval review', async (response, test) => {
    const { ctx, decisions, requests, run } = await fixture(test, {
      '/propose': (res) => { reply(res, response) },
      '/cancel': (res) => { reply(res, canceled) },
    }, { handlers: {} })
    ctx.on('approval/request', () => { throw new Error('unexpected approval question') })
    expect(await run()).toMatchObject({ isError: true, error: { info: { code: 'EXEC_APPROVAL_MISMATCH' } } })
    expect(requests).toEqual([proposal, cancellation])
    expect(decisions).toEqual([])
  })

  it.for(['worker cancellation', 'adapter unload'])('withdraws a pending review on %s', async (reason, test) => {
    const { ctx, decisions, requests, readAudit, run, disposeAdapter } = await fixture(test, {
      '/propose': (response) => { reply(response, pendingApproval) },
      '/cancel': (response) => { reply(response, canceled) },
    }, { handlers: {} })
    const prompted = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    ctx.on('approval/request', () => {
      prompted.resolve(undefined)
      return answer.promise
    })
    const abort = new AbortController()
    const running = run(abort.signal)
    await prompted.promise
    if (reason === 'worker cancellation') abort.abort()
    else await disposeAdapter()
    expect(await running).toMatchObject({ isError: true, error: { info: { code: 'EXEC_CANCELLED' } } })
    answer.resolve('allowed-once')
    expect(readAudit()).toMatchObject([
      { type: 'approval/asked' },
      { type: 'approval/decided', data: { outcome: 'cancelled' } },
    ])
    expect(requests).toEqual([proposal, cancellation])
    expect(decisions).toEqual([])
  })

  it('withdraws the proposal after losing the approval decision reply', async (test) => {
    const { ctx, decisions, requests, run } = await fixture(test, {
      '/propose': (response) => { reply(response, pendingApproval) },
      '/cancel': (response) => { reply(response, canceled) },
    }, {
      handlers: { '/decide': (response) => { response.destroy() } },
    })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    expect(await run()).toMatchObject({ isError: true, error: { info: { code: 'EXEC_APPROVAL_UNAVAILABLE' } } })
    expect(requests).toEqual([proposal, cancellation])
    expect(decisions).toEqual([approvalDecision('approve')])
  })
})
