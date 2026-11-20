/** Keyless Web profile replay through authority-mediated Codex for an Assistant and its worker Session. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { glob, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect, it, vi, type TestContext } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelCatalog, SessionListValue, SessionWaitValue } from '@deepseek-ai/dsh-api-session-controller'
import type { WorkspaceCreateValue } from '@deepseek-ai/dsh-api-workspace-controller'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { IsolatedExecution, type ContainerId, type IsolatedExecutionLease } from '@deepseek-ai/dsh-execution-container'
import LlmRuntime, { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import * as Codex from '@deepseek-ai/dsh-llm-codex'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import HttpsJsonBroker from '@deepseek-ai/dsh-operation-broker'
import * as OperationControl from '@deepseek-ai/dsh-operation-control'
import {
  OperationControlClient, type OperationProposal, type OperationStatus, type WorkId, type WorkInputFile,
} from '@deepseek-ai/dsh-operation-control/library'
import * as Witness from '@deepseek-ai/dsh-operation-evidence'
import { digestEvidenceEvent } from '@deepseek-ai/dsh-operation-evidence/library'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import {
  type HarvestedLog, fixtureContext, formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizeSessionSnapshots,
  normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { withDefaultWeb, webGet, webRequest } from '../../cli/tests/profiles/web/tests/default-web-process.ts'
import {
  fixtureUserPrompts, normalizeWebSessionVolatiles, recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DIR = join(ROOT, 'snapshots/web/assistant-delegation')
const SAMPLE_DIR = join(ROOT, 'snapshots/web/assistant-sample')
const MAIN = 'assistant-main'
const PRINCIPAL = 'snapshot'
const MODE = webSnapshotMode()
const PLUGINS = ['assistant', 'operation-control'].map(id => ({
  name: `@deepseek-ai/dsh-${id}`, path: join(ROOT, 'packages/experimental', id),
}))

const OPERATION = '09901cbc-8cf6-4668-96ee-0e4774e2f872'
const BUSINESS = 'fa84b7dc-514b-4571-8984-6cf45ba1e43e'
const png = await readFile(join(ROOT, 'snapshots/session/read-image/workspace/red.png'))
const csv = Buffer.from('region,orders,revenue_usd\nNorth,12,480\nSouth,8,320\nWest,15,600\n')
const sampleSummary = Buffer.from('# Sales summary\n\n- Total orders: 35\n- Total revenue: $1400\n- Highest-revenue region: West ($600)\n')
const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')
const execFileAsync = promisify(execFile)

function fixtureFiles(sample: boolean) {
  const name = sample ? 'sample-sales.csv' : 'registration-request.png'
  const data = sample ? csv : png
  const digest = hash(data)
  const artifact = sample ? 'sales-summary.md' : 'japan-report-registration-source-attachment-copy.png'
  const output = sample ? sampleSummary : png
  return { name, data, digest, path: `input/${digest}/${name}`, artifact, output, outputDigest: hash(output) }
}

type FixtureFiles = ReturnType<typeof fixtureFiles>
const FILE_PERMISSIONS = { import: true, export: true, discloseToModel: true, discloseToUser: true, returnResponses: false }
const business = {
  parentId: OPERATION, action: 'register', method: 'POST', endpoint: 'https://service.example/register',
  credentialRef: 'REGISTRATION_TOKEN', body: '{"country":"Japan"}', reconciliationEndpoint: 'https://service.example/registration-status',
}
const businessDigest = createHash('sha256').update(JSON.stringify(Object.values(business))).digest('hex')
const businessPresentation = {
  title: { en: 'Submit the Japan registration?', zh: '提交日本登记？' },
  detail: 'Country\n  Japan',
}

function businessEvidence(id: string, body: Witness.EvidenceJson): Witness.EvidenceReceipt {
  return { id, digest: digestEvidenceEvent({ id, operationId: BUSINESS, kind: 'outcome', body }) }
}

type HandoffProposal = Extract<OperationProposal, { handoff: object }>
type HandoffRecord = OperationStatus & { proposal: HandoffProposal }
type ExpectedHandoff = Omit<HandoffProposal['handoff'], 'content' | 'targetSessionId'> & {
  targetSessionId: string
  content: unknown
}

/** Work the sample scenario delegates directly through the authority so that its records page has one business request. */
const RECORDS_HANDOFF = {
  kind: 'delegation', targetSessionId: 'assistant-records-work', content: { prompt: 'Register one attendee.' },
  delegation: {
    workId: 'e'.repeat(64) as WorkId, previousWorkId: null, permissions: { exec: true, brokerActions: ['register'] },
  },
} as const satisfies ExpectedHandoff

function assertAuthorityRecords(
  databasePath: string, evidencePath: string, expected: readonly ExpectedHandoff[],
  input: WorkInputFile, files: FixtureFiles,
): void {
  using authority = new DatabaseSync(databasePath, { readOnly: true })
  using witness = new DatabaseSync(evidencePath, { readOnly: true })
  const handoffs = authority.prepare(`
    SELECT record FROM operations WHERE json_type(record, '$.proposal.handoff') = 'object' ORDER BY rowid
  `).all().map(({ record }) => {
    if (typeof record !== 'string') throw new Error('The authority did not persist a handoff record')
    return JSON.parse(record) as HandoffRecord
  })
  expect(handoffs.map(({ proposal: { handoff } }) => {
    const content: unknown = JSON.parse(handoff.content)
    return { ...handoff, content }
  })).toEqual(expected)

  const readEvidence = witness.prepare('SELECT event, digest FROM evidence_events WHERE id = ?')
  for (const { id, state, proposal, admission, outcome, receipt } of handoffs) {
    const { kind: handoffKind, targetSessionId, content, delegation } = proposal.handoff
    const contentDigest = createHash('sha256').update(content).digest('hex')
    const release = {
      kind: 'released', handoffKind, targetSessionId, contentDigest,
      ...(delegation === undefined ? {} : { work: { ...delegation, principalId: PRINCIPAL, sessionId: targetSessionId } }),
    }
    expect(state).toBe('settled')
    expect(proposal.sessionId).toBe(MAIN)
    expect(outcome).toEqual(release)
    const admitted: unknown = expect.objectContaining({
      principalId: PRINCIPAL, scopeId: 'codex', sessionId: MAIN, requestKey: proposal.requestKey,
      handoffKind, targetSessionId, contentDigest, ...delegation,
    })
    for (const [kind, body, receiptOfEvent] of [['admission', admitted, admission], ['outcome', release, receipt]] as const) {
      const eventId = `${id}-${kind}`
      const stored = readEvidence.get(eventId)
      if (typeof stored?.event !== 'string') throw new Error(`The witness did not persist ${eventId}`)
      const event = JSON.parse(stored.event) as Witness.EvidenceEvent
      expect(event).toEqual({ id: eventId, operationId: id, kind, body })
      expect(stored.digest).toBe(digestEvidenceEvent(event))
      expect(receiptOfEvent).toEqual({ id: eventId, digest: stored.digest })
    }
  }

  const transfers = authority.prepare(`
    SELECT record FROM operations WHERE json_type(record, '$.proposal.file') = 'object' ORDER BY rowid
  `).all().map(({ record }) => {
    if (typeof record !== 'string') throw new Error('The authority did not persist a file transfer')
    return JSON.parse(record) as OperationStatus
  })
  const binding = expected.find(handoff => handoff.delegation !== undefined)?.delegation
  if (binding === undefined) throw new Error('The fixture did not declare a work grant')
  const observations = [
    { workId: binding.workId, kind: 'file-imported', bytes: files.data.length, digest: files.digest, path: files.path, source: input },
    { workId: binding.workId, kind: 'file-exported', bytes: files.output.length, digest: files.outputDigest, path: files.artifact, targetSessionId: MAIN },
  ]
  expect(transfers).toHaveLength(observations.length)
  for (const [index, { id, state, outcome, receipt }] of transfers.entries()) {
    expect(state).toBe('settled')
    const body = observations[index]
    expect(outcome).toMatchObject(body!)
    const eventId = `${id}-outcome`
    const stored = readEvidence.get(eventId)
    if (typeof stored?.event !== 'string') throw new Error(`The witness did not persist ${eventId}`)
    const event = JSON.parse(stored.event) as Witness.EvidenceEvent
    expect(event).toEqual({ id: eventId, operationId: id, kind: 'outcome', body })
    expect(receipt).toEqual({ id: eventId, digest: digestEvidenceEvent(event) })
  }
}

