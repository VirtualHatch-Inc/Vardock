/** Exercise Host release validation against replies from the authority socket. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { digestEvidenceEvent } from '@deepseek-ai/dsh-operation-evidence/library'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, type TestContext } from 'vitest'
import UnixHandoffControl, { WorkPrincipalId, type HandoffRequest, type WorkGrant, type WorkId } from '../src/handoff.ts'
import { handoffEvidenceBody, handoffOutcome } from '../src/protocol.ts'

const id = '09901cbc-8cf6-4668-96ee-0e4774e2f872'
const admission = { id: `${id}-admission`, digest: 'a'.repeat(64) }
const workId = brandString<WorkId>('1'.repeat(64))
const permissions = { exec: true, brokerActions: ['submit'] }
const request: HandoffRequest = {
  key: 'tool-call',
  kind: 'delegation',
  sessionId: SessionId('assistant-main'),
  targetSessionId: SessionId('worker'),
  content: JSON.stringify({ prompt: 'Review the report.' }),
  delegation: { workId, previousWorkId: null, permissions },
}
const work: WorkGrant = { workId, previousWorkId: null, sessionId: request.targetSessionId, principalId: WorkPrincipalId('owner'), permissions }

function reply(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
  response.end(JSON.stringify(body))
}

async function fixture(
  test: TestContext,
  handlers: Readonly<Record<string, (response: ServerResponse) => void>>,
) {
  const ctx = new Context()
  const paths: Array<string | undefined> = []
  const server = createServer((request, response) => {
    request.resume().once('end', () => {
      const path = request.url
      paths.push(path)
      const handle = path === undefined ? undefined : handlers[path]
      if (handle === undefined) response.writeHead(404).end()
      else handle(response)
    })
  })
  const root = await mkdtemp(join(tmpdir(), 'op-handoff-'))
  const socketPath = join(root, 'authority.sock')
  test.onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      try {
        if (server.listening) {
          const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) resolve()
              else reject(error)
            })
          })
          server.closeAllConnections()
          await closed
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await ctx.plugin(UnixHandoffControl, { socketPath })
  return { control: ctx.handoffControl, paths }
}

describe.skipIf(process.platform === 'win32')('handoff control over a POSIX socket', () => {
  it.for(['receipt digest', 'target', 'handoff kind', 'content digest', 'work id', 'previous work id', 'work Session', 'permissions', 'missing grant', 'admission digest'])('rejects a settled reply with a different %s', async (mismatch, test) => {
    const grant = mismatch === 'missing grant' ? undefined : {
      ...work,
      workId: mismatch === 'work id' ? brandString<WorkId>('2'.repeat(64)) : work.workId,
      previousWorkId: mismatch === 'previous work id' ? brandString<WorkId>('3'.repeat(64)) : work.previousWorkId,
      sessionId: mismatch === 'work Session' ? SessionId('other-worker') : work.sessionId,
      permissions: mismatch === 'permissions' ? { exec: false, brokerActions: [] } : work.permissions,
    }
    const outcome = handoffOutcome({
      kind: mismatch === 'handoff kind' ? 'delivery' : request.kind,
      targetSessionId: mismatch === 'target' ? SessionId('other-worker') : request.targetSessionId,
      content: mismatch === 'content digest' ? 'other prompt' : request.content,
    }, grant)
    const receiptId = `${id}-outcome`
    const digest = mismatch === 'receipt digest' ? 'a'.repeat(64) : digestEvidenceEvent({
      id: receiptId, operationId: id, kind: 'outcome', body: handoffEvidenceBody(outcome),
    })
    const settledAdmission = mismatch === 'admission digest' ? { ...admission, digest: 'b'.repeat(64) } : admission
    const { control, paths } = await fixture(test, {
      '/propose': (response) => { reply(response, { id, state: 'issued', admission }) },
      '/execute': (response) => { reply(response, { id, state: 'settled', admission: settledAdmission, outcome, receipt: { id: receiptId, digest } }) },
    })
    await expect(control.release(request)).rejects.toMatchObject({ code: 'handoff-mismatch', operationId: id })
    expect(paths).toEqual(['/propose', '/execute'])
  })

  it('returns the authority-resolved work grant when a continuation omits permissions', async (test) => {
    const previousWorkId = brandString<WorkId>('2'.repeat(64))
    const inherited = { ...request, delegation: { workId, previousWorkId } }
    const continued = { ...work, previousWorkId }
    const outcome = handoffOutcome(inherited, continued)
    const receiptId = `${id}-outcome`
    const receipt = { id: receiptId, digest: digestEvidenceEvent({ id: receiptId, operationId: id, kind: 'outcome', body: handoffEvidenceBody(outcome) }) }
    const { control } = await fixture(test, {
      '/propose': (response) => { reply(response, { id, state: 'settled', admission, outcome, receipt }) },
    })
    await expect(control.release(inherited)).resolves.toEqual({ operationId: id, receipt, work: continued })
  })

  it('queries an already running handoff once per release call', async (test) => {
    const running = { id, state: 'running', admission }
    const { control, paths } = await fixture(test, {
      '/propose': (response) => { reply(response, running) },
      '/status': (response) => { reply(response, running) },
    })
    await expect(control.release(request)).rejects.toMatchObject({ code: 'handoff-not-released', operationId: id })
    expect(paths).toEqual(['/propose', '/status'])
  })

  it('stops a canceled Host wait without submitting another operation', async (test) => {
    const executing = Promise.withResolvers<undefined>()
    const { control, paths } = await fixture(test, {
      '/propose': (response) => { reply(response, { id, state: 'issued', admission }) },
      '/execute': () => { executing.resolve(undefined) },
    })
    const wait = new AbortController()
    const rejected = expect(control.release(request, wait.signal)).rejects.toMatchObject({ code: 'handoff-canceled', operationId: id })
    await executing.promise
    wait.abort()
    await rejected
    await expect(control.release(request, wait.signal)).rejects.toMatchObject({ code: 'handoff-canceled' })
    expect(paths).toEqual(['/propose', '/execute'])
  })
})