async function authorityFixture(
  test: TestContext, sessionPaths: readonly string[], workId: string, files: FixtureFiles, sampleScript?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-operation-snapshot-'))
  const socketPath = join(root, 'a.sock')
  const modelSocketPath = join(root, 'm.sock')
  const approvalSocketPath = join(root, 'p.sock')
  const grantSocketPath = join(root, 'q.sock')
  const evidenceSocketPath = join(root, 'e.sock')
  const databasePath = join(root, 'operations.sqlite')
  const evidencePath = join(root, 'evidence.sqlite')
  const ctx = new Context()
  let imported: { sessionId: SessionId; data: Uint8Array } | undefined
  let artifact: Uint8Array | undefined
  const sample = sampleScript !== undefined
  class Workspace extends IsolatedExecution {
    readonly reservedPaths = []

    open(): IsolatedExecutionLease {
      return {
        ready: Promise.resolve({ fingerprint: 'b'.repeat(64), maxCommandBytes: 32_768, maxOutputBytes: 131_072, supportsBroker: true }),
        // Delegated scripts run on the fixture execution socket; only the records scenario runs one here.
        async run(_session, _command, signal, broker) {
          if (broker === undefined) throw new Error('The records scenario submits a business request')
          await broker({ requestKey: randomUUID(), action: business.action, body: business.body }, signal)
          return {
            exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
            containerId: 'b'.repeat(64) as ContainerId, stopped: true,
          }
        },
        async transfer(sessionId, request, signal) {
          signal.throwIfAborted()
          if (request.kind === 'import' && request.path === files.path) {
            imported = { sessionId, data: request.data.slice() }
            return { kind: 'imported', bytes: request.data.length, digest: createHash('sha256').update(request.data).digest('hex') }
          }
          if (request.kind !== 'export' || request.path !== files.artifact || imported?.sessionId !== sessionId || artifact === undefined) {
            throw new Error('The fixture workspace has no requested file')
          }
          return { kind: 'exported', bytes: artifact.length, digest: createHash('sha256').update(artifact).digest('hex'), data: artifact }
        },
        async dispose() {},
      }
    }
  }
  let closing: Promise<void> | undefined
  const closeAuthority = () => closing ??= ctx.fiber.dispose()
  // The shell receipt appears verbatim in recorded model history.
  const admission = { id: `${OPERATION}-admission`, digest: 'a'.repeat(64) }
  const issued = { id: OPERATION, state: 'issued', admission }
  const settled = {
    ...issued, state: 'settled',
    outcome: {
      kind: 'exited',
      observation: {
        exitCode: sample ? 0 : 1, stdout: sample ? '' : `Operation ${BUSINESS}: broker-outcome-unavailable\n`,
        stderr: '', stdoutTruncated: false, stderrTruncated: false,
        containerId: 'b'.repeat(64), stopped: true,
      },
    },
    receipt: { id: `${OPERATION}-outcome`, digest: 'c'.repeat(64) },
  }
  const requests: { method: string | undefined; path: string | undefined; body: unknown }[] = []
  const attribution = { workId, principalId: PRINCIPAL }
  let review: { sessionId: string; command: string; revision: string; payloadDigest: string } | undefined
  let approved = sample
  let businessApproved = false
  let executionResponse: ServerResponse | undefined
  const waiting = new Set<ServerResponse>()
  const businessIssued = { id: BUSINESS, state: 'issued', admission: { id: `${BUSINESS}-admission`, digest: 'e'.repeat(64) } }
  const dispatchOutcome = { kind: 'unknown', code: 'broker-response-unavailable' }
  const businessUnknown = {
    ...businessIssued, state: 'unknown', outcome: dispatchOutcome,
    receipt: businessEvidence(`${BUSINESS}-outcome`, dispatchOutcome),
  }
  const pending = { kind: 'pending' }
  const succeeded = { kind: 'succeeded', receiptId: 'japan-registration-42' }
  const completions = [
    { kind: 'unconfirmed' },
    { ...pending, receipt: businessEvidence(
      `${BUSINESS}-reconcile-091df0f3-1cce-4531-98ea-ad3af65c9662-outcome`, { fact: 'business-reconciliation', ...pending },
    ) },
    { ...succeeded, receipt: businessEvidence(
      `${BUSINESS}-reconcile-ef3e32fd-b87b-4a0f-ad0a-f308f36ff284-outcome`, { fact: 'business-reconciliation', ...succeeded },
    ) },
  ]
  let lookups = 0
  const businessStatus = (sessionId: string) => ({
    id: BUSINESS, approval: 'approved', sessionId, action: business.action, state: businessUnknown.state,
    outcome: dispatchOutcome, receipt: businessUnknown.receipt,
    canReconcile: lookups < completions.length - 1, businessCompletion: completions[lookups],
  })
  const send = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify(value))
  }
  const sendReview = (response: ServerResponse) => { send(response, { review: {
    id: BUSINESS, state: 'pending-approval', review: {
      ...attribution, sessionId: review!.sessionId, business, presentation: businessPresentation,
      revision: 'd'.repeat(64), payloadDigest: businessDigest,
    },
  } }) }
  const server = createServer((request, response) => {
    request.setEncoding('utf8')
    let text = ''
    request.on('data', (chunk: string) => { text += chunk })
    request.once('end', () => {
      const body: unknown = JSON.parse(text)
      if (request.url === '/wait-review') {
        if (executionResponse !== undefined && !businessApproved) sendReview(response)
        else {
          waiting.add(response)
          response.once('close', () => { waiting.delete(response) })
        }
        return
      }
      requests.push({ method: request.method, path: request.url, body })
      let value: unknown
      if (request.url === '/propose') {
        const proposal = body as { sessionId: string; command: string }
        review = { sessionId: proposal.sessionId, command: proposal.command, revision: 'd'.repeat(64), payloadDigest: createHash('sha256').update(proposal.command).digest('hex') }
        value = sample ? issued : { id: OPERATION, state: 'pending-approval', review: { ...attribution, ...review } }
      } else if (request.url === '/cancel' && JSON.stringify(body) === JSON.stringify({ id: OPERATION })) {
        value = { id: OPERATION, state: 'canceled' }
      } else if (request.url === '/execute' && approved && imported !== undefined
        && imported.sessionId === review?.sessionId && files.data.equals(imported.data)) {
        if (sampleScript !== undefined && review.command === sampleScript) {
          const runSample = async (data: Uint8Array): Promise<void> => {
            const cwd = join(root, 'sample-workspace')
            const source = join(cwd, files.path)
            await mkdir(dirname(source), { recursive: true })
            await writeFile(source, data)
            const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', sampleScript], {
              cwd, env: { PATH: '/usr/bin:/bin' }, signal: test.signal,
            })
            artifact = await readFile(join(cwd, files.artifact))
            send(response, { ...settled, outcome: { ...settled.outcome, observation: { ...settled.outcome.observation, stdout, stderr } } })
          }
          void runSample(imported.data).catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) })
          return
        }
        artifact = imported.data
        executionResponse = response
        for (const waitingResponse of waiting) sendReview(waitingResponse)
        waiting.clear()
        return
      } else if (request.url === '/status' && businessApproved) {
        value = businessUnknown
      } else if (request.url === '/business-operations' && businessApproved && review !== undefined) {
        value = { sessionId: review.sessionId, operations: [businessStatus(review.sessionId)] }
      } else if (request.url === '/reconcile' && businessApproved && review !== undefined && lookups < completions.length - 1) {
        lookups++
        value = businessStatus(review.sessionId)
      }
      response.writeHead(value === undefined ? 404 : 200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(value))
    })
  })
  const approvalServer = createServer((request, response) => {
    request.setEncoding('utf8')
    let text = ''
    request.on('data', (chunk: string) => { text += chunk })
    request.once('end', () => {
      const body: unknown = JSON.parse(text)
      requests.push({ method: request.method, path: request.url, body })
      if (request.url === '/decide' && review !== undefined && JSON.stringify(body) === JSON.stringify({
        id: BUSINESS, revision: review.revision, payloadDigest: businessDigest, decision: 'approve',
      })) {
        businessApproved = true
        send(response, businessIssued)
        send(executionResponse!, settled)
        return
      }
      approved = request.url === '/decide' && review !== undefined && JSON.stringify(body) === JSON.stringify({
        id: OPERATION, revision: review.revision, payloadDigest: review.payloadDigest, decision: 'approve',
      })
      response.writeHead(approved ? 200 : 403, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(approved ? issued : { code: 'approval-mismatch', message: 'Approval does not match.' }))
    })
  })
  test.onTestFinished(async () => {
    try {
      for (const listener of [approvalServer, server]) {
        if (listener.listening) {
          const closed = new Promise<void>((resolve, reject) => {
            listener.close((error) => { if (error) reject(error); else resolve() })
          })
          listener.closeAllConnections()
          await closed
        }
      }
    } finally {
      try {
        await closeAuthority()
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

  await new Promise<void>((resolve, reject) => {
    approvalServer.once('error', reject)
    approvalServer.listen(approvalSocketPath, () => {
      approvalServer.off('error', reject)
      resolve()
    })
  })

  const command = join(root, 'codex-fixture')
  const fixture = fileURLToPath(new URL('./fixtures/assistant-codex-app-server.mjs', import.meta.url))
  const argv = [process.execPath, fixture, ...sessionPaths].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')
  await writeFile(command, `#!/bin/sh\nunset DEEPSEEK_API_KEY OPENAI_API_KEY CODEX_API_KEY\nexec ${argv} "$@"\n`, { mode: 0o700 })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Codex, { command })
  await ctx.plugin(Witness, { socketPath: evidenceSocketPath, databasePath: evidencePath })
  await ctx.plugin(Workspace)
  await ctx.plugin(LocalCredentials, { dshHome: root, watch: false })
  await ctx.plugin(HttpsJsonBroker, { routes: [{
    action: 'register', description: 'Register one attendee.', endpoint: business.endpoint, credentialRef: business.credentialRef,
  }] })
  vi.spyOn(ctx.operationBroker, 'run').mockResolvedValue({ kind: 'http-response', statusCode: 202 })
  await ctx.plugin(OperationControl, {
    broker: ['operationBroker'],
    principalId: PRINCIPAL, scopeId: 'codex', socketPath: modelSocketPath, evidenceSocketPath,
    approvalSocketPath: grantSocketPath,
    databasePath, grantExpiresAt: Date.UTC(2099, 0, 1), maxOperations: 24,
    model: { provider: 'codex-local', model: 'default' },
    assistant: { mainSessionId: MAIN, permissions: {
      exec: true, brokerActions: ['register'], data: { ...FILE_PERMISSIONS, returnResponses: true },
    } },
  })
  return {
    socketPath, modelSocketPath, approvalSocketPath, grantSocketPath, requests,
    async assertRecords(expected: readonly ExpectedHandoff[], input: WorkInputFile) {
      // Both services hold exclusive SQLite locks until disposal completes.
      await closeAuthority()
      assertAuthorityRecords(databasePath, evidencePath, expected, input, files)
    },
  }
}

// The fixture command uses a POSIX executable wrapper.
it.skipIf(MODE === 'record' || process.platform === 'win32').for([
  { name: 'replays Assistant delegation with witnessed files and business completion through local Codex', stop: false, sample: false },
  { name: 'stops Assistant work while its shell approval is pending', stop: true, sample: false },
  { name: 'runs the Assistant sample from composer to witnessed Markdown', stop: false, sample: true },
])('$name', async ({ stop, sample }, test) => {
  const scenario = sample ? SAMPLE_DIR : DIR
  const files = fixtureFiles(sample)
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl'].map(name => selectedSessionFixture(join(scenario, name))))
  let expected = await Promise.all(paths.map(file => readFile(file, 'utf8')))
  const [prompt, followup] = fixtureUserPrompts(expected[0]!)
  const mainEvents = parseSessionLog(expected[0]!)
  const [, second, third] = mainEvents.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  const final = sample ? second : third
  if (prompt === undefined || second === undefined || final === undefined || (!sample && followup === undefined)) {
    throw new Error('assistant fixture is missing its user prompts or status replies')
  }
  const delegate = mainEvents.find(event => event.type === 'tool/call' && event.data.name === 'delegate_work')
  if (delegate?.type !== 'tool/call') throw new Error('assistant fixture is missing its delegation call')
  type Delegation = NonNullable<HandoffProposal['handoff']['delegation']>
  const { permissions, inputs } = JSON.parse(delegate.data.arguments) as Pick<Delegation, 'permissions'> & { inputs: { seq: number; index: number }[] }
  expect(permissions).toEqual({ exec: true, brokerActions: sample ? [] : ['register'], data: FILE_PERMISSIONS })
  expect(inputs).toHaveLength(1)
  const input: WorkInputFile = {
    attachmentId: files.digest, name: files.name, bytes: files.data.length, messageSeq: inputs[0]!.seq, contentIndex: inputs[0]!.index,
  }
  const accepted = mainEvents.find(event => event.type === 'tool/result' && event.data.message.toolCallId === delegate.data.callId)
  const workReceipt = accepted?.type === 'tool/result' && accepted.data.message.content.find(block => block.type === 'text')?.text
  if (typeof workReceipt !== 'string') throw new Error('assistant fixture is missing its delegation receipt')
  const { id: workId, previous, prompt: workPrompt, preset, permission } = JSON.parse(workReceipt) as {
    id: Delegation['workId']
    previous: string | null
    prompt: string
    preset: string | null
    permission: string
  }
  const workAttribution = `Work ${workId.slice(0, 8)}… (principal ${PRINCIPAL})`
  const exec = parseSessionLog(expected[1]!).find(event => event.type === 'tool/call' && event.data.name === 'exec')
  if (exec?.type !== 'tool/call') throw new Error('assistant fixture is missing its worker exec call')
  const { command: script } = JSON.parse(exec.data.arguments) as { command: string }
  const authority = await authorityFixture(test, paths, workId, files, sample ? script : undefined)
  const patches = [
    fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    join(ROOT, 'packages/experimental/assistant/cordis.patch.yml'),
  ]
  await withDefaultWeb(test, async ({ root, url }) => {
    const auth = await webGet(url, test.signal)
    const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Web profile did not issue an authentication cookie')
    async function rpc<Value>(endpoint: string, args: object): Promise<Value> {
      const response = await webRequest(new URL('/api/' + endpoint, url), test.signal, {
        method: 'POST', headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
      })
      const envelope = JSON.parse(response.text) as { result: { ok: true; value: Value } | { ok: false; error: { message: string } } }
      if (!envelope.result.ok) throw new Error(`${endpoint}: ${envelope.result.error.message}`)
      return envelope.result.value
    }
    const catalog = await rpc<ModelCatalog>('session/modelCatalog', {})
    expect(catalog.default).toEqual({ provider: 'codex-local', model: 'default' })
    expect(catalog.routableProviders).toEqual(['codex-local'])
    const { sessionId } = await rpc<{ sessionId: string }>('assistant/entrance', {})
    expect(sessionId).toBe(MAIN)
    const browser = await chromium.launch({ timeout: test.task.timeout })
    test.onTestFinished(async () => { await browser.close() })
    const page = await newEnglishPage(browser)
    expect((await page.goto(url))?.status()).toBe(200)
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    await composer.waitFor()
    const workStatus = page.locator('[data-assistant-work]')
    const workToggle = workStatus.getByRole('button', { name: 'Assistant work', exact: true })
    const budget = workStatus.locator('[data-assistant-budget]')
    await budget.waitFor()
    expect(await budget.innerText()).toBe('24 left · 0 of 24 reserved')
    const screenshots = process.env.DSH_ASSISTANT_SCREENSHOT_DIR
    if (sample) {
      const sampleButton = workStatus.getByRole('button', { name: 'Try sample', exact: true })
      await sampleButton.waitFor()
      await composer.fill('Keep my draft')
      await expect.poll(() => sampleButton.isEnabled()).toBe(false)
      expect(await composer.innerText()).toBe('Keep my draft')
      // Clear through editor keystrokes: fill('') presses Delete before the editor observes its DOM selection.
      await composer.press('ControlOrMeta+a')
      await composer.press('Backspace')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'sample-entry.png'), animations: 'disabled' })
      await sampleButton.click()
      expect(await composer.innerText()).toBe(prompt)
      await page.getByRole('group', { name: 'Pending attachments' }).getByTitle(files.name).waitFor()
      expect(authority.requests).toEqual([])
      await page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(() => workStatus.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
      if (screenshots !== undefined) {
        await page.screenshot({ path: join(screenshots, 'sample-draft-narrow.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'sample-draft-narrow-dark.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'light' })
      }
      await page.setViewportSize({ width: 1680, height: 1000 })
    } else {
      const picker = page.locator('input[type="file"]')
      await expect.poll(() => picker.isEnabled()).toBe(true)
      await picker.setInputFiles({ name: files.name, mimeType: 'image/png', buffer: files.data })
      await page.getByRole('group', { name: 'Pending attachments' }).getByTitle(files.name).waitFor()
      await composer.fill(prompt)
    }
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const approval = page.locator('[data-approval-key]')
    if (!sample) {
      await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor()
      await approval.getByText(`Run this shell script in the isolated /workspace? ${workAttribution} requested it.`, { exact: true }).waitFor()
      expect(await approval.locator('pre').first().textContent()).toBe(script)
      await approval.getByText('Full details', { exact: true }).click()
      expect(await approval.locator('details[open] pre').textContent()).toContain(workId)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'approval-full-details.png'), animations: 'disabled' })
      await approval.getByText('Full details', { exact: true }).click()
      expect(authority.requests.map(request => request.path)).toEqual(['/propose'])
      await workStatus.locator('[data-assistant-approval]').waitFor()
      await workToggle.click()
      const running = workStatus.locator(`[data-assistant-work-id="${workId}"][data-work-status="running"]`)
      const stopWork = running.getByRole('button', { name: 'Stop work', exact: true })
      await stopWork.waitFor()
      if (stop) {
        await stopWork.click()
        const stopped = workStatus.locator(`[data-assistant-work-id="${workId}"][data-work-status="canceled"]`)
        await stopped.getByText('Work stopped', { exact: true }).waitFor()
        await page.locator('[data-approval-key]').waitFor({ state: 'hidden' })
        await expect.poll(() => authority.requests.map(request => request.path)).toEqual(['/propose', '/cancel'])
        await page.getByText('The work was stopped.', { exact: true }).waitFor()
        if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'work-stopped.png'), animations: 'disabled' })
        return
      }
      await workToggle.click()
      if (screenshots !== undefined && !sample) await page.screenshot({ path: join(screenshots, 'approval.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Assistant', exact: true }).waitFor({ state: 'hidden' })
      await expect.poll(() => page.locator('[data-approval-scroll]').evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
      await workToggle.click()
      await stopWork.click({ trial: true })
      await expect.poll(() => workStatus.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
      if (screenshots !== undefined && !sample) await page.screenshot({ path: join(screenshots, 'work-status-approval-narrow.png'), animations: 'disabled' })
      await workToggle.click()
      if (screenshots !== undefined && !sample) {
        await page.screenshot({ path: join(screenshots, 'approval-narrow.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'approval-dark.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'light' })
      }
      await page.setViewportSize({ width: 1680, height: 1000 })
      await page.getByRole('button', { name: 'Allow once', exact: true }).click()
    }
    if (sample) {
      await page.getByText(final, { exact: true }).waitFor()
      expect((await page.goto(url))?.status()).toBe(200)
      await page.getByText(final, { exact: true }).waitFor()
      await workToggle.click()
      const row = workStatus.locator(`[data-assistant-work-id="${workId}"][data-work-status="completed"]`)
      await row.getByText('Worker report', { exact: true }).waitFor()
      expect(await row.getByText('External operations', { exact: true }).count()).toBe(0)
      const workFiles = row.getByRole('list', { name: 'Work artifacts' })
      const preview = workFiles.locator('[data-assistant-artifact-preview]')
      const previewButton = workFiles.getByRole('button', { name: `Preview ${files.artifact}`, exact: true })
      await page.route('**/api/assistant-artifact?*', route => route.fulfill({ status: 503 }), { times: 1 })
      await previewButton.click()
      await workFiles.getByRole('alert').getByText('Couldn’t preview this file. Try downloading it.').waitFor()
      await workFiles.getByRole('button', { name: `Hide preview of ${files.artifact}`, exact: true }).click()
      await previewButton.click()
      await preview.waitFor()
      expect(await preview.textContent()).toBe(files.output.toString('utf8'))
      const link = workFiles.getByRole('link', { name: `${files.artifact} Download`, exact: true })
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
      expect(download.suggestedFilename()).toBe(files.artifact)
      const downloaded = await download.path()
      if (downloaded === null) throw new Error('The browser did not save the sample output')
      expect(await readFile(downloaded)).toEqual(files.output)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'sample-work-preview.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 390, height: 844 })
      await workFiles.getByRole('button', { name: `Hide preview of ${files.artifact}`, exact: true }).click()
      await previewButton.click()
      await preview.waitFor()
      await expect.poll(() => workStatus.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
      await expect.poll(() => preview.evaluate((element) => {
        const rows = element.closest('[data-assistant-work-id]')?.parentElement?.getBoundingClientRect()
        const previewRect = element.getBoundingClientRect()
        return rows !== undefined && previewRect.top >= rows.top - 1 && previewRect.bottom <= rows.bottom + 1
      })).toBe(true)
      if (screenshots !== undefined) {
        await page.screenshot({ path: join(screenshots, 'sample-work-preview-narrow.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'sample-work-preview-narrow-dark.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'light' })
      }
      await workToggle.click()
      const grant = workStatus.getByRole('button', { name: 'Usage settings', exact: true })
      await grant.click()
      const limit = workStatus.getByRole('spinbutton', { name: 'Total reservation limit', exact: true })
      const expiry = workStatus.getByLabel('Expires at (local time)', { exact: true })
      await expect.poll(() => limit.inputValue()).toBe('24')
      const ownerAuthority = new OperationControlClient({ socketPath: authority.grantSocketPath })
      const before = await ownerAuthority.grant(test.signal)
      expect(before.reserved).toBeGreaterThan(0)
      await limit.fill('32')
      await expiry.fill('2098-01-01T00:00')
      await expect.poll(() => workStatus.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
      expect(await composer.isEditable()).toBe(true)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'usage-settings-narrow.png'), animations: 'disabled' })
      await workStatus.getByRole('button', { name: 'Save limits', exact: true }).click()
      await expect.poll(() => budget.innerText()).toBe(`${32 - before.reserved} left · ${before.reserved} of 32 reserved`)
      const after = await ownerAuthority.grant(test.signal)
      expect(after).toMatchObject({ maxOperations: 32, reserved: before.reserved })
      expect(after.expiresAt).toBe(await expiry.evaluate(element => new Date((element as HTMLInputElement).value).valueOf()))
      expect(after.revision).not.toBe(before.revision)
      if (screenshots !== undefined) {
        await page.setViewportSize({ width: 1680, height: 1000 })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'usage-settings-dark.png'), animations: 'disabled' })
      }
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.route('**/api/assistant/workStatus', async (route) => {
        const response = await route.fetch()
        const envelope = await response.json() as { result: { value: { authority: unknown } } }
        envelope.result.value.authority = { kind: 'unavailable', code: 'configuration-evidence-unavailable' }
        await route.fulfill({ response, json: envelope })
      })
      await workStatus.getByRole('button', { name: 'Refresh status', exact: true }).click()
      const witnessNotice = "The witness service is not confirming records. This request did not run or send anything. Check Vardock's services with pnpm vardock doctor. Vardock recovers automatically when the witness returns."
      await workStatus.getByText(witnessNotice, { exact: true }).waitFor()
      if (screenshots !== undefined) {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.screenshot({ path: join(screenshots, 'witness-status-narrow.png'), animations: 'disabled' })
        await page.setViewportSize({ width: 1280, height: 900 })
      }
      await page.unroute('**/api/assistant/workStatus')
      await workStatus.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await workStatus.getByText(witnessNotice, { exact: true }).waitFor({ state: 'hidden' })
      await page.route('**/api/assistant/connections', async (route) => {
        const response = await route.fetch()
        const envelope = await response.json() as { result: unknown }
        envelope.result = { ok: false, error: { code: 'assistant/work-unavailable', message: 'Unconfirmed configuration',
          details: { reason: 'configuration-evidence-unavailable' } } }
        await route.fulfill({ response, json: envelope })
      }, { times: 1 })
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.getByText('Connections', { exact: true }).click()
      await page.getByText(witnessNotice, { exact: true }).waitFor()
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'witness-connections.png'), animations: 'disabled' })
      await page.getByRole('button', { name: 'Read current connections', exact: true }).click()
      const connection = page.locator('[data-assistant-connection="register"]')
      await connection.getByText('Register one attendee.', { exact: true }).waitFor()
      await connection.getByText('Not configured', { exact: true }).waitFor()
      await connection.locator('input[type="password"]').fill('fixture-registration-token')
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'connections.png'), animations: 'disabled' })
      await connection.getByRole('button', { name: 'Save token', exact: true }).click()
      await connection.getByText('Configured', { exact: true }).waitFor()
      await connection.getByText('Every request waits for your approval.', { exact: true }).waitFor()
      await connection.getByRole('button', { name: 'Send without approval', exact: true }).click()
      await connection.getByText('Every request is sent without approval.', { exact: true }).waitFor()
      expect(await ownerAuthority.brokerConnections(test.signal)).toMatchObject({ connections: [{ action: 'register', unattended: [{}] }] })
      await connection.getByRole('button', { name: 'Stop sending without approval', exact: true }).click()
      await connection.getByText('Every request waits for your approval.', { exact: true }).waitFor()
      await page.getByText('Your first rule change here saves the rules shown for every action in place of the profile’s rules. Each action’s rules apply only while that action stays as it was when they were saved.', { exact: true }).waitFor()
      await connection.getByLabel('Send without approval when (optional)', { exact: true }).fill('{"event":"E1"}')
      await connection.getByRole('button', { name: 'Send without approval', exact: true }).click()
      await connection.getByText('It may contain no other fields.', { exact: true }).waitFor()
      expect(await ownerAuthority.brokerConnections(test.signal)).toMatchObject({
        connections: [{ action: 'register', unattended: [{ match: { event: 'E1' }, allow: [] }] }],
      })
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'connections-no-other-fields.png'), animations: 'disabled' })
      await connection.getByRole('button', { name: 'Stop sending without approval', exact: true }).click()
      await connection.getByText('Every request waits for your approval.', { exact: true }).waitFor()
      await connection.getByLabel('Send without approval when (optional)', { exact: true }).fill('{"event":"E1"}')
      await connection.getByLabel('Other fields the request may contain (optional)', { exact: true }).fill('name, email')
      await connection.getByRole('button', { name: 'Send without approval', exact: true }).click()
      expect(await connection.getByText('Other fields it may contain: name, email. Their values are not checked.', { exact: true }).locator('..').textContent()).toBe(
        'Sent without approval when event = "E1". Other fields it may contain: name, email. Their values are not checked. Other requests wait for your approval. Stop sending without approval',
      )
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'connections-rule.png'), animations: 'disabled' })
      expect(await ownerAuthority.brokerConnections(test.signal)).toMatchObject({
        connections: [{ action: 'register', unattended: [{ match: { event: 'E1' }, allow: ['name', 'email'] }] }],
      })
      await connection.getByRole('button', { name: 'Stop sending without approval', exact: true }).click()
      await connection.getByText('Every request waits for your approval.', { exact: true }).waitFor()
      expect(await ownerAuthority.brokerConnections(test.signal)).toMatchObject({
        unattendedShell: false, connections: [{
          action: 'register', description: 'Register one attendee.', credentialRef: business.credentialRef, configured: true,
          returnsResponse: false, unattended: [], routeChangedSinceRulesSaved: false,
        }],
      })
      const decide = (status: OperationStatus | undefined, decision: 'approve' | 'deny') => {
        if (status?.review === undefined) throw new Error('The records scenario expected a review')
        const { revision, payloadDigest } = status.review
        return ownerAuthority.decide({ id: status.id, decision, revision, payloadDigest }, test.signal)
      }
      const operations = new OperationControlClient({ socketPath: authority.modelSocketPath })
      const { kind, targetSessionId, content, delegation } = RECORDS_HANDOFF
      await operations.execute((await operations.propose({
        requestKey: hash('records-delegation'), sessionId: MAIN as SessionId,
        handoff: { kind, targetSessionId: targetSessionId as SessionId, content: JSON.stringify(content), delegation },
      }, test.signal)).id, test.signal)
      const shell = await operations.propose({ requestKey: randomUUID(), sessionId: targetSessionId as SessionId, command: 'register' }, test.signal)
      await decide(shell, 'approve')
      const review = operations.waitReview(shell.id, test.signal)
      const execution = operations.execute(shell.id, test.signal)
      await decide(await review, 'approve')
      await execution
      await page.getByRole('button', { name: 'Back to plugins', exact: true }).click()
      await page.getByText('Business records', { exact: true }).click()
      const record = page.locator('[data-assistant-record]')
      await record.getByText('Approved', { exact: true }).waitFor()
      await record.getByRole('button', { name: 'I checked: it happened', exact: true }).waitFor()
      await record.getByRole('button', { name: 'I checked: it did not happen', exact: true }).waitFor()
      expect(await record.count()).toBe(1)
      expect(await record.locator('h3').innerText()).toBe(business.action)
      await record.getByText('Request', { exact: true }).click()
      expect(await record.locator('pre').textContent()).toBe(`POST ${business.endpoint}\n\n${business.body}`)
      if (screenshots !== undefined) {
        await page.emulateMedia({ colorScheme: 'light' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('light')
        await page.screenshot({ path: join(screenshots, 'records.png'), animations: 'disabled' })
        await page.setViewportSize({ width: 390, height: 844 })
        await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
        await page.screenshot({ path: join(screenshots, 'records-narrow.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'records-narrow-dark.png'), animations: 'disabled' })
      }
      await record.getByRole('button', { name: 'I checked: it happened', exact: true }).click()
      await record.getByText('The owner checked: it happened', { exact: true }).waitFor()
      expect(await record.getByRole('button').count()).toBe(0)
      expect((await ownerAuthority.businessRecords(undefined, test.signal)).records[0]?.businessCompletion)
        .toMatchObject({ kind: 'succeeded', source: 'owner' })
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'records-owner-outcome.png'), animations: 'disabled' })
      expect(authority.requests.map(request => request.path)).toEqual(['/propose', '/execute'])
      expect(await page.locator('[data-approval-key]').count()).toBe(0)
      return
    }
    await approval.getByText(`${businessPresentation.title.en} ${workAttribution} requested it.`, { exact: true }).waitFor()
    expect(await approval.locator('pre').first().textContent()).toBe(
      `POST ${business.endpoint}\nCredential: ${business.credentialRef}\nStatus lookup: GET ${business.reconciliationEndpoint}\n\n${businessPresentation.detail}\n\nJSON\n${business.body}`,
    )
    if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'business-approval.png'), animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => approval.locator('[data-approval-scroll]').evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
    if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'business-approval-narrow.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await page.setViewportSize({ width: 1680, height: 1000 })

    await expect.poll(async () => {
      const settled = await rpc<SessionWaitValue>('session/wait', { request: { sessionId: MAIN, timeoutMs: 500 } })
      return settled.reason === 'idle' && JSON.stringify(settled.output.records).includes(second)
    }, { timeout: test.task.timeout }).toBe(true)
    expect(authority.requests.map(request => request.path).slice(-2)).toEqual(['/business-operations', '/reconcile'])
    expect(await rpc('session/prompt', {
      request: { sessionId, requestId: 'assistant-replay-followup', mode: 'queue', content: [{ type: 'text', text: followup }] },
    })).toEqual({ accepted: true })
    await expect.poll(async () => {
      const settled = await rpc<SessionWaitValue>('session/wait', { request: { sessionId: MAIN, timeoutMs: 500 } })
      return settled.reason === 'idle' && JSON.stringify(settled.output.records).includes(final)
    }, { timeout: test.task.timeout }).toBe(true)
    const listed = await rpc<SessionListValue>('session/list', { _request: {} })
    expect(listed.items.map(item => item.sessionId)).toContain(MAIN)
    const worker = listed.items.find(item => item.sessionId.startsWith('assistant-work-'))
    if (worker === undefined) throw new Error('delegation did not create an ordinary work Session')
    const settled = await rpc<SessionWaitValue>('session/wait', { request: { sessionId: worker.sessionId } })
    expect(settled.reason).toBe('idle')
    const proposed = authority.requests[0]?.body
    if (typeof proposed !== 'object' || proposed === null || !('requestKey' in proposed)) {
      throw new Error('The worker did not propose execution to the authority')
    }
    expect(proposed.requestKey).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    expect(authority.requests).toEqual([
      { method: 'POST', path: '/propose', body: { requestKey: proposed.requestKey, sessionId: worker.sessionId, command: script } },
      { method: 'POST', path: '/decide', body: {
        id: OPERATION, revision: 'd'.repeat(64), payloadDigest: createHash('sha256').update(script).digest('hex'), decision: 'approve',
      } },
      { method: 'POST', path: '/execute', body: { id: OPERATION } },
      { method: 'POST', path: '/decide', body: { id: BUSINESS, revision: 'd'.repeat(64), payloadDigest: businessDigest, decision: 'approve' } },
      { method: 'POST', path: '/status', body: { id: BUSINESS } },
      { method: 'POST', path: '/business-operations', body: { sessionId: worker.sessionId } },
      { method: 'POST', path: '/reconcile', body: { sessionId: worker.sessionId, id: BUSINESS } },
      { method: 'POST', path: '/business-operations', body: { sessionId: worker.sessionId } },
      { method: 'POST', path: '/reconcile', body: { sessionId: worker.sessionId, id: BUSINESS } },
    ])
    for (const mode of ['queue', 'steer']) {
      await expect(rpc('session/prompt', { request: {
        sessionId: worker.sessionId, requestId: `direct-${mode}`, mode,
        content: [{ type: 'text', text: 'Bypass the Assistant' }],
      } })).rejects.toThrow('assistant/entrance-required')
    }
    for (const action of ['cancel', 'fork']) {
      await expect(rpc(`session/${action}`, { request: { sessionId: worker.sessionId } }))
        .rejects.toThrow('assistant/entrance-required')
    }
    await expect(rpc('session/updateQueue', { request: {
      sessionId: worker.sessionId, itemId: 'delegated-request',
      action: { kind: 'edit', content: [{ type: 'text', text: 'Replace the delegated request' }] },
    } })).rejects.toThrow('assistant/entrance-required')
    const placement = await rpc<WorkspaceCreateValue>('workspace/create', { request: { path: root } })
    expect(placement.created).toBe(false)
    expect(placement.workspace.sessionIds).toEqual(expect.arrayContaining([sessionId, worker.sessionId]))

    const workerTitle = worker.projections?.values.title
    if (typeof workerTitle !== 'string') throw new Error('work Session is missing its title')
    try {
      expect((await page.goto(url))?.status()).toBe(200)
      await page.getByText(final, { exact: true }).waitFor()
      const artifacts = page.locator(`[data-assistant-artifacts="${workId}"]`)
      const link = artifacts.getByRole('link', { name: `${files.artifact} Download`, exact: true })
      await link.waitFor()
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
      expect(download.suggestedFilename()).toBe(files.artifact)
      const downloaded = await download.path()
      if (downloaded === null) throw new Error('The browser did not save the artifact')
      expect(await readFile(downloaded)).toEqual(files.output)
      if (screenshots !== undefined) {
        await page.screenshot({ path: join(screenshots, 'artifact-light.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'artifact-dark.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'light' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('light')
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await link.scrollIntoViewIfNeeded()
      await expect.poll(() => artifacts.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'artifact-narrow.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 1680, height: 1000 })
      const artifactUrl = new URL(`/api/assistant-artifact?workId=${workId}&index=0`, url)
      expect((await webGet(artifactUrl.href, test.signal)).status).toBe(401)
      artifactUrl.searchParams.set('index', '../' + files.artifact)
      expect((await webGet(artifactUrl.href, test.signal, { cookie })).status).toBe(400)
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
      const entranceButton = page.getByRole('button', { name: 'Assistant', exact: true })
      await entranceButton.waitFor()
      await workToggle.click()
      const reported = workStatus.locator(`[data-assistant-work-id="${workId}"][data-work-status="needs_input"]`)
      const inspectSession = reported.getByRole('button', { name: 'Inspect session', exact: true })
      await inspectSession.waitFor()
      await reported.getByRole('link', { name: `${files.artifact} Download`, exact: true }).waitFor()
      await reported.getByRole('button', { name: 'Continue work', exact: true }).click()
      expect(await composer.innerText()).toBe(`Continue work ${workId}. Review the last report before acting.`)
      await composer.fill('')
      await page.route('**/api/assistant/workStatus', async (route) => {
        const response = await route.fetch()
        const envelope = await response.json() as { result: { value: { work: { id: string; status: string; operations?: unknown }[] } } }
        const row = envelope.result.value.work.find(item => item.id === workId)
        if (row === undefined) throw new Error('Expected retained work')
        row.status = 'unknown'
        row.operations = { kind: 'available', value: {
          pendingApprovals: 0, unknown: 0, businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 1, failed: 0 },
          business: [{ id: BUSINESS, action: 'register', dispatch: 'unconfirmed', completion: 'succeeded', canReconcile: false,
            unattended: false, receiptId: 'japan-registration-42' }], truncated: false,
        } }
        await route.fulfill({ response, json: envelope })
      })
      await workStatus.getByRole('button', { name: 'Refresh status', exact: true }).click()
      const confirmed = workStatus.locator(`[data-assistant-work-id="${workId}"]`)
      await confirmed.getByText('External success confirmed', { exact: true }).first().waitFor()
      await confirmed.getByText('Report before the outcome check', { exact: true }).waitFor()
      expect(await confirmed.getByText('Work outcome unknown', { exact: true }).count()).toBe(0)
      expect(await confirmed.getByText('Inspect the work and check unresolved outcomes before continuing.', { exact: true }).count()).toBe(0)
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'work-lookup-confirmed.png'), animations: 'disabled' })
      await page.unroute('**/api/assistant/workStatus')
      await workStatus.getByRole('button', { name: 'Refresh status', exact: true }).click()
      await reported.waitFor()
      if (screenshots !== undefined) {
        await page.screenshot({ path: join(screenshots, 'work-status.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'dark' })
        await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
        await page.screenshot({ path: join(screenshots, 'work-status-dark.png'), animations: 'disabled' })
        await page.emulateMedia({ colorScheme: 'light' })
      }
      await inspectSession.click()
      const workerComposer = page.getByRole('textbox', { name: 'Open Assistant to send messages.', exact: true })
      await workerComposer.waitFor()
      expect(await workerComposer.isEditable()).toBe(false)
      await workStatus.waitFor({ state: 'hidden' })
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'worker.png'), animations: 'disabled' })

      await entranceButton.click()
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
      await page.getByText(final, { exact: true }).waitFor()
      await expect(page.getByRole('button', { name: 'Search sessions', exact: true }).count()).resolves.toBe(0)
      await workToggle.click()
      await inspectSession.click()
      await workerComposer.waitFor()
      const shortcut = await entranceButton.getAttribute('aria-keyshortcuts')
      if (shortcut === null) throw new Error('The primary Assistant action has no conversation shortcut')
      await page.keyboard.press(shortcut)
      await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
      await page.getByText(final, { exact: true }).waitFor()
      if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, 'entrance.png'), animations: 'disabled' })
    } catch (error: unknown) {
      await saveFailureShot(page, 'assistant-delegation')
      throw error
    } finally {
      await browser.close()
    }
  }, {
    patches,
    env: {
      DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined,
      DSH_OPERATION_SOCKET: authority.socketPath, DSH_APPROVAL_SOCKET: authority.approvalSocketPath,
    },
    async prepare(root) {
      const profile = join(root, 'home/profiles/web')
      await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web', private: true, dsh: { profile: PROFILE_TEMPLATES.web },
        dependencies: Object.fromEntries(PLUGINS.map(plugin => [plugin.name, `file:${plugin.path}`])),
      }) + '\n')
      await Promise.all(PLUGINS.map(plugin => symlink(plugin.path, join(profile, 'node_modules', plugin.name), 'dir')))
      const patch = join(root, 'assistant-replay.patch.yml')
      await writeFile(patch, JSON.stringify([
        ...['hmr', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm'].map(id => ({ id, disabled: true })),
        { id: 'skill-filesystem', config: { includeDefaultRoots: false } },
        { id: 'agent-default-model', config: { provider: 'codex-local', model: 'default' } },
        { id: 'ui-settings-models', config: { credentialOnboarding: false } },
        // The recorded transcript replays the minimal preset, which the Assistant overlay disables.
        { id: 'preset-minimal', disabled: false },
        { id: 'agent-preset-registry', config: { default: 'minimal' } },
        { id: 'operation-control-handoff', config: { socketPath: authority.modelSocketPath, approvalSocketPath: authority.grantSocketPath } },
        { id: 'session-persistence-jsonl', config: { root: join(root, 'home', 'sessions'), compression: 'none' } },
        { insert: [
          { id: 'operation-control-model-agent', name: '@deepseek-ai/dsh-operation-control/model-agent',
            config: { socketPath: authority.modelSocketPath, provider: 'codex-local', model: 'default' } },
          { id: 'assistant-gate', name: pathToFileURL(join(DIR, 'replay-gate.mjs')).href, config: { mainSessionId: MAIN } },
        ] },
      ]) + '\n')
      patches.push(patch)
    },
    async afterStop(root) {
      if (stop) return
      const sessionsRoot = join(root, 'home', 'sessions')
      const harvested: (HarvestedLog & { cwd: string | undefined })[] = []
      for await (const file of glob(`**/session.v${SESSION_FORMAT_VERSION}.jsonl`, { cwd: sessionsRoot })) {
        const raw = await readFile(join(sessionsRoot, file), 'utf8')
        const { id, createdAt, cwd } = JSON.parse(raw.split('\n', 1)[0]!) as { id: string; createdAt: number; cwd?: string }
        harvested.push({ id, createdAt, cwd, content: normalizeWebSessionVolatiles(raw, root) })
      }
      const logs = [harvested.find(log => log.id === MAIN), harvested.find(log => log.id.startsWith('assistant-work-'))]
      if (logs[0] === undefined || logs[1] === undefined) throw new Error('missing assistant or worker persisted Session')
      const ordered = [logs[0], logs[1]]
      const deliveries = parseSessionLog(expected[0]!.replaceAll('{{session:2}}', logs[1].id))
        .filter(event => event.type === 'assistant/message')
        .map(({ data }): ExpectedHandoff => ({
          kind: 'delivery', targetSessionId: MAIN, content: expandAssistantStream(data.stream).map(({ chunk }) => chunk),
        }))
      await authority.assertRecords([
        deliveries[0]!,
        deliveries[1]!,
        {
          kind: 'delegation', targetSessionId: logs[1].id,
          content: { id: workId, previous, prompt: workPrompt, cwd: logs[0].cwd ?? null, preset, permission, inputs: [input] },
          delegation: { workId, previousWorkId: null, permissions, inputs: [input] },
        },
        ...deliveries.slice(2),
        ...sample ? [RECORDS_HANDOFF] : [],
      ], input)
      // Web may open an empty Session before a user chooses a conversation.
      for (const log of harvested.filter(item => !ordered.includes(item))) {
        expect(parseSessionLog(log.content).filter(event =>
          event.type === 'step/start' || event.type === 'user/message' || event.type.startsWith('assistant/')
          || event.type.startsWith('request/') || event.type.startsWith('tool/'),
        )).toEqual([])
      }
      const raw = ordered.map(log => log.content)
      const context = { sessionIds: ordered.map(log => log.id), cwd: root }
      if (MODE === 'refresh') {
        const replacements = refreshFixtureReplacements(ordered, expected)
        expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(raw.map((log, index) =>
          tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
            prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context,
          )))), expected))
        await Promise.all(expected.map((log, index) => writeFile(
          recordedSessionFixturePath(paths[index]!, SESSION_FORMAT_VERSION), log,
        )))
      }
      expect(normalizeSessionSnapshots(raw, context))
        .toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))

      for (const [index, log] of raw.entries()) {
        const prompts = normalizedSystemPrompts(log, context)
        const schemas = normalizedToolSchemas(log, context)
        const suffix = index === 0 ? '' : '.1'
        const promptPath = join(DIR, '../minimal-read-image/system-prompt.expected.md')
        expect(formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))).toBe(await readFile(promptPath, 'utf8'))
        const schemaPath = join(DIR, `tool-schemas${suffix}.expected.json`)
        const schemaText = formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))
        if (MODE === 'refresh' && !sample) await writeFile(schemaPath, schemaText)
        expect(schemaText).toBe(await readFile(schemaPath, 'utf8'))
      }
    },
  })
})
