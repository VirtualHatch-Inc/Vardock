/** Exercise the authority's Unix socket, locked SQLite state, and separate witness receipts. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContainerId, ExecutionObservation } from '@deepseek-ai/dsh-execution-container'
import LlmRuntime, { HarnessError, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BrokerError, OperationBroker, type BrokerActionDescription, type BrokerActionId, type BrokerObservation, type BrokerReceiptId,
  type BrokerResolution, type PreparedBrokerRequest,
} from '@deepseek-ai/dsh-operation-broker'
import * as Witness from '@deepseek-ai/dsh-operation-evidence'
import { digestEvidenceEvent, EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi, type Mock, type TestContext } from 'vitest'
import { isUnattended, OperationAuthority, type AuthorityOptions } from '../src/authority.ts'
import * as OperationControl from '../src/index.ts'
import { apply, type Config } from '../src/index.ts'
import { OperationControlClient, type OperationApprovalDecision, type OperationProposal, type OperationStatus } from '../src/client.ts'
import UnixHandoffControl, { type HandoffRequest } from '../src/handoff.ts'
import type { BrokerCredentialChange } from '../src/protocol.ts'
import { verifyRecords } from '../src/verify.ts'
import * as ModelAgent from '../src/model-agent.ts'
import { modelObservationSchema, type ModelObservation, type ModelRequest } from '../src/model-protocol.ts'
import {
  DEFAULT_MAX_FILE_BYTES, operationIdSchema, workIdSchema, workInputPath, WorkPrincipalId,
  type FileProposal, type HandoffProposal, type UnattendedAction, type WorkInputFile, type WorkPermissions,
} from '../src/protocol.ts'
import { OperationStore, reconciliationIntentEvent, type Grant } from '../src/store.ts'

const brokerActionId = (value: string): BrokerActionId => brandString<BrokerActionId>(value)
const observation: ExecutionObservation = {
  exitCode: 7, stdout: 'output', stderr: 'failure', stdoutTruncated: false, stderrTruncated: false,
  containerId: brandString<ContainerId>('a'.repeat(64)), stopped: true,
}

const proposal = (session = 'worker-1'): Extract<OperationProposal, { command: string }> => ({
  requestKey: randomUUID(), sessionId: SessionId(session), command: 'printf output; exit 7',
})

function decisionFor(status: OperationStatus, decision: OperationApprovalDecision['decision']): OperationApprovalDecision {
  const { id, review } = status
  if (review === undefined) throw new Error('The fixture operation needs a review')
  return { id, decision, revision: review.revision, payloadDigest: review.payloadDigest }
}

const reconciliationEndpoint = 'https://example.test/status'

/** Run one approved script whose only step submits a request of this action, `capture` by default, with this body. */
async function submitCapture(client: OperationControlClient, run: Mock<AuthorityOptions['run']>, body: string, action = 'capture') {
  const issued = await client.propose(proposal())
  let reply: unknown
  run.mockImplementationOnce(async (_session, _command, signal, submit) => {
    if (submit === undefined) throw new Error('Expected a live business capability')
    reply = await submit({ requestKey: randomUUID(), action, body }, signal)
    return observation
  })
  const waiting = client.waitReview(issued.id)
  const execution = client.execute(issued.id)
  return { waiting, execution, reply: () => reply }
}

const credential = brandString<PreparedBrokerRequest['credentialRef']>('DSH_FIXTURE_TOKEN')

/** A broker whose actions have these route digests. */
function brokerFixture(statusEndpoint?: string, routes: Readonly<Record<string, string>> = { capture: 'c'.repeat(64), refund: 'd'.repeat(64) }) {
  const actions = vi.fn<OperationBroker['actions']>(() => Object.entries(routes)
    .map(([action, routeDigest]) => ({ action: brokerActionId(action), credentialRef: credential, routeDigest })))
  const resolve = vi.fn<OperationBroker['resolve']>((action, body) => ({
    action: brokerActionId(action), method: 'POST', endpoint: 'https://example.test/submit', body, credentialRef: credential,
    ...(statusEndpoint === undefined ? {} : { reconciliationEndpoint: statusEndpoint }),
  }))
  const run = vi.fn<OperationBroker['run']>().mockResolvedValue({ kind: 'http-response', statusCode: 202 })
  const reconcile = vi.fn<OperationBroker['reconcile']>().mockResolvedValue({ kind: 'pending' })
  const reviewPresentation = vi.fn<OperationBroker['reviewPresentation']>()
  return { actions, resolve, run, reconcile, reviewPresentation }
}

const assistant: NonNullable<Grant['assistant']> = {
  mainSessionId: SessionId('assistant-main'), permissions: { exec: true, brokerActions: [] },
}
const handoffRequest: Extract<HandoffRequest, { kind: 'delegation' }> = {
  kind: 'delegation',
  key: 'fixture-tool-call',
  sessionId: assistant.mainSessionId,
  targetSessionId: SessionId('worker-1'),
  content: JSON.stringify({ prompt: 'Review the report.' }),
  delegation: { workId: workIdSchema.parse('1'.repeat(64)), previousWorkId: null, permissions: assistant.permissions },
}

const filePermissions: WorkPermissions = {
  exec: true, brokerActions: [],
  data: { import: true, export: true, discloseToModel: true, discloseToUser: true },
}

function fileFixture(data: Buffer) {
  const digest = createHash('sha256').update(data).digest('hex')
  const source: WorkInputFile = { attachmentId: digest, name: 'owner notes.txt', bytes: data.length, messageSeq: 1, contentIndex: 0 }
  const transferRun = vi.fn<NonNullable<AuthorityOptions['transfer']>['run']>(async (_session, request) => request.kind === 'import'
    ? { kind: 'imported', digest, bytes: data.length }
    : { kind: 'exported', digest, bytes: data.length, data })
  const sessionId = handoffRequest.targetSessionId
  const workId = handoffRequest.delegation.workId
  const delegation = handoffProposal({
    ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions: filePermissions, inputs: [source] },
  })
  const importFile: FileProposal = {
    requestKey: '3'.repeat(64), sessionId, file: { kind: 'import', workId, source, contentBase64: data.toString('base64') },
  }
  const exportFile: FileProposal = {
    requestKey: '4'.repeat(64), sessionId,
    file: { kind: 'export', workId, path: 'report.txt', targetSessionId: assistant.mainSessionId },
  }
  const options = {
    assistant: { ...assistant, permissions: filePermissions },
    transfer: { maxBytes: DEFAULT_MAX_FILE_BYTES, run: transferRun },
  }
  return { source, transferRun, delegation, importFile, exportFile, options }
}

function handoffProposal(request: HandoffRequest = handoffRequest): HandoffProposal {
  const { key, kind, sessionId, targetSessionId, content } = request
  const requestKey = createHash('sha256').update(JSON.stringify([kind, sessionId, key])).digest('hex')
  return {
    requestKey, sessionId,
    handoff: { kind, targetSessionId, content, ...(kind === 'delegation' ? { delegation: request.delegation } : {}) },
  }
}

const modelInput = {
  provider: 'fixture-provider',
  model: 'fixture-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
} satisfies ModelRequest

const modelResponse: ModelObservation = modelObservationSchema.parse([
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Completed' } },
  { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
  { type: 'finish', reason: { kind: 'stop' } },
])

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'oc-'))
  const databasePath = join(root, 'ops.sqlite')
  const socketPath = join(root, 'ops.sock')
  const approvalSocketPath = join(root, 'ap.sock')
  const evidencePath = join(root, 'ev.sock')
  const witnessDirectory = join(root, 'witness')
  const client = new OperationControlClient({ socketPath })
  const approver = new OperationControlClient({ socketPath: approvalSocketPath })
  const evidence = new EvidenceClient({ socketPath: evidencePath })
  const grant = {
    principalId: WorkPrincipalId('agent-1'), scopeId: 'offline-shell', fingerprint: '1'.repeat(64),
    configuration: { profile: 'fixture' }, expiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 2,
  }
  const closers: Array<() => Promise<void>> = []
  test.onTestFinished(async () => {
    try {
      for (const close of closers.reverse()) await close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  await mkdir(witnessDirectory, { mode: 0o700 })
  const run = vi.fn<AuthorityOptions['run']>().mockResolvedValue(observation)
  return {
    client, approver, approvalSocketPath, evidence, evidencePath, run, databasePath, grant, socketPath,
    /** Close a resource before the fixture directory is removed and after every resource opened later. */
    own: (close: () => Promise<void>) => { closers.push(close) },
    startWitness: async () => {
      const ctx = new Context()
      const close = () => ctx.fiber.dispose()
      closers.push(close)
      await ctx.plugin(Witness, { socketPath: evidencePath, databasePath: join(witnessDirectory, 'events.sqlite') })
      return close
    },
    startAuthority: async (
      overrides: Partial<Grant> = {},
      options: Pick<AuthorityOptions, 'model' | 'approvalSocketPath' | 'unattendedShell' | 'unattendedActions' | 'broker' | 'businessActions' | 'connections' | 'transfer'> & Pick<Grant, 'assistant'> = {},
    ) => {
      const { assistant, ...authorityOptions } = options
      const store = await OperationStore.open(databasePath, { ...grant, ...overrides, ...assistant === undefined ? {} : { assistant } })
      const authority = new OperationAuthority(store, evidence, {
        socketPath, run, maxCommandBytes: 32_768, requestTimeoutMs: 10_000, warn: vi.fn(),
        ...authorityOptions,
      })
      closers.push(() => authority.close())
      await authority.listen()
      return authority
    },
  }
}

async function dispatchBusiness({ client, approver, run }: Awaited<ReturnType<typeof fixture>>, sessionId = SessionId('worker-1')) {
  const parent = await approver.decide(decisionFor(await client.propose({ ...proposal(), sessionId }), 'approve'))
  run.mockImplementationOnce(async (_session, _command, signal, submit) => {
    if (submit === undefined) throw new Error('Expected a live business capability')
    await submit({ requestKey: randomUUID(), action: 'capture', body: '{"message":"private business content"}' }, signal)
    return observation
  })
  const waiting = client.waitReview(parent.id)
  const execution = client.execute(parent.id)
  const pending = await waiting
  if (pending === undefined) throw new Error('Expected a business review')
  const decision = decisionFor(pending, 'approve')
  await approver.decide(decision)
  await execution
  return { id: pending.id, parentId: parent.id, sessionId, payloadDigest: decision.payloadDigest, revision: decision.revision }
}

/** Run one script in a Session whose only step submits a `capture` request, and answer its review when one is expected. */
async function submitIn(
  { client, approver, run }: Awaited<ReturnType<typeof fixture>>, session: string, body: string,
  decision?: OperationApprovalDecision['decision'],
): Promise<void> {
  const issued = await client.propose(proposal(session))
  run.mockImplementationOnce(async (_session, _command, signal, submit) => {
    if (submit === undefined) throw new Error('Expected a live business capability')
    await submit({ requestKey: randomUUID(), action: 'capture', body }, signal)
    return observation
  })
  if (decision === undefined) {
    await client.execute(issued.id)
    return
  }
  const waiting = client.waitReview(issued.id)
  const execution = client.execute(issued.id)
  const pending = await waiting
  if (pending === undefined) throw new Error('Expected a business review')
  await approver.decide(decisionFor(pending, decision))
  await execution
}

/** Open a store as a start leaves it after the witness confirmed its configuration record. */
async function openRecorded(databasePath: string, grant: Grant): Promise<OperationStore> {
  const store = await OperationStore.open(databasePath, grant)
  const event = store.configurationEvent
  if (event !== undefined) store.commitConfiguration({ id: event.id, digest: digestEvidenceEvent(event) })
  return store
}

function simulateLegacyStore(databasePath: string, version: number): void {
  const db = new DatabaseSync(databasePath)
  try {
    if (version === 1) {
      db.exec(`
        UPDATE operations SET record = json_set(
          json_remove(record, '$.payloadDigest'), '$.commandDigest', json_extract(record, '$.payloadDigest')
        );
      `)
    }
    if (version < 6) db.exec('DROP TABLE reconciliations; DROP INDEX operations_business_session;')
    if (version < 7) {
      db.exec(`DROP INDEX operations_work_id; DROP INDEX operations_work_session; DROP INDEX operations_pending_delegation;
        DROP INDEX operations_running_work;`)
    }
    if (version < 8) db.exec('DROP INDEX operations_imported_session;')
    if (version < 9) db.exec('ALTER TABLE authority DROP COLUMN owner_limits')
    if (version < 10) db.exec('ALTER TABLE authority DROP COLUMN owner_rules')
    if (version < 12) db.exec('ALTER TABLE authority DROP COLUMN configuration')
    db.exec(`UPDATE operations SET record = json_remove(record, '$.approval') WHERE json_extract(record, '$.approval') = 'unattended';
      PRAGMA user_version = ${version};`)
  } finally {
    db.close()
  }
}

describe.skipIf(process.platform === 'win32')('operation authority', () => {
  it('validates owner limit edits on the approval socket without reserving an operation', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    await startAuthority({}, { approvalSocketPath })
    const append = vi.spyOn(evidence, 'append')
    const original = await approver.grant()
    const { revision } = original
    const update = { revision, maxOperations: 4, expiresAt: Date.now() + 60_000 }
    await expect(client.grant()).rejects.toMatchObject({ code: 'approval-forbidden' })
    await expect(client.updateGrant(update)).rejects.toMatchObject({ code: 'approval-forbidden' })
    for (const invalid of [
      { ...update, revision: 'bad-revision' }, { ...update, maxOperations: 0 }, { ...update, maxOperations: 1.5 },
      { ...update, expiresAt: 0 }, { ...update, expiresAt: 8_640_000_000_000_001 }, { ...update, permissions: {} },
    ]) {
      await expect(approver.updateGrant(invalid)).rejects.toMatchObject({ code: 'bad-request' })
    }
    expect(await approver.grant()).toEqual(original)
    expect(append).not.toHaveBeenCalled()

    const changed = await approver.updateGrant(update)
    expect(changed).toMatchObject({ maxOperations: 4, expiresAt: update.expiresAt, reserved: 0, remaining: 4 })
    expect(changed.revision).not.toBe(revision)
    const event = append.mock.calls[0]?.[0]
    if (event === undefined) throw new Error('The fixture expected an independently witnessed limit edit')
    expect((await evidence.get(event.id))?.event.body).toMatchObject({
      kind: 'grant-limits-update', principalId: original.principalId, scopeId: original.scopeId,
      previousRevision: revision, expiresAt: update.expiresAt, maxOperations: update.maxOperations,
    })
    await expect(approver.updateGrant(update)).rejects.toMatchObject({ code: 'revision-mismatch' })
    expect(await approver.updateGrant({ ...update, revision: changed.revision })).toEqual(changed)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('keeps old limits until the witness acknowledges the change and rejects a concurrent edit', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority } = await fixture(test)
    const closeWitness = await startWitness()
    await startAuthority({}, { approvalSocketPath })
    const original = await approver.grant()
    await closeWitness()
    const update = { revision: original.revision, maxOperations: 3, expiresAt: Date.now() + 60_000 }
    await expect(approver.updateGrant(update)).rejects.toMatchObject({ code: 'grant-update-evidence-unavailable' })
    expect(await approver.grant()).toEqual(original)

    await startWitness()
    const append = evidence.append.bind(evidence)
    const spy = vi.spyOn(evidence, 'append').mockImplementationOnce(async event => ({ id: event.id, digest: 'a'.repeat(64) }))
    await expect(approver.updateGrant(update)).rejects.toMatchObject({ code: 'grant-update-evidence-unavailable' })
    expect(await approver.grant()).toEqual(original)

    spy.mockImplementationOnce(async (event) => {
      await append(event)
      throw new Witness.EvidenceError('unknown', 'The witness reply was lost')
    })
    await expect(approver.updateGrant(update)).rejects.toMatchObject({ code: 'grant-update-evidence-unavailable' })
    expect(await approver.grant()).toEqual(original)
    const unacknowledged = spy.mock.calls.at(-1)?.[0]
    if (unacknowledged === undefined) throw new Error('The fixture expected the witness to retain the attempted edit')
    expect((await evidence.get(unacknowledged.id))?.event).toEqual(unacknowledged)

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    spy.mockImplementationOnce(async (event) => {
      entered.resolve(undefined)
      await release.promise
      return append(event)
    })
    const save = approver.updateGrant(update)
    try {
      await entered.promise
      expect(await approver.grant()).toEqual(original)
      await expect(approver.updateGrant({ ...update, maxOperations: 5 })).rejects.toMatchObject({ code: 'grant-update-in-progress' })
      await client.propose(proposal())
    } finally {
      release.resolve(undefined)
      await save
    }
    expect(await save).toMatchObject({ maxOperations: 3, reserved: 1, remaining: 2 })
    expect(spy.mock.calls.at(-1)?.[0]).toEqual(unacknowledged)
    await expect(approver.updateGrant({ ...update, maxOperations: 5 })).rejects.toMatchObject({ code: 'revision-mismatch' })
  })

  it('migrates existing reservations and preserves unknown outcomes through an expiry edit and renewal', async (test) => {
    const { client, approver, approvalSocketPath, databasePath, grant, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    const options = { approvalSocketPath }
    const authority = await startAuthority({ maxOperations: 3 }, options)
    const interruptedInput = proposal()
    const interrupted = await approver.decide(decisionFor(await client.propose(interruptedInput), 'approve'))
    const pending = await client.propose(proposal())
    const issued = await approver.decide(decisionFor(await client.propose(proposal()), 'approve'))
    await authority.close()
    const crashed = await OperationStore.open(databasePath, grant)
    try {
      crashed.put({ ...crashed.get(interrupted.id), state: 'running' }, 'issued')
    } finally {
      crashed.close()
    }
    simulateLegacyStore(databasePath, 8)

    const restarted = await startAuthority({}, options)
    const original = await approver.grant()
    expect(await client.overview(interruptedInput.sessionId)).toMatchObject({ pendingApprovals: 1 })
    const expired = await approver.updateGrant({ revision: original.revision, maxOperations: 1, expiresAt: 1 })
    expect(expired).toMatchObject({ expired: true, reserved: 3, remaining: 0 })
    expect(await client.overview(interruptedInput.sessionId)).toMatchObject({
      pendingApprovals: 0, lastFailure: { id: pending.id, code: 'revision-mismatch' },
    })
    await expect(client.propose(proposal())).rejects.toMatchObject({ code: 'grant-expired' })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'grant-expired' })
    await restarted.close()

    await startAuthority({}, options)
    expect(await approver.grant()).toEqual(expired)
    const renewed = await approver.updateGrant({ revision: expired.revision, maxOperations: 4, expiresAt: Date.now() + 60_000 })
    expect(renewed).toMatchObject({ expired: false, reserved: 3, remaining: 1 })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch' })
    await expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'revision-mismatch' })
    const unknown = await client.execute(interrupted.id)
    expect(unknown).toMatchObject({ state: 'unknown', outcome: { code: 'authority-interrupted' } })
    expect(await client.propose(interruptedInput)).toEqual(unknown)
    expect(run).not.toHaveBeenCalled()
    const fresh = await approver.decide(decisionFor(await client.propose(proposal()), 'approve'))
    await expect(client.execute(fresh.id)).resolves.toMatchObject({ state: 'settled' })
    await expect(client.propose(proposal())).rejects.toMatchObject({ code: 'budget-exhausted' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps a witnessed work binding and settles its running operation after a limit edit', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority({}, { approvalSocketPath, assistant })
    const delegation = handoffProposal()
    const released = await client.execute((await client.propose(delegation)).id)
    const workSession = delegation.handoff.targetSessionId
    const issued = await approver.decide(decisionFor(await client.propose({ ...proposal(), sessionId: workSession }), 'approve'))
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<ExecutionObservation>()
    run.mockImplementationOnce(async (_sessionId, _command, signal) => {
      entered.resolve(signal)
      return release.promise
    })
    const running = client.execute(issued.id)
    try {
      const signal = await entered.promise
      const { revision } = await approver.grant()
      await approver.updateGrant({ revision, maxOperations: 3, expiresAt: Date.now() + 60_000 })
      expect(signal.aborted).toBe(false)
      expect(await client.propose(delegation)).toEqual(released)
      const ungranted = handoffProposal({
        ...handoffRequest, key: 'extra-permission', targetSessionId: SessionId('another-worker'),
        delegation: { workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: null, permissions: { exec: true, brokerActions: ['capture'] } },
      })
      await expect(client.propose(ungranted)).rejects.toMatchObject({ code: 'work-permission-denied' })
    } finally {
      release.resolve(observation)
      await running
    }
    await expect(running).resolves.toMatchObject({ state: 'settled', outcome: { kind: 'exited', observation } })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('recovers a consumed delegation after the owner renews an expired grant', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority } = await fixture(test)
    const expiresAt = Date.now() + 3_600_000
    await startWitness()
    await startAuthority({ expiresAt }, { approvalSocketPath, assistant })
    const delegation = handoffProposal()
    const { id } = await client.propose(delegation)
    const append = vi.spyOn(evidence, 'append').mockRejectedValueOnce(
      new Witness.EvidenceError('unavailable', 'The witness was unavailable when the delegation completed'),
    )
    await expect(client.execute(id)).resolves.toMatchObject({ id, state: 'pending-outcome-evidence' })

    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1)
    try {
      await expect(client.execute(id)).rejects.toMatchObject({ code: 'grant-expired' })
      const { revision, maxOperations } = await approver.grant()
      await approver.updateGrant({ revision, maxOperations, expiresAt: expiresAt + 3_600_000 })
      await expect(client.propose({ ...delegation, requestKey: '2'.repeat(64) })).rejects.toMatchObject({ code: 'work-conflict' })

      const recovered = await client.execute(id)
      expect(recovered).toMatchObject({
        id, state: 'settled', outcome: { kind: 'released', work: { workId: handoffRequest.delegation.workId } },
        receipt: { id: `${id}-outcome` },
      })
      await expect(client.propose(delegation)).resolves.toEqual(recovered)
      const outcomes = append.mock.calls.map(([event]) => event).filter(event => event.kind === 'outcome')
      expect(outcomes).toHaveLength(2)
      expect(outcomes[0]).toEqual(outcomes[1])
      expect((await evidence.get(`${id}-outcome`))?.event).toEqual(outcomes[0])
      expect(await approver.grant()).toMatchObject({ reserved: 1 })
    } finally {
      clock.mockRestore()
    }
  })

  it('lists the configured permitted business actions and none when unconfigured', async (test) => {
    const { client, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const authority = await startAuthority()
    expect(await client.businessActions()).toEqual({ actions: [] })
    await authority.close()
    const businessActions = [{ action: 'capture', description: 'Capture a payment.' }, { action: 'refund' }]
    await startAuthority({}, { businessActions })
    expect(await client.businessActions()).toEqual({ actions: businessActions })
  })

  it('serves connection settings only on the approval socket and witnesses each credential change before writing it', async (test) => {
    const { client, approver, socketPath, approvalSocketPath, evidence, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const authority = await startAuthority({}, { approvalSocketPath })
    await expect(approver.brokerConnections()).rejects.toMatchObject({ code: 'broker-unavailable' })
    await authority.close()
    const stored = new Set<string>()
    const list = vi.fn(async () => [{
      action: 'capture', description: 'Capture a payment.', credentialRef: 'CAPTURE_TOKEN', configured: stored.has('capture'), returnsResponse: true,
    }])
    const credentialChange = vi.fn((update: BrokerCredentialChange) => async () => {
      const target = 'action' in update ? update.action : 'model'
      if (update.value === null) stored.delete(target)
      else stored.add(target)
    })
    const model = vi.fn(async () => ({
      provider: 'fixture-provider', model: 'fixture-model', credentialRef: 'MODEL_KEY', configured: stored.has('model'),
    }))
    const rules = [{ action: 'capture', match: { account: 'A1' }, allow: ['amount'] }, { action: 'capture' }, { action: 'refund' }]
    await startAuthority({}, {
      approvalSocketPath, unattendedShell: true, unattendedActions: rules, connections: { list, model, credentialChange },
    })
    const update = { action: 'capture', value: 'fixture-token' }
    await expect(client.brokerConnections()).rejects.toMatchObject({ code: 'approval-forbidden' })
    await expect(client.setBrokerConnection(update)).rejects.toMatchObject({ code: 'approval-forbidden' })
    expect(await approver.brokerConnections()).toMatchObject({ connections: [{ action: 'capture', configured: false }] })
    for (const invalid of [{ action: 'capture', value: '' }, { action: 'Capture', value: 'x' }, { ...update, extra: true }]) {
      await expect(approver.setBrokerConnection(invalid)).rejects.toMatchObject({ code: 'bad-request' })
    }
    expect(credentialChange).not.toHaveBeenCalled()
    const append = vi.spyOn(evidence, 'append')
    const { revision } = await approver.brokerConnections()
    await expect(approver.setBrokerConnection({ action: 'capture', unattended: [], revision }))
      .rejects.toMatchObject({ code: 'broker-action-unavailable' })
    expect(await approver.setBrokerConnection(update)).toEqual({
      model: { provider: 'fixture-provider', model: 'fixture-model', credentialRef: 'MODEL_KEY', configured: false },
      unattendedShell: true, revision,
      connections: [{
        action: 'capture', description: 'Capture a payment.', credentialRef: 'CAPTURE_TOKEN', configured: true, returnsResponse: true,
        unattended: [{ match: { account: 'A1' }, allow: ['amount'] }, {}], routeChangedSinceRulesSaved: false,
      }],
    })
    expect(credentialChange).toHaveBeenCalledExactlyOnceWith(update)
    expect(await approver.setBrokerConnection({ model: true, value: 'fixture-key' })).toMatchObject({ model: { configured: true } })
    expect(await approver.setBrokerConnection({ model: true, value: null })).toMatchObject({ model: { configured: false } })
    expect(append.mock.calls.map(([event]) => event.body)).toMatchObject([
      { kind: 'credential-change', action: 'capture', stored: true },
      { kind: 'credential-change', model: true, stored: true },
      { kind: 'credential-change', model: true, stored: false },
    ])
    expect(JSON.stringify(append.mock.calls)).not.toContain('fixture-')
    append.mockRejectedValueOnce(new Witness.EvidenceError('unavailable', 'The witness is stopped'))
    await expect(approver.setBrokerConnection({ model: true, value: 'fixture-key' })).rejects.toMatchObject({ code: 'credential-evidence-unavailable' })
    expect(await approver.brokerConnections()).toMatchObject({ model: { configured: false } })
    expect(await approver.setBrokerConnection({ action: 'capture', value: null })).toMatchObject({ connections: [{ configured: false }] })
    await approver.setBrokerConnection(update)

    const ctx = new Context()
    test.onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(UnixHandoffControl, { socketPath, approvalSocketPath })
    expect(await ctx.handoffControl.brokerConnections()).toMatchObject({ connections: [{ action: 'capture', configured: true }] })
    expect(await ctx.handoffControl.setBrokerConnection(update)).toMatchObject({ connections: [{ configured: true }] })
    const guest = new Context()
    test.onTestFinished(async () => { await guest.fiber.dispose() })
    await guest.plugin(UnixHandoffControl, { socketPath })
    await expect(guest.handoffControl.brokerConnections()).rejects.toMatchObject({ code: 'broker-unavailable' })
    await expect(guest.handoffControl.setBrokerConnection(update)).rejects.toMatchObject({ code: 'broker-unavailable' })
  })

  it('reports a stale business approval under its retained state until cancellation commits', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    const input = proposal()
    const parent = await approver.decide(decisionFor(await client.propose(input), 'approve'))
    run.mockImplementationOnce(async (_sessionId, _command, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      await submit({ requestKey: randomUUID(), action: 'capture', body: '{}' }, signal)
      return observation
    })
    const running = client.execute(parent.id)
    try {
      const pending = await client.waitReview(parent.id)
      if (pending === undefined) throw new Error('Expected a business review')
      const { revision } = await approver.grant()
      await approver.updateGrant({ revision, maxOperations: 3, expiresAt: Date.now() + 60_000 })
      expect(await client.businessOperations(input.sessionId)).toMatchObject({ operations: [{
        id: pending.id, state: 'pending-approval', canReconcile: false,
        businessCompletion: { kind: 'unconfirmed', code: 'revision-mismatch' },
      }] })
      await expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'revision-mismatch' })
      expect(await client.cancel(pending.id)).toMatchObject({ state: 'canceled', receipt: { id: `${pending.id}-revocation` } })
      expect(await client.businessOperations(input.sessionId)).toMatchObject({ operations: [{ id: pending.id, state: 'canceled' }] })
    } finally {
      await client.cancel(parent.id)
      await running
    }
    expect(broker.run).not.toHaveBeenCalled()
  })

  it('reviews and dispatches the exact prepared business request once for a repeated key', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority, run } = await fixture(test)
    const presentation = {
      title: { en: 'Submit to the intake service?', zh: '提交到接收服务？' },
      detail: 'Intake message\n  approved exact body',
    }
    const broker = brokerFixture()
    broker.reviewPresentation.mockReturnValue(presentation)
    const prepare = broker.resolve.getMockImplementation()
    if (prepare === undefined) throw new Error('Expected a broker route resolver')
    broker.resolve.mockImplementation((action, body, identity) => ({
      ...prepare(action, body, identity), body: `${body}\n`,
    }))
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    const input = { requestKey: randomUUID(), action: 'capture', body: '{\n  "text": "approved exact body"\n}' }
    const shell = proposal()
    const parent = await approver.decide(decisionFor(await client.propose(shell), 'approve'))
    const identity = { parentId: parent.id, requestKey: input.requestKey }
    const preparedBody = `${input.body}\n`
    const replies: unknown[] = []
    run.mockImplementationOnce(async (_session, _command, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      replies.push(await submit({ ...input, sessionId: 'forged' }, signal))
      const waiting = submit(input, signal)
      replies.push(await submit({ ...input, requestKey: randomUUID() }, signal))
      replies.push(await waiting, await submit(input, signal))
      replies.push(await submit({ ...input, requestKey: randomUUID() }, signal))
      return observation
    })
    const waiting = client.waitReview(parent.id)
    const running = client.execute(parent.id)
    const pending = await waiting
    if (pending?.review === undefined || !('business' in pending.review)) throw new Error('Expected a business review')
    const { business } = pending.review
    expect(pending).toMatchObject({ state: 'pending-approval', review: { sessionId: shell.sessionId, presentation, business: {
      parentId: parent.id, action: input.action, endpoint: 'https://example.test/submit', body: preparedBody,
    } } })
    expect(broker.reviewPresentation).toHaveBeenCalledExactlyOnceWith(business)
    expect(broker.resolve).toHaveBeenCalledExactlyOnceWith(input.action, input.body, identity)
    await expect(client.propose({ requestKey: randomUUID(), sessionId: shell.sessionId, business })).rejects.toMatchObject({ code: 'broker-proposal-forbidden' })
    await expect(client.execute(pending.id)).rejects.toMatchObject({ code: 'broker-execute-forbidden' })
    expect(broker.run).not.toHaveBeenCalled()
    await expect(approver.decide({ ...decisionFor(pending, 'approve'), payloadDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'approval-mismatch' })
    expect(await approver.decide(decisionFor(pending, 'approve'))).toMatchObject({ state: 'issued' })
    expect(await running).toMatchObject({ state: 'settled' })
    await expect(client.waitReview(parent.id)).rejects.toMatchObject({ code: 'broker-parent-inactive', operationId: parent.id })
    expect(replies).toMatchObject([
      { code: 'bad-request' }, { code: 'broker-busy' }, { id: pending.id, status: 202 }, { id: pending.id, status: 202 }, { code: 'budget-exhausted' },
    ])
    expect(replies[2]).toEqual(replies[3])
    expect(broker.resolve).toHaveBeenNthCalledWith(2, input.action, input.body, identity)
    expect(broker.run).toHaveBeenCalledExactlyOnceWith(
      business, { operationId: pending.id, payloadDigest: pending.review.payloadDigest }, expect.any(AbortSignal),
    )
    expect(await evidence.get(`${pending.id}-admission`)).toMatchObject({ event: { body: {
      parentId: parent.id, action: input.action, endpoint: business.endpoint, credentialRef: business.credentialRef,
      bodyDigest: createHash('sha256').update(preparedBody).digest('hex'), requestDigest: pending.review.payloadDigest,
    } } })
    expect(await client.status(pending.id)).toMatchObject({ state: 'settled', outcome: { kind: 'business-response', statusCode: 202 },
      receipt: { id: `${pending.id}-outcome` },
    })
  })

  it.for(['guest disconnects', 'reviewer declines'] as const)('withdraws a review when the %s', async (ending, test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    const guest = new AbortController()
    const reply = Promise.withResolvers<unknown>()
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    const shell = proposal()
    const parent = await approver.decide(decisionFor(await client.propose(shell), 'approve'))
    run.mockImplementationOnce(async (_session, _command, _signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      reply.resolve(await submit({ requestKey: randomUUID(), action: 'capture', body: '{}' }, guest.signal))
      return observation
    })
    const waiting = client.waitReview(parent.id)
    const running = client.execute(parent.id)
    const pending = await waiting
    if (pending === undefined) throw new Error('Expected a business review')
    expect(await client.overview(shell.sessionId)).toMatchObject({
      reserved: 2, remaining: 0, running: 1, pendingApprovals: 1, unknown: 0,
      businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 },
    })
    if (ending === 'guest disconnects') guest.abort()
    else expect(await approver.decide(decisionFor(pending, 'deny'))).toMatchObject({ state: 'canceled' })
    expect(await reply.promise).toMatchObject({ code: 'broker-canceled', operationId: pending.id })
    expect(await running).toMatchObject({ state: 'settled' })
    await expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'approval-not-pending' })
    expect(await client.status(pending.id)).toMatchObject({ state: 'canceled', receipt: { id: `${pending.id}-revocation` } })
    expect(await client.overview(shell.sessionId)).toMatchObject({
      reserved: 2, remaining: 0, running: 0, pendingApprovals: 0, unknown: 0,
      businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 },
      lastFailure: { id: pending.id, code: ending === 'reviewer declines' ? 'approval-rejected' : 'operation-canceled' },
    })
    expect(broker.run).not.toHaveBeenCalled()
  })

  it('clears a prior authority issue after a later operation succeeds', async (test) => {
    const { client, run, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    await startAuthority()
    run.mockRejectedValueOnce(new HarnessError('Canceled execution', 'ABORTED'))
    const firstInput = proposal()
    const first = await client.propose(firstInput)
    await client.execute(first.id)
    expect(await client.overview(firstInput.sessionId)).toMatchObject({ lastFailure: { id: first.id, code: 'ABORTED' } })
    run.mockResolvedValueOnce({ ...observation, exitCode: 0 })
    const nextInput = proposal()
    const next = await client.propose(nextInput)
    await client.execute(next.id)
    const overview = await client.overview(nextInput.sessionId)
    expect(overview.lastFailure).toBeUndefined()
    expect(overview.unknown).toBe(1)
  })

  it('drains a consumed business request when its parent is canceled', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    const dispatched = Promise.withResolvers<AbortSignal>()
    broker.run.mockImplementationOnce((_spec, _correlation, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
      }, { once: true })
      dispatched.resolve(signal)
    }))
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    const parent = await approver.decide(decisionFor(await client.propose(proposal()), 'approve'))
    run.mockImplementationOnce(async (_session, _command, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      await submit({ requestKey: randomUUID(), action: 'capture', body: '{}' }, signal)
      return observation
    })
    const waiting = client.waitReview(parent.id)
    const running = client.execute(parent.id)
    const pending = await waiting
    if (pending === undefined) throw new Error('Expected a business review')
    await approver.decide(decisionFor(pending, 'approve'))
    const signal = await dispatched.promise
    expect(signal.aborted).toBe(false)
    expect(await client.cancel(parent.id)).toEqual(await running)
    expect(signal.aborted).toBe(true)
    expect(await client.status(pending.id)).toMatchObject({ state: 'unknown', receipt: { id: `${pending.id}-outcome` } })
    expect(broker.run).toHaveBeenCalledTimes(1)
  })

  it.for([
    { dispatch: 'unknown', errorCode: 'broker-response-unavailable', replyCode: 'broker-outcome-unavailable', state: 'unknown', kind: 'unknown' },
    { dispatch: 'not-sent', errorCode: 'broker-credential-unavailable', replyCode: 'broker-credential-unavailable', state: 'settled', kind: 'business-not-sent' },
  ] as const)('retains the $dispatch dispatch fact after consuming a business request', async (expected, test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    broker.run.mockRejectedValueOnce(new BrokerError(expected.errorCode, expected.dispatch, 'The broker could not return a response.'))
    const reply = Promise.withResolvers<unknown>()
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    const parent = await approver.decide(decisionFor(await client.propose(proposal()), 'approve'))
    run.mockImplementationOnce(async (_session, _command, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      const input = { requestKey: randomUUID(), action: 'capture', body: '{}' }
      reply.resolve(await submit(input, signal))
      expect(await submit(input, signal)).toMatchObject({ code: expected.replyCode })
      return observation
    })
    const waiting = client.waitReview(parent.id)
    const running = client.execute(parent.id)
    const pending = await waiting
    if (pending === undefined) throw new Error('Expected a business review')
    await approver.decide(decisionFor(pending, 'approve'))
    expect(await reply.promise).toMatchObject({ code: expected.replyCode, operationId: pending.id })
    expect(await running).toMatchObject({ state: 'settled' })
    expect(await client.status(pending.id)).toMatchObject({
      state: expected.state, outcome: { kind: expected.kind, code: expected.errorCode },
      receipt: { id: `${pending.id}-outcome` },
    })
    expect(broker.run).toHaveBeenCalledTimes(1)
  })

  it('withdraws an unanswered business review left by an interrupted parent', async (test) => {
    const { client, approver, approvalSocketPath, databasePath, grant, startWitness, startAuthority } = await fixture(test)
    const broker = brokerFixture()
    const store = await openRecorded(databasePath, grant)
    let decision: OperationApprovalDecision
    let parentId: OperationStatus['id']
    try {
      const parent = store.reserve(proposal(), () => {}, false)
      parentId = parent.id
      const issued = store.put({ ...parent, state: 'issued', admission: { id: `${parent.id}-admission`, digest: 'a'.repeat(64) } }, 'pending-evidence')
      store.put({ ...issued, state: 'running' }, 'issued')
      const requestKey = randomUUID()
      const child = store.reserve({
        requestKey, sessionId: parent.proposal.sessionId,
        business: { ...broker.resolve('capture', '{}', { parentId, requestKey }), parentId },
      }, () => {}, true)
      decision = { id: child.id, revision: child.revision, payloadDigest: child.payloadDigest, decision: 'approve' }
    } finally {
      store.close()
    }
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    expect(await client.status(parentId)).toMatchObject({ state: 'unknown', outcome: { code: 'authority-interrupted' } })
    expect(await client.status(decision.id)).toMatchObject({ state: 'canceled', receipt: { id: `${decision.id}-revocation` } })
    await expect(approver.decide(decision)).rejects.toMatchObject({ code: 'approval-not-pending' })
    expect(broker.run).not.toHaveBeenCalled()
  })

  it('requires witnessed intent before lookup and retries an unwitnessed observation without repeating the lookup', async (test) => {
    const f = await fixture(test)
    const { client, evidence, approvalSocketPath, startAuthority, startWitness } = f
    await startWitness()
    const broker = brokerFixture(reconciliationEndpoint)
    broker.run.mockRejectedValueOnce(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
    const authority = await startAuthority({}, { approvalSocketPath, broker })
    const { id, sessionId, payloadDigest } = await dispatchBusiness(f)
    const original = await client.status(id)
    const append = evidence.append.bind(evidence)
    let intentId: string | undefined
    let rejectPhase: Witness.EvidenceEvent['kind'] | undefined = 'admission'
    vi.spyOn(evidence, 'append').mockImplementation(async (event) => {
      const receipt = await append(event)
      if (event.id.includes('-reconcile-')) {
        if (event.kind === 'admission') intentId = event.id
        if (event.kind === rejectPhase) return { ...receipt, digest: 'f'.repeat(64) }
      }
      return receipt
    })
    const unconfirmed = { kind: 'unconfirmed', code: 'reconciliation-evidence-unavailable' }
    expect(await client.reconcile(sessionId, id)).toMatchObject({ businessCompletion: unconfirmed })
    expect(broker.reconcile).not.toHaveBeenCalled()
    const confirmedIntentId = intentId
    rejectPhase = 'outcome'
    const receiptId = brandString<BrokerReceiptId>('case-accepted-1')
    broker.reconcile.mockImplementationOnce(async (_spec, correlation) => {
      expect(correlation).toEqual({ operationId: id, payloadDigest })
      expect(intentId).toBe(confirmedIntentId)
      if (intentId === undefined) throw new Error('The fixture expected a witnessed lookup intent')
      expect(await evidence.get(intentId)).toMatchObject({ event: { operationId: id, kind: 'admission', body: {
        fact: 'business-reconciliation', sessionId, payloadDigest, dispatchDigest: original.receipt?.digest,
        targetDigest: createHash('sha256').update(reconciliationEndpoint).digest('hex'),
      } } })
      return { kind: 'succeeded', receiptId }
    })
    expect(await client.reconcile(sessionId, id)).toMatchObject({ businessCompletion: unconfirmed })
    expect(await client.businessOperations(sessionId)).toMatchObject({ operations: [{ id, businessCompletion: unconfirmed }] })
    expect(await client.status(id)).toEqual(original)
    expect(broker.reconcile).toHaveBeenCalledTimes(1)
    await authority.close()
    rejectPhase = undefined
    await startAuthority({}, { approvalSocketPath, broker })
    const sealed = await client.reconcile(sessionId, id)
    expect(sealed).toMatchObject({
      id, state: 'unknown', outcome: original.outcome, receipt: original.receipt, canReconcile: false,
      businessCompletion: { kind: 'succeeded', receiptId },
    })
    expect(await client.reconcile(sessionId, id)).toEqual(sealed)
    expect(await evidence.get(sealed.businessCompletion.receipt!.id)).toMatchObject({
      receipt: sealed.businessCompletion.receipt,
      event: { kind: 'outcome', operationId: id, body: { fact: 'business-reconciliation', kind: 'succeeded', receiptId } },
    })
    expect(broker.run).toHaveBeenCalledTimes(1)
    expect(broker.reconcile).toHaveBeenCalledTimes(1)
  })

  it('keeps a witnessed HTTP response separate from pending, unconfirmed, and failed business status', async (test) => {
    const f = await fixture(test)
    const { client, approvalSocketPath, startAuthority, startWitness } = f
    const broker = brokerFixture(reconciliationEndpoint)
    const authority = await startAuthority({}, { approvalSocketPath, broker })
    await startWitness()
    const { id, sessionId } = await dispatchBusiness(f)
    const other = SessionId('other-worker')
    expect(await client.businessOperations(other)).toEqual({ sessionId: other, operations: [] })
    await expect(client.reconcile(other, id)).rejects.toMatchObject({ code: 'not-found' })
    const before = await client.businessOperations(sessionId)
    const original = await client.status(id)
    expect(before).toEqual({ sessionId, operations: [{
      id, approval: 'approved', sessionId, action: 'capture', state: 'settled',
      outcome: { kind: 'business-response', statusCode: 202 },
      receipt: original.receipt, canReconcile: true, businessCompletion: { kind: 'unconfirmed' },
    }] })
    expect(broker.reconcile).not.toHaveBeenCalled()
    const pending = await client.reconcile(sessionId, id)
    expect(pending).toMatchObject({ businessCompletion: { kind: 'pending' }, canReconcile: true })
    expect(pending.businessCompletion.receipt).toBeDefined()
    expect(await client.overview(sessionId)).toMatchObject({ businessCompletion: { pending: 1, unconfirmed: 0, succeeded: 0, failed: 0 } })
    broker.reconcile.mockRejectedValueOnce(new BrokerError('broker-reconciliation-unconfirmed', 'unknown', 'The fixture returned no match.'))
    const unconfirmed = await client.reconcile(sessionId, id)
    expect(unconfirmed).toMatchObject({
      businessCompletion: { kind: 'unconfirmed', code: 'broker-reconciliation-unconfirmed' },
      canReconcile: true,
    })
    expect(unconfirmed.businessCompletion.receipt).toBeDefined()
    const receiptId = brandString<BrokerReceiptId>('service-rejection-3')
    broker.reconcile.mockResolvedValueOnce({ kind: 'failed', receiptId })
    const terminal = await client.reconcile(sessionId, id)
    expect(terminal).toMatchObject({
      state: 'settled', outcome: original.outcome, receipt: original.receipt,
      businessCompletion: { kind: 'failed', receiptId }, canReconcile: false,
    })
    await authority.close()
    await startAuthority({ expiresAt: 1 })
    expect(await client.reconcile(sessionId, id)).toEqual(terminal)
    expect(await client.overview(sessionId)).toMatchObject({
      expired: true, businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 1 },
      lastFailure: { id, code: 'business-failed' },
    })
    expect(broker.run).toHaveBeenCalledTimes(1)
    expect(broker.reconcile).toHaveBeenCalledTimes(3)
  })

  it('reads the shared grant and reconciles one work assignment through the Host', async (test) => {
    const f = await fixture(test)
    const { client, approver, socketPath, approvalSocketPath, startAuthority, startWitness, grant } = f
    const broker = brokerFixture(reconciliationEndpoint)
    const options = { assistant: { ...assistant, permissions: { exec: true, brokerActions: ['capture'] } }, approvalSocketPath, broker }
    const authority = await startAuthority({ maxOperations: 4 }, options)
    await startWitness()
    const ctx = new Context()
    test.onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(UnixHandoffControl, { socketPath })
    const control = ctx.handoffControl
    const entrance = assistant.mainSessionId
    expect(await control.overview(entrance)).toEqual({
      sessionId: entrance, principalId: grant.principalId, scopeId: grant.scopeId, expiresAt: grant.expiresAt,
      expired: false, maxOperations: 4, reserved: 0, remaining: 4, pendingApprovals: 0, running: 0, unknown: 0,
      businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 }, disclosesImportedData: true,
    })
    await expect(client.overview(SessionId(''))).rejects.toMatchObject({ code: 'bad-request' })
    await expect(approver.overview(entrance)).rejects.toMatchObject({ code: 'bad-request' })

    await control.release({ ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions: options.assistant.permissions } })
    const { id, sessionId } = await dispatchBusiness(f)
    const workId = handoffRequest.delegation.workId
    const nextWorkId = workIdSchema.parse('2'.repeat(64))
    const scoped = () => control.overview(sessionId, undefined, workId)
    expect(await scoped()).toMatchObject({
      sessionId, workId, reserved: 3, remaining: 1, businessCompletion: { unconfirmed: 1 },
    })
    expect(await control.businessOperations(sessionId, undefined, undefined, workId)).toMatchObject({
      workId, operations: [{ id, state: 'settled', canReconcile: true }],
    })
    await expect(control.businessOperations(sessionId, undefined, id, nextWorkId)).rejects.toMatchObject({ code: 'business-cursor-invalid' })
    await expect(control.reconcile(sessionId, id, undefined, nextWorkId)).rejects.toMatchObject({ code: 'not-found' })
    expect(broker.reconcile).not.toHaveBeenCalled()

    const receiptId = brandString<BrokerReceiptId>('capture-confirmed')
    broker.reconcile.mockResolvedValueOnce({ kind: 'succeeded', receiptId })
    expect(await control.reconcile(sessionId, id, undefined, workId)).toMatchObject({
      id, businessCompletion: { kind: 'succeeded', receiptId },
    })
    await control.release({
      ...handoffRequest, key: 'next-assignment', delegation: { workId: nextWorkId, previousWorkId: workId },
    })
    await authority.close()
    await startAuthority({ expiresAt: 1, maxOperations: 1 }, options)
    expect(await scoped()).toMatchObject({
      reserved: 4, remaining: 0, maxOperations: 1, expired: true,
      businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 1, failed: 0 },
    })
    expect(await control.overview(sessionId, undefined, nextWorkId)).toMatchObject({
      workId: nextWorkId, expired: true, businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 },
    })
    expect(await control.businessOperations(sessionId, undefined, undefined, nextWorkId)).toEqual({
      sessionId, workId: nextWorkId, operations: [],
    })
    expect(broker.run).toHaveBeenCalledTimes(1)
    expect(broker.reconcile).toHaveBeenCalledTimes(1)
  })

  it('records a new read-only attempt when a prior witnessed lookup stopped before retaining an observation', async (test) => {
    const f = await fixture(test)
    const { client, evidence, approvalSocketPath, databasePath, grant, startAuthority, startWitness } = f
    const broker = brokerFixture(reconciliationEndpoint)
    await startWitness()
    const authority = await startAuthority({}, { approvalSocketPath, broker })
    const { id, sessionId } = await dispatchBusiness(f)
    await authority.close()
    const store = await OperationStore.open(databasePath, grant)
    let interruptedIntentId: string
    try {
      const attempt = store.reserveReconciliation(id)
      const intent = await evidence.append(reconciliationIntentEvent(store.get(id), attempt))
      interruptedIntentId = intent.id
      store.putReconciliation({ ...attempt, intent })
    } finally {
      store.close()
    }
    await startAuthority({}, { approvalSocketPath, broker })
    expect(await client.businessOperations(sessionId)).toMatchObject({
      operations: [{ id, canReconcile: true, businessCompletion: { kind: 'unconfirmed' } }],
    })
    expect(broker.reconcile).not.toHaveBeenCalled()
    const retried = await client.reconcile(sessionId, id)
    expect(retried.businessCompletion.kind).toBe('pending')
    const receipt = retried.businessCompletion.receipt
    if (receipt === undefined) throw new Error('The fixture expected a witnessed lookup')
    const replacementIntentId = receipt.id.replace(/-outcome$/u, '-admission')
    expect(replacementIntentId).not.toBe(interruptedIntentId)
    expect(await evidence.get(interruptedIntentId)).toBeDefined()
    expect(await evidence.get(interruptedIntentId.replace(/-admission$/u, '-outcome'))).toBeUndefined()
    expect(await evidence.get(replacementIntentId)).toBeDefined()
    expect(broker.run).toHaveBeenCalledTimes(1)
    expect(broker.reconcile).toHaveBeenCalledTimes(1)
  })

  it('keeps provider metadata out of retained business requests and observations', async (test) => {
    const f = await fixture(test)
    const { client, evidence, approvalSocketPath, startAuthority, startWitness } = f
    const broker = brokerFixture(reconciliationEndpoint)
    const resolve = broker.resolve.getMockImplementation()
    if (resolve === undefined) throw new Error('The fixture expected a broker route resolver')
    broker.resolve.mockImplementation((...args) => ({ ...resolve(...args), metadata: { private: 'preparation details' } }))
    const receiptId = brandString<BrokerReceiptId>('fixture-confirmed-receipt')
    const pending = { kind: 'pending' } as const
    const succeeded = { kind: 'succeeded', receiptId } as const
    const richerPending = { ...pending, metadata: { private: 'pending details' } }
    const richerSucceeded = { ...succeeded, metadata: { private: 'success details' } }
    broker.reconcile.mockResolvedValueOnce(richerPending).mockResolvedValueOnce(richerSucceeded)
    await startWitness()
    await startAuthority({}, { approvalSocketPath, broker })
    const { id, sessionId } = await dispatchBusiness(f)
    expect(broker.run.mock.calls[0]?.[0]).not.toHaveProperty('metadata')
    for (const expected of [pending, succeeded]) {
      const { businessCompletion } = await client.reconcile(sessionId, id)
      const { receipt } = businessCompletion
      if (receipt === undefined) throw new Error('The fixture expected a witnessed lookup')
      expect(businessCompletion).toEqual({ ...expected, receipt })
      expect((await evidence.get(receipt.id))?.event.body).toEqual({ fact: 'business-reconciliation', ...expected })
    }
    expect(await client.businessOperations(sessionId)).toMatchObject({ operations: [{ id, businessCompletion: succeeded }] })
    expect(broker.reconcile).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent lookup requests and retains the result when a client stops waiting', async (test) => {
    const f = await fixture(test)
    const { client, approvalSocketPath, startAuthority, startWitness } = f
    const broker = brokerFixture(reconciliationEndpoint)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<{ kind: 'pending' }>()
    const pending = { kind: 'pending' } as const
    test.onTestFinished(() => { release.resolve(pending) })
    broker.reconcile.mockImplementationOnce(async (_spec, _correlation, signal) => {
      const abort = () => { release.resolve(pending) }
      signal.addEventListener('abort', abort, { once: true })
      entered.resolve(undefined)
      try { return await release.promise }
      finally { signal.removeEventListener('abort', abort) }
    })
    await startWitness()
    const authority = await startAuthority({}, { approvalSocketPath, broker })
    const { id, sessionId } = await dispatchBusiness(f)
    const wait = new AbortController()
    const disconnected = client.reconcile(sessionId, id, wait.signal)
    const canceled = expect(disconnected).rejects.toMatchObject({ code: 'authority-unavailable' })
    await entered.promise
    const first = authority['reconcile'](sessionId, id)
    const second = authority['reconcile'](sessionId, id)
    expect(second).toBe(first)
    wait.abort()
    await canceled
    expect(await client.cancel(id)).toMatchObject({ state: 'settled', outcome: { kind: 'business-response', statusCode: 202 } })
    release.resolve(pending)
    const settled = await second
    expect(settled.businessCompletion).toMatchObject(pending)
    expect(settled.businessCompletion.receipt).toBeDefined()
    expect(await client.businessOperations(sessionId)).toEqual({ sessionId, operations: [settled] })
    expect(broker.reconcile).toHaveBeenCalledTimes(1)
  })

  it('checks the stored route against the current grant without reusing the old execution permit', async (test) => {
    const f = await fixture(test)
    const { client, evidence, approvalSocketPath, startAuthority, startWitness } = f
    const broker = brokerFixture(reconciliationEndpoint)
    await startWitness()
    const authority = await startAuthority({}, { approvalSocketPath, broker })
    const { id, sessionId, revision } = await dispatchBusiness(f)
    await authority.close()
    const otherEndpoint = 'https://example.test/other-status'
    const replacement = brokerFixture(otherEndpoint)
    const externalLookup = vi.fn<OperationBroker['reconcile']>().mockResolvedValue({ kind: 'pending' })
    replacement.reconcile.mockImplementation(async (spec, correlation, signal) => {
      if (spec.reconciliationEndpoint !== otherEndpoint) {
        throw new BrokerError('broker-route-changed', 'not-sent', 'The configured lookup route changed.')
      }
      return externalLookup(spec, correlation, signal)
    })
    const changed = await startAuthority({ fingerprint: '2'.repeat(64) }, { approvalSocketPath, broker: replacement })
    const refused = await client.reconcile(sessionId, id)
    expect(refused).toMatchObject({
      canReconcile: true, businessCompletion: { kind: 'unconfirmed', code: 'broker-route-changed' },
    })
    expect(refused.businessCompletion.receipt).toBeDefined()
    expect(externalLookup).not.toHaveBeenCalled()
    await changed.close()
    const expired = await startAuthority({ expiresAt: 1, fingerprint: '3'.repeat(64) }, { approvalSocketPath, broker })
    await expect(client.reconcile(sessionId, id)).rejects.toMatchObject({ code: 'grant-expired' })
    expect(broker.reconcile).not.toHaveBeenCalled()
    await expired.close()
    broker.resolve.mockClear().mockImplementation(() => {
      throw new BrokerError('broker-invalid-body', 'not-sent', 'The current POST byte limit is lower.')
    })
    const expiresAt = Date.now() + 60_000
    await startAuthority({ expiresAt, fingerprint: '4'.repeat(64) }, { approvalSocketPath, broker })
    const result = await client.reconcile(sessionId, id)
    expect(result.businessCompletion.kind).toBe('pending')
    const receipt = result.businessCompletion.receipt
    if (receipt === undefined) throw new Error('The fixture expected a witnessed lookup')
    const intent = await evidence.get(receipt.id.replace(/-outcome$/u, '-admission'))
    expect(intent?.event.body).toMatchObject({ expiresAt })
    expect(intent?.event.body).not.toMatchObject({ revision })
    expect(broker.run).toHaveBeenCalledTimes(1)
    expect(broker.resolve).not.toHaveBeenCalled()
    expect(broker.reconcile).toHaveBeenCalledTimes(1)
  })

  it('preserves a version 5 dispatch and never guesses a lookup target for it', async (test) => {
    const f = await fixture(test)
    const { client, approvalSocketPath, databasePath, startAuthority, startWitness } = f
    await startWitness()
    const legacy = brokerFixture()
    const authority = await startAuthority({}, { approvalSocketPath, broker: legacy })
    const { id, parentId, payloadDigest, sessionId } = await dispatchBusiness(f)
    const { action, method, endpoint, credentialRef, body } = legacy.run.mock.calls[0]![0]
    const legacyDigest = createHash('sha256').update(JSON.stringify([parentId, action, method, endpoint, credentialRef, body])).digest('hex')
    expect(payloadDigest).toBe(legacyDigest)
    const original = await client.status(id)
    await authority.close()
    simulateLegacyStore(databasePath, 5)
    const broker = brokerFixture(reconciliationEndpoint)
    await startAuthority({ fingerprint: '5'.repeat(64) }, { approvalSocketPath, broker })
    expect(await client.status(id)).toEqual(original)
    expect(await client.businessOperations(sessionId)).toMatchObject({ operations: [{ id, canReconcile: false }] })
    await expect(client.reconcile(sessionId, id)).rejects.toMatchObject({ code: 'broker-reconciliation-unavailable' })
    expect(broker.reconcile).not.toHaveBeenCalled()
    expect(broker.run).not.toHaveBeenCalled()
  })

  it('pages business status in Session order and refuses a cursor from a different Session', async (test) => {
    const { client, databasePath, grant, startAuthority } = await fixture(test)
    const policy = { ...grant, maxOperations: 103 }
    const store = await openRecorded(databasePath, policy)
    const sessionId = SessionId('worker-with-history')
    const other = SessionId('other-worker')
    const parentId = operationIdSchema.parse(randomUUID())
    const requestKey = randomUUID()
    const business = {
      ...brokerFixture().resolve('capture', '{}', { parentId, requestKey }),
      parentId,
    }
    try {
      for (let index = 0; index < 101; index++) store.reserve({ requestKey: randomUUID(), sessionId, business }, () => {}, true)
      store.reserve({ requestKey, sessionId: other, business }, () => {}, true)
    } finally {
      store.close()
    }
    await startAuthority(policy)
    const first = await client.businessOperations(sessionId)
    expect(first.operations).toHaveLength(100)
    expect(first.next).toBe(first.operations.at(-1)?.id)
    const second = await client.businessOperations(sessionId, undefined, first.next)
    expect(second.next).toBeUndefined()
    expect(second.operations).toHaveLength(1)
    expect(first.operations.map(operation => operation.id)).not.toContain(second.operations[0]?.id)
    await expect(client.businessOperations(other, undefined, first.next)).rejects.toMatchObject({ code: 'business-cursor-invalid' })
  })

  it('requires the privileged decision and exact reviewed binding before consuming a command once', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority({}, { approvalSocketPath })
    const input = proposal()
    const pending = await client.propose(input)
    expect(pending).toMatchObject({ state: 'pending-approval', review: {
      sessionId: input.sessionId, command: input.command,
      payloadDigest: createHash('sha256').update(input.command).digest('hex'),
    } })
    const approval = decisionFor(pending, 'approve')
    expect(await client.execute(pending.id)).toEqual(pending)
    await expect(client.decide(approval)).rejects.toMatchObject({ code: 'approval-forbidden' })
    await expect(approver.execute(pending.id)).rejects.toMatchObject({ code: 'bad-request' })
    for (const field of ['revision', 'payloadDigest'] as const) {
      await expect(approver.decide({ ...approval, [field]: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'approval-mismatch' })
    }
    expect(await evidence.get(`${pending.id}-admission`)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    const issued = await approver.decide(approval)
    expect(issued).toMatchObject({ id: pending.id, state: 'issued', admission: { id: `${pending.id}-admission` } })
    expect(await approver.decide(approval)).toEqual(issued)
    expect(await evidence.get(`${pending.id}-admission`)).toMatchObject({
      receipt: issued.admission,
      event: { body: {
        approval: 'human-approved', commandDigest: approval.payloadDigest, revision: approval.revision, sessionId: input.sessionId,
      } },
    })
    const settled = await client.execute(pending.id)
    expect(settled).toMatchObject({ state: 'settled', outcome: { kind: 'exited', observation } })
    expect(await client.execute(pending.id)).toEqual(settled)
    expect(run).toHaveBeenCalledExactlyOnceWith(input.sessionId, input.command, expect.any(AbortSignal))
  })

  it('preserves denial evidence and rejects approval after denial or cancellation', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority({}, { approvalSocketPath })
    const pending = await client.propose(proposal())
    const decision = decisionFor(pending, 'deny')
    const denied = await approver.decide(decision)
    expect(denied).toMatchObject({ state: 'canceled', receipt: { id: `${pending.id}-revocation` } })
    expect(await approver.decide(decision)).toEqual(denied)
    expect(await evidence.get(`${pending.id}-revocation`)).toMatchObject({
      event: { body: { reason: 'approval-rejected', commandDigest: decision.payloadDigest, revision: decision.revision } },
    })
    expect(await evidence.get(`${pending.id}-admission`)).toBeUndefined()
    await expect(approver.decide({ ...decision, decision: 'approve' })).rejects.toMatchObject({ code: 'approval-not-pending' })
    expect(await client.execute(pending.id)).toEqual(denied)
    const another = await client.propose(proposal())
    const canceled = await client.cancel(another.id)
    await expect(approver.decide(decisionFor(another, 'approve'))).rejects.toMatchObject({ code: 'approval-not-pending' })
    expect(await client.execute(another.id)).toEqual(canceled)
    expect(run).not.toHaveBeenCalled()
  })

  it('requires approval after restart and recovers a witnessed permit without executing during recovery', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority, run } = await fixture(test)
    const closeWitness = await startWitness()
    const authority = await startAuthority({}, { approvalSocketPath })
    await closeWitness()
    const input = proposal()
    const pending = await client.propose(input)
    await authority.close()
    const restarted = await startAuthority({}, { approvalSocketPath })
    expect(await client.execute(pending.id)).toEqual(pending)
    expect(await approver.decide(decisionFor(pending, 'approve'))).toMatchObject({ state: 'pending-evidence' })
    await restarted.close()
    await startWitness()
    await startAuthority({}, { approvalSocketPath })
    const append = vi.spyOn(evidence, 'append')
    append.mockResolvedValueOnce({ id: `${pending.id}-admission`, digest: 'a'.repeat(64) })
    expect(await client.execute(pending.id)).toMatchObject({ state: 'pending-evidence' })
    expect(run).not.toHaveBeenCalled()
    expect(await client.status(pending.id)).toMatchObject({ state: 'issued' })
    expect(await client.execute(pending.id)).toMatchObject({ state: 'settled' })
    expect(run).toHaveBeenCalledExactlyOnceWith(input.sessionId, input.command, expect.any(AbortSignal))
  })

  it('admits unattended shell without a decision and still holds its business request for one', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    await startWitness()
    await startAuthority({}, { approvalSocketPath, unattendedShell: true, broker })
    const input = proposal()
    const issued = await client.propose(input)
    expect(issued).toMatchObject({ state: 'issued', admission: { id: `${issued.id}-admission` } })
    expect(issued.review).toBeUndefined()
    run.mockImplementationOnce(async (_session, _command, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      await submit({ requestKey: randomUUID(), action: 'capture', body: '{}' }, signal)
      return observation
    })
    const waiting = client.waitReview(issued.id)
    const execution = client.execute(issued.id)
    const pending = await waiting
    expect(pending).toMatchObject({ state: 'pending-approval', review: { business: { action: 'capture' } } })
    expect(broker.run).not.toHaveBeenCalled()
    if (pending === undefined) throw new Error('Expected a business review')
    await approver.decide(decisionFor(pending, 'approve'))
    expect(await execution).toMatchObject({ state: 'settled', receipt: { id: `${issued.id}-outcome` }, outcome: { kind: 'exited' } })
    expect(broker.run).toHaveBeenCalledOnce()
  })

  describe('owner edits of unattended rules', () => {
    const permitted = [{ action: 'capture' }, { action: 'refund' }]
    const routes = { capture: 'c'.repeat(64), refund: 'd'.repeat(64) }
    const profile = (
      businessActions: { action: string }[] = permitted, unattendedActions: UnattendedAction[] = [{ action: 'refund' }],
      brokerRoutes: Record<string, string> = routes,
    ) => ({
      approvalSocketPath: '', unattendedShell: true, broker: {
        ...brokerFixture(reconciliationEndpoint, brokerRoutes),
        reconcile: vi.fn<OperationBroker['reconcile']>().mockResolvedValue({ kind: 'succeeded', receiptId: brandString<BrokerReceiptId>('capture-done') }),
      },
      businessActions, unattendedActions,
      connections: {
        list: async () => businessActions.map(({ action }) => ({ action, credentialRef: 'FIXTURE_TOKEN', configured: true, returnsResponse: false })),
        credentialChange: () => async () => {},
      },
    })

    async function rulesFixture(test: TestContext) {
      const context = await fixture(test)
      const { client, approver, approvalSocketPath, databasePath, startWitness, startAuthority, run } = context
      await startWitness()
      const start = (fingerprint: string, options: ReturnType<typeof profile>, limits: Partial<Grant> = {}) =>
        startAuthority({ maxOperations: 64, fingerprint, ...limits }, { ...options, approvalSocketPath })
      let amount = 0
      /** Submit a request, resolve its outcome, and report whether it was sent without a decision. */
      const sentUnattended = async (options: ReturnType<typeof profile>, requestBody = `{"account":"A1","amount":${++amount}}`, action = 'capture') => {
        const sent = options.broker.run.mock.calls.length
        const request = await submitCapture(client, run, requestBody, action)
        const pending = await request.waiting
        if (pending !== undefined) await approver.decide(decisionFor(pending, 'deny'))
        await request.execution
        if (pending === undefined) {
          const [operation] = (await client.businessOperations(SessionId('worker-1'))).operations
          if (operation === undefined) throw new Error('Expected the submitted business operation')
          await client.reconcile(operation.sessionId, operation.id)
        }
        return pending === undefined && options.broker.run.mock.calls.length === sent + 1
      }
      /** Read the owner rules record as the database holds it. */
      const readSaved = (): unknown => {
        const db = new DatabaseSync(databasePath, { readOnly: true })
        try {
          const saved = db.prepare('SELECT owner_rules FROM authority').get()?.owner_rules
          return typeof saved === 'string' ? JSON.parse(saved) : saved
        } finally {
          db.close()
        }
      }
      return { ...context, start, sentUnattended, readSaved }
    }

    it('applies a witnessed edit and keeps it across a restart with the same profile', async (test) => {
      const { approver, evidence, start, sentUnattended } = await rulesFixture(test)
      const options = profile()
      const authority = await start('1'.repeat(64), options)
      expect(await sentUnattended(options)).toBe(false)
      const { revision, connections } = await approver.brokerConnections()
      expect(connections).toMatchObject([
        { action: 'capture', unattended: [], routeChangedSinceRulesSaved: false },
        { action: 'refund', unattended: [{}], routeChangedSinceRulesSaved: false },
      ])
      const rule = { match: { account: 'A1' }, allow: ['amount'] }
      await expect(approver.setBrokerConnection({ action: 'other', unattended: [rule], revision }))
        .rejects.toMatchObject({ code: 'broker-action-unavailable' })
      await expect(approver.setBrokerConnection({ action: 'capture', unattended: [rule], revision: 'f'.repeat(64) }))
        .rejects.toMatchObject({ code: 'revision-mismatch' })
      await expect(approver.setBrokerConnection({ action: 'capture', unattended: [{ allow: [''] }], revision }))
        .rejects.toMatchObject({ code: 'bad-request' })
      await expect(approver.setBrokerConnection({ action: 'capture', unattended: [{ match: { account: 'A1' } }] as never, revision }))
        .rejects.toMatchObject({ code: 'bad-request' })
      const append = vi.spyOn(evidence, 'append').mockRejectedValueOnce(new Witness.EvidenceError('unavailable', 'The witness is stopped'))
      await expect(approver.setBrokerConnection({ action: 'capture', unattended: [rule], revision }))
        .rejects.toMatchObject({ code: 'grant-update-evidence-unavailable' })
      const event = append.mock.calls[0]?.[0]
      if (event === undefined) throw new Error('Expected the refused edit to reach the witness')
      expect(await approver.brokerConnections()).toMatchObject({ revision, connections: [{ unattended: [] }, { unattended: [{}] }] })
      expect(await sentUnattended(options)).toBe(false)

      const changed = await approver.setBrokerConnection({ action: 'capture', unattended: [rule], revision })
      expect(changed.connections).toMatchObject([{ action: 'capture', unattended: [rule] }, { action: 'refund', unattended: [{}] }])
      expect(changed.revision).not.toBe(revision)
      expect((await evidence.get(event.id))?.event.body).toEqual({
        kind: 'unattended-rules-update', principalId: 'agent-1', scopeId: 'offline-shell', previousRevision: revision,
        actions: [
          { action: 'capture', routeDigest: routes.capture, rules: [rule] },
          { action: 'refund', routeDigest: routes.refund, rules: [{}] },
        ],
      })
      expect(await sentUnattended(options)).toBe(true)

      await authority.close()
      await start('1'.repeat(64), options)
      expect(await approver.brokerConnections()).toEqual(changed)
      expect(await sentUnattended(options)).toBe(true)
      await approver.setBrokerConnection({ action: 'capture', unattended: [], revision: changed.revision })
      expect(await sentUnattended(options)).toBe(false)
    })

    it('applies the profile rules, including edits to them, until the owner edits the rules', async (test) => {
      const { approver, start, sentUnattended } = await rulesFixture(test)
      const original = profile()
      const authority = await start('1'.repeat(64), original)
      expect(await sentUnattended(original)).toBe(false)
      await authority.close()

      const edited = profile(permitted, [{ action: 'capture', match: { account: 'A1' }, allow: ['amount'] }])
      await start('2'.repeat(64), edited)
      expect((await approver.brokerConnections()).connections).toMatchObject([
        { action: 'capture', unattended: [{ match: { account: 'A1' }, allow: ['amount'] }] }, { action: 'refund', unattended: [] },
      ])
      expect(await sentUnattended(edited)).toBe(true)
    })

    it('copies each action\'s profile rules under its current route at the first edit and keeps an explicit empty list', async (test) => {
      const { approver, start, sentUnattended, readSaved } = await rulesFixture(test)
      const original = profile(permitted, [{ action: 'capture' }, { action: 'refund', match: { account: 'A1' }, allow: ['amount'] }])
      const authority = await start('1'.repeat(64), original)
      expect(await sentUnattended(original)).toBe(true)
      const { revision } = await approver.brokerConnections()
      const removed = await approver.setBrokerConnection({ action: 'capture', unattended: [], revision })
      expect(await sentUnattended(original)).toBe(false)
      expect(await sentUnattended(original, undefined, 'refund')).toBe(true)
      await authority.close()
      expect(readSaved()).toMatchObject({
        revision,
        actions: [
          { action: 'capture', routeDigest: routes.capture, rules: [] },
          { action: 'refund', routeDigest: routes.refund, rules: [{ match: { account: 'A1' }, allow: ['amount'] }] },
        ],
      })

      // A changed model or limit reaches the store only as a different authority fingerprint.
      const changed = profile(permitted, [{ action: 'capture' }, { action: 'refund' }])
      const reopened = await start('2'.repeat(64), changed, { maxOperations: 80 })
      const read = await approver.brokerConnections()
      expect(read.revision).not.toBe(removed.revision)
      expect(read).toEqual({ ...removed, revision: read.revision })
      expect(await sentUnattended(changed)).toBe(false)
      expect(await sentUnattended(changed, '{"account":"B2"}', 'refund')).toBe(false)
      await reopened.close()

      const rerouted = profile(permitted, [], { ...routes, refund: 'e'.repeat(64) })
      await start('3'.repeat(64), rerouted)
      expect((await approver.brokerConnections()).connections).toMatchObject([
        { action: 'capture', unattended: [], routeChangedSinceRulesSaved: false },
        { action: 'refund', unattended: [], routeChangedSinceRulesSaved: true },
      ])
      expect(await sentUnattended(rerouted, undefined, 'refund')).toBe(false)
    })

    it('turns off only the rules of a re-routed action until it is routed as when they were saved or they are saved again', async (test) => {
      const { client, approver, start, sentUnattended, readSaved } = await rulesFixture(test)
      const original = profile(permitted, [])
      const first = await start('1'.repeat(64), original)
      const { revision } = await approver.brokerConnections()
      const captured = await approver.setBrokerConnection({ action: 'capture', unattended: [{}], revision })
      const both = await approver.setBrokerConnection({ action: 'refund', unattended: [{}], revision: captured.revision })
      expect(await sentUnattended(original)).toBe(true)
      expect(await sentUnattended(original, undefined, 'refund')).toBe(true)
      const issued = await client.propose(proposal())
      await first.close()
      const saved = readSaved()

      const rerouted = profile(permitted, [], { ...routes, capture: 'e'.repeat(64) })
      const second = await start('2'.repeat(64), rerouted)
      const inactive = await approver.brokerConnections()
      expect(inactive.connections).toEqual([
        expect.objectContaining({ action: 'capture', unattended: [], routeChangedSinceRulesSaved: true }),
        expect.objectContaining({ action: 'refund', unattended: [{}], routeChangedSinceRulesSaved: false }),
      ])
      expect(await sentUnattended(rerouted)).toBe(false)
      expect(await sentUnattended(rerouted, undefined, 'refund')).toBe(true)
      await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch' })
      await second.close()
      expect(readSaved()).toEqual(saved)

      const restored = profile(permitted, [])
      const third = await start('3'.repeat(64), restored)
      expect((await approver.brokerConnections()).connections).toEqual(both.connections)
      expect(await sentUnattended(restored)).toBe(true)
      await third.close()

      const fourth = await start('2'.repeat(64), rerouted)
      const again = await approver.brokerConnections()
      expect(again.connections).toEqual(inactive.connections)
      const rule = { match: { account: 'A1' }, allow: ['amount'] }
      const edited = await approver.setBrokerConnection({ action: 'capture', unattended: [rule], revision: again.revision })
      expect(edited.connections).toMatchObject([
        { action: 'capture', unattended: [rule], routeChangedSinceRulesSaved: false },
        { action: 'refund', unattended: [{}], routeChangedSinceRulesSaved: false },
      ])
      expect(await sentUnattended(rerouted)).toBe(true)
      expect(await sentUnattended(rerouted, '{"account":"B2"}')).toBe(false)
      expect(await sentUnattended(rerouted, undefined, 'refund')).toBe(true)
      await fourth.close()
      expect(readSaved()).toMatchObject({
        actions: [
          { action: 'capture', routeDigest: 'e'.repeat(64), rules: [rule] },
          { action: 'refund', routeDigest: routes.refund, rules: [{}] },
        ],
      })
    })

    it('keeps every saved action\'s rules active when a connection is added', async (test) => {
      const { approver, start, sentUnattended, readSaved } = await rulesFixture(test)
      const original = profile(permitted, [])
      const first = await start('1'.repeat(64), original)
      const { revision } = await approver.brokerConnections()
      const captured = await approver.setBrokerConnection({ action: 'capture', unattended: [{}], revision })
      await approver.setBrokerConnection({ action: 'refund', unattended: [{}], revision: captured.revision })
      await first.close()
      const saved = readSaved()

      const added = profile([{ action: 'capture' }, { action: 'notify' }, { action: 'refund' }], [], { ...routes, notify: 'e'.repeat(64) })
      const second = await start('2'.repeat(64), added)
      expect((await approver.brokerConnections()).connections).toMatchObject([
        { action: 'capture', unattended: [{}], routeChangedSinceRulesSaved: false },
        { action: 'notify', unattended: [], routeChangedSinceRulesSaved: false },
        { action: 'refund', unattended: [{}], routeChangedSinceRulesSaved: false },
      ])
      expect(await sentUnattended(added)).toBe(true)
      expect(await sentUnattended(added, undefined, 'refund')).toBe(true)
      expect(await sentUnattended(added, undefined, 'notify')).toBe(false)
      await second.close()
      expect(readSaved()).toEqual(saved)
    })

    it('saves only the rules of currently permitted actions when the owner edits rules', async (test) => {
      const { approver, evidence, start } = await rulesFixture(test)
      const both = profile(permitted, [])
      const first = await start('1'.repeat(64), both)
      const { revision } = await approver.brokerConnections()
      await approver.setBrokerConnection({ action: 'refund', unattended: [{}], revision })
      await first.close()

      const captureOnly = profile([{ action: 'capture' }], [])
      const second = await start('2'.repeat(64), captureOnly)
      const narrowed = await approver.brokerConnections()
      expect(narrowed).toMatchObject({ connections: [{ action: 'capture', unattended: [], routeChangedSinceRulesSaved: false }] })
      await expect(approver.setBrokerConnection({ action: 'refund', unattended: [{}], revision: narrowed.revision }))
        .rejects.toMatchObject({ code: 'broker-action-unavailable' })
      const append = vi.spyOn(evidence, 'append')
      const rule = { match: { account: 'A1' }, allow: ['amount'] }
      await approver.setBrokerConnection({ action: 'capture', unattended: [rule], revision: narrowed.revision })
      expect(append.mock.calls[0]?.[0].body).toMatchObject({ actions: [{ action: 'capture', routeDigest: routes.capture, rules: [rule] }] })
      await second.close()

      await start('3'.repeat(64), both)
      expect((await approver.brokerConnections()).connections).toMatchObject([
        { action: 'capture', unattended: [rule] }, { action: 'refund', unattended: [] },
      ])
    })

    it('keeps limits and rules in separate records that each change the grant revision', async (test) => {
      const { client, approver, start, sentUnattended } = await rulesFixture(test)
      const options = profile()
      const expiresAt = Date.now() + 3_600_000
      const authority = await start('1'.repeat(64), options, { expiresAt, maxOperations: 16 })
      const issued = await client.propose(proposal())
      const limits = await approver.grant()
      const ruled = await approver.setBrokerConnection({ action: 'capture', unattended: [{}], revision: limits.revision })
      expect(ruled.revision).not.toBe(limits.revision)
      expect(await approver.grant()).toEqual({ ...limits, revision: ruled.revision, reserved: 1, remaining: 15 })
      await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch' })
      await expect(approver.updateGrant({ revision: limits.revision, maxOperations: 20, expiresAt })).rejects.toMatchObject({ code: 'revision-mismatch' })

      await authority.close()
      const configured = Date.now() + 7_200_000
      await start('1'.repeat(64), options, { expiresAt: configured, maxOperations: 24 })
      expect(await approver.grant()).toMatchObject({ expiresAt: configured, maxOperations: 24, revision: ruled.revision })
      expect(await sentUnattended(options)).toBe(true)

      const edited = await approver.updateGrant({ revision: ruled.revision, maxOperations: 20, expiresAt: configured })
      expect(edited.revision).not.toBe(ruled.revision)
      expect(await approver.brokerConnections()).toEqual({ ...ruled, revision: edited.revision })
      expect(await sentUnattended(options)).toBe(true)
    })

    it('refuses a business approval decided before a rule edit', async (test) => {
      const { client, approver, run, start } = await rulesFixture(test)
      const options = profile(permitted, [])
      await start('1'.repeat(64), options)
      const request = await submitCapture(client, run, '{"account":"A1","amount":5}')
      const pending = await request.waiting
      if (pending === undefined) throw new Error('Expected a business review')
      const { revision } = await approver.brokerConnections()
      await approver.setBrokerConnection({ action: 'refund', unattended: [{}], revision })
      await expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'revision-mismatch' })
      await approver.decide(decisionFor(pending, 'deny'))
      await request.execution
      expect(options.broker.run).not.toHaveBeenCalled()
    })

    it('refuses a saved development rule whose match omits allow', async (test) => {
      const { approver, databasePath, start } = await rulesFixture(test)
      const options = profile()
      const authority = await start('1'.repeat(64), options)
      const { revision } = await approver.brokerConnections()
      await approver.setBrokerConnection({ action: 'capture', unattended: [{ match: { account: 'A1' }, allow: [] }], revision })
      await authority.close()
      using db = new DatabaseSync(databasePath)
      db.exec("UPDATE authority SET owner_rules = json_remove(owner_rules, '$.actions[0].rules[0].allow')")
      await expect(start('1'.repeat(64), options)).rejects.toMatchObject({
        code: 'storage-unavailable', cause: { message: 'The saved unattended rules are corrupt' },
      })
    })

    it('sends a body that a rule with allowed fields covers and holds any other body', async (test) => {
      const { approver, start, sentUnattended } = await rulesFixture(test)
      const options = profile()
      await start('1'.repeat(64), options)
      const { revision } = await approver.brokerConnections()
      const rule = { match: { account: 'A1' }, allow: ['amount'] }
      expect((await approver.setBrokerConnection({ action: 'capture', unattended: [rule], revision })).connections[0]).toMatchObject({ unattended: [rule] })
      expect(await sentUnattended(options, '{"account":"A1","amount":5}')).toBe(true)
      expect(await sentUnattended(options, '{"account":"A1"}')).toBe(true)
      expect(await sentUnattended(options, '{"account":"A1","amount":5,"bcc":"other"}')).toBe(false)
      expect(await sentUnattended(options, '{"account":"A1", "amount":5}')).toBe(false)
    })
  })

  it('refuses at load a profile rule that an owner edit could not save', async () => {
    const load = (unattendedBrokerActions: UnattendedAction[]) => apply(new Context(), {
      principalId: 'agent-1', scopeId: 'offline-shell', socketPath: '/nonexistent/ops.sock', databasePath: '/nonexistent/ops.sqlite',
      evidenceSocketPath: '/nonexistent/ev.sock', grantExpiresAt: 1, maxOperations: 1, unattendedBrokerActions,
    })
    await expect(load([{ action: 'capture', match: { account: 'x'.repeat(4097) }, allow: [] }]))
      .rejects.toThrow(/^Invalid unattendedBrokerActions: [^]*\[0\]\.match\.account/u)
    await expect(load(Array.from({ length: 65 }, () => ({ action: 'capture' }))))
      .rejects.toThrow(/^Invalid unattendedBrokerActions: [^]*more than 64 unattended rules/u)
    await expect(load([{ action: 'capture', match: { account: 'A1' } }] as never))
      .rejects.toThrow('Unattended rule for action "capture" must add allow (use allow: [] to permit no other fields).')
  })

  it('witnesses and writes overlapping credential changes in the order they arrive', async (test) => {
    const { approver, approvalSocketPath, evidence, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const written: Array<string | null> = []
    await startAuthority({}, {
      approvalSocketPath,
      connections: {
        list: async () => [{ action: 'capture', credentialRef: 'CAPTURE_TOKEN', configured: written.at(-1) !== null, returnsResponse: false }],
        credentialChange: update => async () => { written.push(update.value) },
      },
    })
    const append = evidence.append.bind(evidence)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const spy = vi.spyOn(evidence, 'append').mockImplementationOnce(async (event) => {
      entered.resolve(undefined)
      await release.promise
      return append(event)
    })
    const first = approver.setBrokerConnection({ action: 'capture', value: 'fixture-first' })
    await entered.promise
    const second = approver.setBrokerConnection({ action: 'capture', value: null })
    await expect(Promise.race([second.then(() => 'settled'), new Promise(resolve => setTimeout(resolve, 50, 'waiting'))])).resolves.toBe('waiting')
    expect(spy).toHaveBeenCalledOnce()
    release.resolve(undefined)
    await Promise.all([first, second])
    expect(spy.mock.calls.map(([event]) => event.body)).toMatchObject([{ stored: true }, { stored: false }])
    expect(written).toEqual(['fixture-first', null])
  })

  it('opens a database whose owner limits were saved before unattended rules had their own record', async (test) => {
    const { approver, approvalSocketPath, databasePath, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const authority = await startAuthority({}, { approvalSocketPath })
    const { revision } = await approver.grant()
    const saved = await approver.updateGrant({ revision, maxOperations: 5, expiresAt: Date.now() + 60_000 })
    await authority.close()
    simulateLegacyStore(databasePath, 9)
    await startAuthority({}, { approvalSocketPath })
    // The migration records the configuration once and keeps the revision the owner limits were saved under.
    expect({ ...await approver.grant(), configuration: saved.configuration }).toEqual(saved)
  })

  describe('business records', () => {
    const rows = ['id', 'sessionId', 'action', 'state', 'approval', 'outcome', 'receipt', 'canReconcile', 'businessCompletion',
      'method', 'endpoint', 'tool', 'body', 'workId']
    const options = (approvalSocketPath: string) => ({
      approvalSocketPath, unattendedShell: true, broker: brokerFixture(), unattendedActions: [{ action: 'capture', match: { kind: 'auto' }, allow: ['n', 'text'] }],
    })

    it('lists approved, denied, and rule-admitted requests of every Session newest first on the approval socket only', async (test) => {
      const f = await fixture(test)
      const { client, approver, approvalSocketPath, startWitness, startAuthority } = f
      await startWitness()
      await startAuthority({ maxOperations: 200 }, options(approvalSocketPath))
      await submitIn(f, 'worker-2', '{"kind":"auto"}')
      await submitIn(f, 'worker-2', '{"message":"denied"}', 'deny')
      await submitIn(f, 'worker-1', '{"message":"approved"}', 'approve')
      await expect(client.businessRecords()).rejects.toMatchObject({ code: 'approval-forbidden' })

      const { records, next } = await approver.businessRecords()
      expect(next).toBeUndefined()
      expect(records.map(({ sessionId, approval, state, body }) => ({ sessionId, approval, state, body }))).toEqual([
        { sessionId: 'worker-1', approval: 'approved', state: 'settled', body: '{"message":"approved"}' },
        { sessionId: 'worker-2', approval: 'denied', state: 'canceled', body: '{"message":"denied"}' },
        { sessionId: 'worker-2', approval: 'unattended', state: 'settled', body: '{"kind":"auto"}' },
      ])
      expect(records[0]).toMatchObject({
        action: 'capture', method: 'POST', endpoint: 'https://example.test/submit', outcome: { kind: 'business-response', statusCode: 202 },
        receipt: { id: `${records[0]?.id}-outcome` }, businessCompletion: { kind: 'unconfirmed' },
      })
      expect(records.flatMap(record => Object.keys(record)).filter(field => !rows.includes(field))).toEqual([])
      expect(await approver.businessRecords(records[0]?.id)).toEqual({ records: records.slice(1) })
      await expect(approver.businessRecords(operationIdSchema.parse(randomUUID()))).rejects.toMatchObject({ code: 'business-cursor-invalid' })
      const shell = await client.propose(proposal('worker-1'))
      await expect(approver.businessRecords(shell.id)).rejects.toMatchObject({ code: 'business-cursor-invalid' })
      const owner = new Context()
      const guest = new Context()
      test.onTestFinished(async () => { await owner.fiber.dispose(); await guest.fiber.dispose() })
      await owner.plugin(UnixHandoffControl, { socketPath: f.socketPath, approvalSocketPath })
      await guest.plugin(UnixHandoffControl, { socketPath: f.socketPath })
      expect(await owner.handoffControl.businessRecords(records[1]?.id)).toEqual({ records: records.slice(2) })
      await expect(guest.handoffControl.businessRecords()).rejects.toMatchObject({ code: 'authority-unavailable' })

      for (let index = 0; index < 48; index++) await submitIn(f, 'worker-1', `{"kind":"auto","n":${index}}`, 'approve')
      const full = await approver.businessRecords()
      expect(full.records).toHaveLength(50)
      expect(full.next).toBe(full.records.at(-1)?.id)
      expect(await approver.businessRecords(full.next)).toEqual({ records: records.slice(2) })

      const large = (index: number) => `{"kind":"auto","n":${index},"text":"${'x'.repeat(250_000)}"}`
      for (let index = 0; index < 5; index++) await submitIn(f, 'worker-1', large(index), 'approve')
      const bounded = await approver.businessRecords()
      expect(bounded.records.map(({ body }) => body)).toEqual([4, 3, 2, 1].map(large))
      expect(bounded.next).toBe(bounded.records.at(-1)?.id)
      const older = await approver.businessRecords(bounded.next)
      expect(older.records[0]?.body).toBe(large(0))
      expect(older.records.slice(1).map(({ id }) => id)).toEqual(full.records.slice(0, 49).map(({ id }) => id))
    })

    it('marks each request a rule admitted after opening a database from before rule admission was recorded', async (test) => {
      const f = await fixture(test)
      const { approver, approvalSocketPath, databasePath, startWitness, startAuthority } = f
      await startWitness()
      const broker = brokerFixture(reconciliationEndpoint)
      broker.reconcile.mockResolvedValue({ kind: 'succeeded', receiptId: brandString<BrokerReceiptId>('capture-done') })
      const authority = await startAuthority({ maxOperations: 16 }, { ...options(approvalSocketPath), broker })
      await submitIn(f, 'worker-1', '{"kind":"auto","n":1}')
      const first = (await approver.businessRecords()).records[0]!
      await f.client.reconcile(first.sessionId, first.id)
      await submitIn(f, 'worker-1', '{"kind":"auto","n":2}')
      await submitIn(f, 'worker-1', '{"message":"awaiting"}', 'approve')
      await submitIn(f, 'worker-1', '{"message":"canceled"}', 'deny')
      await submitIn(f, 'worker-1', '{"message":"approved"}', 'approve')
      const [, canceled, awaiting, reserved] = (await approver.businessRecords()).records
      await authority.close()
      simulateLegacyStore(databasePath, 10)
      // The previous version reserved a rule-admitted request in `pending-evidence` and one awaiting a decision in
      // `pending-approval`, neither with an approval.
      const db = new DatabaseSync(databasePath)
      const rewind = db.prepare(`UPDATE operations SET record = json_set(
        json_remove(record, '$.approval', '$.admission', '$.outcome', '$.receipt'), '$.state', ?) WHERE id = ?`)
      rewind.run('pending-evidence', reserved?.id ?? '')
      rewind.run('pending-approval', awaiting?.id ?? '')
      rewind.run('canceled', canceled?.id ?? '')
      db.close()
      await startAuthority({ maxOperations: 16 }, options(approvalSocketPath))
      expect((await approver.businessRecords()).records.map(({ approval, state }) => ({ approval, state }))).toEqual([
        { approval: 'approved', state: 'settled' },
        { approval: undefined, state: 'canceled' },
        { approval: undefined, state: 'canceled' },
        { approval: 'unattended', state: 'canceled' },
        { approval: 'unattended', state: 'settled' },
      ])
    })

    it('never lists file transfers', async (test) => {
      const { client, approver, approvalSocketPath, startWitness, startAuthority } = await fixture(test)
      const { delegation, exportFile, options: fileOptions } = fileFixture(Buffer.from('report'))
      await startWitness()
      await startAuthority({ maxOperations: 2 }, { ...fileOptions, approvalSocketPath })
      await client.execute((await client.propose(delegation)).id)
      await client.transferFile(exportFile)
      expect(await approver.businessRecords()).toEqual({ records: [] })
    })
  })

  it('compares every witness event with the authority receipts and reports what the authority does not account for', async (test) => {
    const { client, approver, approvalSocketPath, evidence, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    await startAuthority({ maxOperations: 64 }, { approvalSocketPath })
    const settled: OperationStatus[] = []
    for (let index = 0; index < 27; index++) {
      const pending = await client.propose(proposal())
      await approver.decide(decisionFor(pending, 'approve'))
      settled.push(await client.execute(pending.id))
    }
    const denied = await client.propose(proposal())
    await approver.decide(decisionFor(denied, 'deny'))
    const grant = await approver.grant()
    await approver.updateGrant({ revision: grant.revision, maxOperations: 65, expiresAt: Date.now() + 60_000 })
    await expect(client.receipts([denied.id])).rejects.toMatchObject({ code: 'approval-forbidden' })
    expect(await approver.receipts([denied.id, operationIdSchema.parse(randomUUID())])).toEqual({
      receipts: [{ id: denied.id, revocation: { id: `${denied.id}-revocation`, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string } }],
    })

    // 27 settled operations, one revocation, the limit edit, and the configuration record of the start.
    expect(await verifyRecords(approver, evidence)).toEqual({ events: 57, compared: 56, other: 1, problems: [] })

    const [first, second, third] = settled
    if (first === undefined || second === undefined || third === undefined) throw new Error('Expected settled operations')
    const altered: Pick<OperationControlClient, 'grant' | 'receipts'> = {
      grant: signal => approver.grant(signal),
      async receipts(ids, signal) {
        const { receipts } = await approver.receipts(ids, signal)
        return { receipts: receipts.flatMap(({ outcome, ...held }) => {
          if (held.id === first.id) return []
          if (held.id === second.id) return [held]
          return [{ ...held, ...outcome === undefined ? {} : { outcome: held.id === third.id ? { ...outcome, digest: 'e'.repeat(64) } : outcome } }]
        }) }
      },
    }
    expect((await verifyRecords(altered, evidence)).problems).toEqual([
      { eventId: `${first.id}-admission`, problem: 'operation-missing' },
      { eventId: `${first.id}-outcome`, problem: 'operation-missing' },
      { eventId: `${second.id}-outcome`, problem: 'receipt-missing' },
      { eventId: `${third.id}-outcome`, problem: 'digest-mismatch' },
    ])
    const { configuration } = await approver.grant()
    for (const [claimed, problem] of [
      [{ ...configuration, digest: 'e'.repeat(64) }, 'digest-mismatch'],
      [{ ...configuration, id: `configuration-${'e'.repeat(64)}` }, 'event-missing'],
    ] as const) {
      const claims: Pick<OperationControlClient, 'grant' | 'receipts'> = {
        grant: async signal => ({ ...await approver.grant(signal), configuration: claimed }),
        receipts: (ids, signal) => approver.receipts(ids, signal),
      }
      expect((await verifyRecords(claims, evidence)).problems).toEqual([{ eventId: claimed.id, problem }])
    }
    const stalled: Pick<EvidenceClient, 'list'> = { list: async after => ({ records: [], next: after }) }
    await expect(verifyRecords(approver, stalled))
      .rejects.toThrow('The witness returned page position 0 after position 0, so the comparison cannot advance.')
  })

  it('looks up a rule-admitted request whose response was lost like an approved one and refuses a denied request', async (test) => {
    const { client, approver, evidence, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture(reconciliationEndpoint)
    broker.run.mockRejectedValueOnce(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
    await startWitness()
    await startAuthority({ maxOperations: 8 }, {
      approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture', match: { account: 'A1' }, allow: ['amount'] }],
    })
    const sessionId = SessionId('worker-1')
    await (await submitCapture(client, run, '{"account":"A1"}')).execution
    const [lost] = (await client.businessOperations(sessionId)).operations
    if (lost === undefined) throw new Error('Expected the rule-admitted request')
    expect(lost).toMatchObject({ state: 'unknown', approval: 'unattended', canReconcile: true, outcome: { kind: 'unknown' } })
    const { id } = lost
    const append = vi.spyOn(evidence, 'append')
    const receiptId = brandString<BrokerReceiptId>('rule-request-confirmed')
    broker.reconcile.mockImplementationOnce(async () => {
      expect(append.mock.calls.map(([event]) => event)).toMatchObject([
        { operationId: id, kind: 'admission', body: { fact: 'business-reconciliation' } },
      ])
      return { kind: 'succeeded', receiptId }
    })
    const checked = await client.reconcile(sessionId, id)
    expect(checked).toMatchObject({ id, state: 'unknown', canReconcile: false, businessCompletion: { kind: 'succeeded', receiptId } })
    expect(await client.overview(sessionId)).toMatchObject({ unknown: 0,
      businessCompletion: { succeeded: 1, failed: 0, pending: 0, unconfirmed: 0 },
    })
    expect(await evidence.get(checked.businessCompletion.receipt!.id)).toMatchObject({
      event: { kind: 'outcome', operationId: id, body: { fact: 'business-reconciliation', kind: 'succeeded', receiptId } },
    })
    expect(broker.run).toHaveBeenCalledOnce()

    const held = await submitCapture(client, run, '{"account":"A2"}')
    const pending = await held.waiting
    if (pending === undefined) throw new Error('Expected a business review')
    await approver.decide(decisionFor(pending, 'deny'))
    await held.execution
    expect((await client.businessOperations(sessionId)).operations[0]).toMatchObject({ id: pending.id, approval: 'denied', canReconcile: false })
    await expect(client.reconcile(sessionId, pending.id)).rejects.toMatchObject({ code: 'broker-reconciliation-unavailable' })
    expect(broker.run).toHaveBeenCalledOnce()
    expect(broker.reconcile).toHaveBeenCalledOnce()
  })

  describe('a request to an action with an earlier unresolved outcome', () => {
    /** Start one script in a Session whose only step submits a `capture` request. */
    async function started(f: Awaited<ReturnType<typeof fixture>>, session: string, body: string, action = 'capture') {
      const issued = await f.client.propose(proposal(session))
      f.run.mockImplementationOnce(async (_session, _command, signal, submit) => {
        if (submit === undefined) throw new Error('Expected a live business capability')
        await submit({ requestKey: randomUUID(), action, body }, signal)
        return observation
      })
      return { waiting: f.client.waitReview(issued.id), execution: f.client.execute(issued.id) }
    }

    /** Run that script and return its review, or undefined when the request was sent without one. */
    async function submitted(f: Awaited<ReturnType<typeof fixture>>, session: string, body: string, action = 'capture') {
      const { waiting, execution } = await started(f, session, body, action)
      return { review: await waiting, execution }
    }

    it('holds a changed allowed field across Sessions while leaving a different action unattended', async (test) => {
      const changedBody = '{"account":"A1","amount":6}'
      const f = await fixture(test)
      const broker = brokerFixture(reconciliationEndpoint)
      broker.run.mockRejectedValueOnce(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
      await f.startWitness()
      await f.startAuthority({ maxOperations: 16 }, {
        approvalSocketPath: f.approvalSocketPath, unattendedShell: true, broker,
        unattendedActions: [{ action: 'capture', match: { account: 'A1' }, allow: ['amount'] }, { action: 'refund' }],
      })
      const first = await submitted(f, 'worker-1', '{"account":"A1","amount":5}')
      expect(first.review).toBeUndefined()
      await first.execution
      const [lost] = (await f.client.businessOperations(SessionId('worker-1'))).operations
      expect(lost).toMatchObject({ state: 'unknown', approval: 'unattended' })
      if (lost === undefined) throw new Error('Expected the lost request')
      const repeat = await submitted(f, 'worker-2', changedBody)
      expect(repeat.review).toMatchObject({ state: 'pending-approval', review: { business: { body: changedBody }, repeats: lost.id } })
      if (repeat.review === undefined) throw new Error('Expected a review')
      await f.approver.decide(decisionFor(repeat.review, 'deny'))
      await repeat.execution
      const other = await submitted(f, 'worker-2', changedBody, 'refund')
      expect(other.review).toBeUndefined()
      await other.execution
      expect(broker.run).toHaveBeenCalledTimes(2)
      broker.reconcile.mockResolvedValueOnce({ kind: 'failed', receiptId: brandString<BrokerReceiptId>('capture-refused') })
      expect(await f.client.reconcile(SessionId('worker-1'), lost.id)).toMatchObject({ businessCompletion: { kind: 'failed' } })
      const resent = await submitted(f, 'worker-2', changedBody)
      expect(resent.review).toBeUndefined()
      expect(await resent.execution).toMatchObject({ state: 'settled' })
      expect(broker.run).toHaveBeenCalledTimes(3)
    })

    it.for(['succeeded', 'failed'] as const)('witnesses the owner determination %s before releasing the action hold', async (kind, test) => {
      const f = await fixture(test)
      const broker = brokerFixture()
      broker.run.mockRejectedValueOnce(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
      await f.startWitness()
      const options = { approvalSocketPath: f.approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture' }] }
      const authority = await f.startAuthority({ maxOperations: 16 }, options)
      await (await submitted(f, 'worker-1', '{"amount":5}')).execution
      const lost = (await f.approver.businessRecords()).records[0]!
      const resolution = { id: lost.id, kind }
      await expect(f.client.resolveBusiness(resolution)).rejects.toMatchObject({ code: 'approval-forbidden' })
      const append = f.evidence.append.bind(f.evidence)
      const entered = Promise.withResolvers<Witness.EvidenceEvent>()
      const release = Promise.withResolvers<undefined>()
      test.onTestFinished(() => { release.resolve(undefined) })
      const witness = vi.spyOn(f.evidence, 'append').mockImplementationOnce(async (event) => {
        entered.resolve(event)
        await release.promise
        return append(event)
      })
      const resolving = f.approver.resolveBusiness(resolution)
      const event = await entered.promise
      expect(event).toMatchObject({ operationId: lost.id, kind: 'outcome', body: { fact: 'business-reconciliation', kind, source: 'owner' } })
      expect((await f.approver.businessRecords()).records[0]?.businessCompletion.kind).toBe('unconfirmed')
      const held = await submitted(f, 'worker-2', '{"amount":6}')
      expect(held.review).toMatchObject({ review: { repeats: lost.id } })
      await f.approver.decide(decisionFor(held.review!, 'deny'))
      await held.execution
      release.resolve(undefined)
      const result = await resolving
      expect(result).toMatchObject({ state: 'unknown', canReconcile: false, businessCompletion: { kind, source: 'owner' } })
      expect(result.businessCompletion).not.toHaveProperty('receiptId')
      expect(await f.client.overview(lost.sessionId)).toMatchObject({ unknown: 0, businessCompletion: { [kind]: 1, unconfirmed: 0 } })
      expect(await f.evidence.get(result.businessCompletion.receipt!.id))
        .toMatchObject({ event, receipt: result.businessCompletion.receipt })
      expect(broker.reconcile).not.toHaveBeenCalled()
      const attempts = witness.mock.calls.filter(([event]) => event.operationId === lost.id)
      expect(attempts).toHaveLength(1)
      await expect(f.approver.resolveBusiness({ id: lost.id, kind: kind === 'succeeded' ? 'failed' : 'succeeded' }))
        .rejects.toMatchObject({ code: 'broker-reconciliation-unavailable' })
      expect(await verifyRecords(f.approver, f.evidence)).toMatchObject({ problems: [] })
      await authority.close()
      await f.startAuthority({ maxOperations: 16 }, options)
      expect((await f.approver.businessRecords()).records.find(({ id }) => id === lost.id)?.businessCompletion)
        .toEqual(result.businessCompletion)
      const released = await submitted(f, 'worker-2', '{"amount":7}')
      expect(released.review).toBeUndefined()
      await released.execution
      expect(broker.run).toHaveBeenCalledTimes(2)
    })

    it('keeps the hold without witness confirmation and refuses an owner determination after a confirmed lookup', async (test) => {
      const f = await fixture(test)
      const broker = brokerFixture(reconciliationEndpoint)
      broker.run.mockRejectedValueOnce(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
      await f.startWitness()
      await f.startAuthority({ maxOperations: 16 }, {
        approvalSocketPath: f.approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture' }],
      })
      await (await submitted(f, 'worker-1', '{}')).execution
      const lost = (await f.approver.businessRecords()).records[0]!
      vi.spyOn(f.evidence, 'append').mockRejectedValueOnce(new Witness.EvidenceError('unavailable', 'The witness is stopped'))
      expect(await f.approver.resolveBusiness({ id: lost.id, kind: 'failed' })).toMatchObject({
        businessCompletion: { kind: 'unconfirmed', code: 'reconciliation-evidence-unavailable' },
      })
      const held = await submitted(f, 'worker-2', '{"amount":6}')
      expect(held.review).toMatchObject({ review: { repeats: lost.id } })
      await f.approver.decide(decisionFor(held.review!, 'deny'))
      await held.execution
      await expect(f.approver.resolveBusiness({ id: held.review!.id, kind: 'failed' }))
        .rejects.toMatchObject({ code: 'broker-reconciliation-unavailable' })
      // Finish witnessing the retained owner observation, as a lookup retries any retained observation.
      expect(await f.client.reconcile(lost.sessionId, lost.id)).toMatchObject({ businessCompletion: { kind: 'failed', source: 'owner' } })
      const released = await submitted(f, 'worker-2', '{"amount":7}')
      expect(released.review).toBeUndefined()
      await released.execution
      const dispatched = (await f.approver.businessRecords()).records[0]!
      broker.reconcile.mockResolvedValueOnce({ kind: 'succeeded', receiptId: brandString<BrokerReceiptId>('capture-done') })
      await f.client.reconcile(dispatched.sessionId, dispatched.id)
      await expect(f.approver.resolveBusiness({ id: dispatched.id, kind: 'failed' }))
        .rejects.toMatchObject({ code: 'broker-reconciliation-unavailable' })
      expect(await verifyRecords(f.approver, f.evidence)).toMatchObject({ problems: [] })
    })

    it('admits only the first of two concurrent identical requests under a rule', async (test) => {
      const f = await fixture(test)
      const broker = brokerFixture()
      const response = Promise.withResolvers<never>()
      broker.run.mockReturnValueOnce(response.promise)
      await f.startWitness()
      await f.startAuthority({ maxOperations: 8 }, { approvalSocketPath: f.approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture' }] })
      const body = '{"account":"A1"}'
      const [one, two] = await Promise.all([started(f, 'worker-1', body), started(f, 'worker-2', body)])
      const review = await Promise.race([one.waiting, two.waiting])
      await vi.waitFor(() => { expect(broker.run).toHaveBeenCalledOnce() })
      const sent = broker.run.mock.calls[0]?.[1].operationId
      expect(review).toMatchObject({ review: { repeats: sent } })
      response.reject(new BrokerError('broker-response-unavailable', 'unknown', 'The response was lost.'))
      if (review === undefined) throw new Error('Expected a review')
      await f.approver.decide(decisionFor(review, 'deny'))
      await Promise.all([one.execution, two.execution])
      expect(broker.run).toHaveBeenCalledOnce()
      expect(await f.client.status(operationIdSchema.parse(sent))).toMatchObject({ state: 'unknown' })
    })

    it('names an earlier approved request that received a response without confirmed completion', async (test) => {
      const f = await fixture(test)
      const broker = brokerFixture()
      await f.startWitness()
      await f.startAuthority({ maxOperations: 8 }, { approvalSocketPath: f.approvalSocketPath, unattendedShell: true, broker })
      const body = '{"account":"A1"}'
      const first = await submitted(f, 'worker-1', body)
      expect(first.review).not.toHaveProperty('review.repeats')
      if (first.review === undefined) throw new Error('Expected a review')
      await f.approver.decide(decisionFor(first.review, 'approve'))
      await first.execution
      const second = await submitted(f, 'worker-1', body)
      expect(second.review).toMatchObject({ review: { repeats: first.review.id } })
      if (second.review === undefined) throw new Error('Expected a review')
      await f.approver.decide(decisionFor(second.review, 'deny'))
      await second.execution
    })
  })

  it('records a tool request by its tool name and reports the tool error flag instead of an HTTP status', async (test) => {
    const { client, evidence, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    broker.resolve.mockImplementation((action, body) => ({
      action: brokerActionId(action), method: 'POST', endpoint: 'https://example.test/mcp', tool: 'post_note', body,
      credentialRef: brandString<PreparedBrokerRequest['credentialRef']>('DSH_FIXTURE_TOKEN'),
    }))
    broker.run.mockResolvedValue({ kind: 'tool-result', isError: true, body: 'note refused' })
    await startWitness()
    const options = { approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture' }] }
    const authority = await startAuthority({ maxOperations: 8 }, options)
    const issued = await client.propose(proposal())
    let reply: unknown
    run.mockImplementationOnce(async (_session, _command, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live business capability')
      reply = await submit({ requestKey: randomUUID(), action: 'capture', body: '{"text":"hello"}' }, signal)
      return observation
    })
    expect(await client.execute(issued.id)).toMatchObject({ state: 'settled' })
    expect(reply).toMatchObject({ toolError: true, body: 'note refused' })
    expect(reply).not.toHaveProperty('status')
    const id = operationIdSchema.parse((reply as { id?: unknown }).id)
    const settled = await client.status(id)
    expect(settled.outcome).toEqual({
      kind: 'business-response', toolError: true, responseDigest: createHash('sha256').update('note refused').digest('hex'),
    })
    expect(broker.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tool: 'post_note', endpoint: 'https://example.test/mcp' }), expect.anything(), expect.any(AbortSignal),
    )
    expect(await evidence.get(settled.admission!.id)).toMatchObject({ event: { body: { tool: 'post_note', endpoint: 'https://example.test/mcp' } } })
    expect(await evidence.get(settled.receipt!.id)).toMatchObject({ event: { body: { kind: 'business-response', toolError: true } } })
    await authority.close()
    await startAuthority({ maxOperations: 8 }, options)
    expect(await client.status(id)).toEqual(settled)
  })

  it('passes returned response text to the waiting script without retaining it', async (test) => {
    const { client, approver, approvalSocketPath, databasePath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    await startWitness()
    const authority = await startAuthority({ maxOperations: 16 }, {
      approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture' }],
    })
    const replies: unknown[] = []
    for (const [index, observed] of [{ body: '{"ok":false,"private":"response text"}' }, { bodyOmitted: 'too-large' as const }, {}].entries()) {
      broker.run.mockResolvedValueOnce({ kind: 'http-response', statusCode: 200, ...observed })
      const issued = await client.propose(proposal())
      run.mockImplementationOnce(async (_session, _command, signal, submit) => {
        if (submit === undefined) throw new Error('Expected a live business capability')
        replies.push(await submit({ requestKey: randomUUID(), action: 'capture', body: `{"n":${index}}` }, signal))
        return observation
      })
      const waiting = client.waitReview(issued.id)
      const execution = client.execute(issued.id)
      const pending = await waiting
      if (pending !== undefined) await approver.decide(decisionFor(pending, 'approve'))
      expect(await execution).toMatchObject({ state: 'settled' })
    }
    expect(replies).toMatchObject([
      { status: 200, body: '{"ok":false,"private":"response text"}' }, { status: 200, bodyOmitted: 'too-large' }, { status: 200 },
    ])
    expect(replies[2]).not.toHaveProperty('body')
    expect(replies[2]).not.toHaveProperty('bodyOmitted')
    const outcomes = await Promise.all(replies.map(async reply =>
      (await client.status(operationIdSchema.parse((reply as { id?: unknown }).id))).outcome))
    expect(outcomes).toEqual([
      {
        kind: 'business-response', statusCode: 200,
        responseDigest: createHash('sha256').update('{"ok":false,"private":"response text"}').digest('hex'),
      },
      { kind: 'business-response', statusCode: 200, responseOmitted: 'too-large' },
      { kind: 'business-response', statusCode: 200 },
    ])
    await authority.close()
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      expect(JSON.stringify(db.prepare('SELECT record FROM operations').all())).not.toContain('response text')
    } finally {
      db.close()
    }
  })

  it('matches unattended rules only on exact top-level fields of compact JSON objects', () => {
    const rules = [{ action: 'post', match: { channel: 'C1' }, allow: ['text'] }, { action: 'ping' }]
    expect(isUnattended(rules, { action: brokerActionId('ping'), body: '[1, 2]' })).toBe(true)
    expect(isUnattended(rules, { action: brokerActionId('post'), body: '{"channel":"C1","text":"hello"}' })).toBe(true)
    for (const body of [
      '{"channel":"C2"}', '{"text":"hello"}', '{"channel":"C2","channel":"C1"}', '{"channel": "C1"}',
      '["C1"]', '"C1"', 'null', '{"nested":{"channel":"C1"}}', '{"channel":["C1"]}',
    ]) {
      expect(isUnattended(rules, { action: brokerActionId('post'), body })).toBe(false)
    }
    expect(isUnattended(rules, { action: brokerActionId('other'), body: '{"channel":"C1"}' })).toBe(false)
    expect(isUnattended([], { action: brokerActionId('ping'), body: '{}' })).toBe(false)
    const allowed = [{ action: 'post', match: { channel: 'C1' }, allow: ['text'] }, { action: 'ping', allow: [] }]
    for (const body of ['{"channel":"C1"}', '{"channel":"C1","text":"hello"}']) {
      expect(isUnattended(allowed, { action: brokerActionId('post'), body })).toBe(true)
    }
    expect(isUnattended(allowed, { action: brokerActionId('ping'), body: '{}' })).toBe(true)
    for (const [action, body] of [['post', '{"channel":"C1","bcc":"x"}'], ['post', '{"text":"hello"}'], ['ping', '{"x":1}'], ['ping', '[]']] as const) {
      expect(isUnattended(allowed, { action: brokerActionId(action), body })).toBe(false)
    }
    const numeric = [{ action: 'post', match: { recipientId: 9007199254740992 }, allow: [] }]
    const action = brokerActionId('post')
    expect(isUnattended(numeric, { action, body: '{"recipientId":9007199254740993}' })).toBe(false)
    expect(isUnattended(numeric, { action, body: '{"recipientId":9007199254740992}' })).toBe(true)
  })

  it('rejects approval on an expired or superseded grant and refuses legacy unapproved permits', async (test) => {
    const { client, approver, approvalSocketPath, databasePath, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    const legacy = await startAuthority()
    const issued = await client.propose(proposal())
    await legacy.close()
    const authority = await startAuthority({}, { approvalSocketPath })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'approval-required' })
    const pending = await client.propose(proposal())
    await authority.close()
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("UPDATE operations SET record = json_set(record, '$.expiresAt', 1) WHERE id = ?").run(pending.id)
    } finally {
      db.close()
    }
    const expired = await startAuthority({}, { approvalSocketPath })
    await expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'grant-expired' })
    await expired.close()
    await startAuthority({ fingerprint: '2'.repeat(64) }, { approvalSocketPath })
    await expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'revision-mismatch' })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects alternate model routes and charges accepted model and shell operations to the same grant', async (test) => {
    const { client, evidence, socketPath, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const run = vi.fn<NonNullable<AuthorityOptions['model']>['run']>().mockResolvedValue(modelResponse)
    await startAuthority({}, { model: { provider: modelInput.provider, id: modelInput.model, run } })
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    const direct = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    class DirectAdapter extends LlmAdapter { override stream = direct }
    ctx.llm.registerAdapter(['direct'], new DirectAdapter())
    await ctx.plugin(ModelAgent, { socketPath, provider: modelInput.provider, model: modelInput.model })
    const sessionId = SessionId('worker-model')
    const input = { ...modelInput, sessionId }
    await expect(collect(ctx.llm.stream({ ...input, provider: 'direct' }))).resolves.toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_ROUTE_DENIED' } } },
    ])
    expect(direct).not.toHaveBeenCalled()
    await expect(client.propose({
      requestKey: randomUUID(), sessionId,
      modelRequest: { ...input, model: 'forbidden' },
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(client.propose({
      requestKey: randomUUID(), sessionId,
      modelRequest: { ...modelInput, model: 'forbidden' },
    })).rejects.toMatchObject({ code: 'model-denied' })
    await expect(client.propose({
      requestKey: randomUUID(), sessionId,
      modelRequest: { ...modelInput, provider: 'another-provider' },
    })).rejects.toMatchObject({ code: 'model-denied' })
    await expect(collect(ctx.llm.stream({ ...input, maxTokens: 5 }))).resolves.toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_OPTION' } } },
    ])
    expect(run).not.toHaveBeenCalled()
    await expect(collect(ctx.llm.stream(input))).resolves.toEqual(modelResponse)
    expect(run).toHaveBeenCalledExactlyOnceWith(sessionId, modelInput, expect.any(AbortSignal))
    expect(ctx.llm.providerRetryPolicy(modelInput.provider)).toMatchObject({ maxRetries: 0 })
    const shell = await client.propose(proposal('another-session'))
    expect(shell.state).toBe('issued')
    await expect(client.propose(proposal('third-session'))).rejects.toMatchObject({ code: 'budget-exhausted' })
    expect(await evidence.get(shell.admission!.id)).toMatchObject({ event: { body: { sessionId: 'another-session' } } })
  })

  it('explains that a model request was not sent while its admission awaits the witness', async (test) => {
    const { socketPath, startWitness, startAuthority } = await fixture(test)
    const stopWitness = await startWitness()
    const run = vi.fn<NonNullable<AuthorityOptions['model']>['run']>().mockResolvedValue(modelResponse)
    await startAuthority({}, { model: { provider: modelInput.provider, id: modelInput.model, run } })
    await stopWitness()
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ModelAgent, { socketPath, provider: modelInput.provider, model: modelInput.model })
    const chunks = await collect(ctx.llm.stream({ ...modelInput, sessionId: SessionId('worker-model') }))
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: {
      code: 'MODEL_NOT_ISSUED',
    } } }])
    expect(JSON.stringify(chunks)).toContain('The witness service is not confirming records.')
    expect(JSON.stringify(chunks)).toContain("This operation did not run or send anything. Check Vardock's services with pnpm vardock doctor.")
    expect(run).not.toHaveBeenCalled()
  })

  it('withholds model output until a witness receipt and recovers it without another sample', async (test) => {
    const { client, evidence, startWitness, startAuthority } = await fixture(test)
    const closeWitness = await startWitness()
    const run = vi.fn<NonNullable<AuthorityOptions['model']>['run']>().mockResolvedValue(modelResponse)
    const authority = await startAuthority({}, { model: { provider: modelInput.provider, id: modelInput.model, run } })
    const input = {
      requestKey: randomUUID(), sessionId: SessionId('worker-model'),
      modelRequest: modelInput,
    }
    const issued = await client.propose(input)
    const requestDigest = createHash('sha256').update(JSON.stringify(input.modelRequest)).digest('hex')
    expect(await evidence.get(issued.admission!.id)).toMatchObject({
      event: { body: { provider: modelInput.provider, model: modelInput.model, requestDigest } },
    })
    await closeWitness()
    const pending = await client.execute(issued.id)
    expect(pending.state).toBe('pending-outcome-evidence')
    expect(pending.outcome).toBeUndefined()
    expect(await client.status(issued.id)).toEqual(pending)
    expect(await client.propose(input)).toEqual(pending)
    await authority.close()
    await startWitness()
    await startAuthority({}, { model: { provider: modelInput.provider, id: modelInput.model, run } })
    const settled = await client.status(issued.id)
    expect(settled).toMatchObject({ state: 'settled', outcome: { kind: 'model-response', chunks: modelResponse } })
    const responseDigest = createHash('sha256').update(JSON.stringify(modelResponse)).digest('hex')
    expect(await evidence.get(settled.receipt!.id)).toMatchObject({
      receipt: settled.receipt,
      event: { body: { responseDigest, usage: { totalTokens: 3 } } },
    })
    expect(await client.execute(issued.id)).toEqual(settled)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('admits Assistant handoffs only from the configured main Session and for their assigned target role', async (test) => {
    const { client, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const shellOnly = await startAuthority()
    const input = handoffProposal()
    await expect(client.propose(input)).rejects.toMatchObject({ code: 'handoff-denied' })
    await shellOnly.close()
    await startAuthority({ maxOperations: 1 }, { assistant })
    await expect(client.propose({ ...input, sessionId: SessionId('worker-1') })).rejects.toMatchObject({ code: 'handoff-denied' })
    await expect(client.propose({
      ...input, handoff: { ...input.handoff, targetSessionId: assistant.mainSessionId },
    })).rejects.toMatchObject({ code: 'handoff-denied' })
    await expect(client.propose({
      ...input, handoff: { ...input.handoff, kind: 'delivery' },
    })).rejects.toMatchObject({ code: 'handoff-denied' })
    const delivery = await client.propose({
      ...input, handoff: { kind: 'delivery', targetSessionId: assistant.mainSessionId, content: input.handoff.content },
    })
    await expect(client.execute(delivery.id)).resolves.toMatchObject({
      state: 'settled', outcome: { kind: 'released', handoffKind: 'delivery', targetSessionId: assistant.mainSessionId },
    })
  })

  it('requires a witnessed worker grant before a Session can execute or use the model route', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    const model = { provider: modelInput.provider, id: modelInput.model, run: vi.fn().mockResolvedValue(modelResponse) }
    await startAuthority({ maxOperations: 2 }, { assistant, approvalSocketPath, model })
    const shell = proposal()
    const workerModel = { requestKey: randomUUID(), sessionId: shell.sessionId, modelRequest: modelInput }
    await expect(client.propose(proposal(assistant.mainSessionId))).rejects.toMatchObject({ code: 'work-not-authorized' })
    await expect(client.propose(shell)).rejects.toMatchObject({ code: 'work-not-authorized' })
    await expect(client.propose(workerModel)).rejects.toMatchObject({ code: 'work-not-authorized' })
    const input = handoffProposal({
      ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions: { exec: false, brokerActions: [] } },
    })
    const issued = await client.propose(input)
    await expect(client.propose(shell)).rejects.toMatchObject({ code: 'work-not-authorized' })
    await expect(client.execute(issued.id)).resolves.toMatchObject({
      state: 'settled', outcome: { work: { workId: handoffRequest.delegation.workId, permissions: { exec: false, brokerActions: [] } } },
    })
    await expect(client.propose(shell)).rejects.toMatchObject({ code: 'work-permission-denied' })
    await expect(approver.decide({
      id: operationIdSchema.parse(randomUUID()), revision: 'a'.repeat(64), payloadDigest: 'b'.repeat(64), decision: 'approve',
    })).rejects.toMatchObject({ code: 'not-found' })
    const modelCall = await client.propose(workerModel)
    await expect(client.execute(modelCall.id)).resolves.toMatchObject({ state: 'settled', outcome: { kind: 'model-response' } })
    expect(run).not.toHaveBeenCalled()
  })

  it('transfers only the granted owner input and witnesses metadata without retaining bytes in evidence', async (test) => {
    const { client, startWitness, startAuthority, evidence } = await fixture(test)
    const data = Buffer.alloc(300_000, 'owner bytes')
    const { source, transferRun, delegation, importFile, exportFile, options } = fileFixture(data)
    await startWitness()
    await startAuthority({ maxOperations: 3 }, options)
    await expect(client.transferFile(importFile)).rejects.toMatchObject({ code: 'work-not-authorized' })
    await expect(client.execute((await client.propose(delegation)).id)).resolves.toMatchObject({
      state: 'settled', outcome: { work: { inputs: [source], permissions: filePermissions } },
    })
    const { file } = importFile
    if (file.kind !== 'import') throw new Error('Expected an import fixture')
    await expect(client.transferFile({
      ...importFile, file: { ...file, source: { ...source, messageSeq: 2 } },
    })).rejects.toMatchObject({ code: 'work-input-denied' })
    await expect(client.transferFile({
      ...importFile, file: { ...file, contentBase64: Buffer.alloc(data.length).toString('base64') },
    })).rejects.toMatchObject({ code: 'bad-request' })
    const imported = await client.transferFile(importFile)
    expect(imported.outcome).toEqual({
      kind: 'file-imported', workId: file.workId, source, path: workInputPath(source), digest: source.attachmentId, bytes: source.bytes,
    })
    expect(transferRun).toHaveBeenCalledExactlyOnceWith(importFile.sessionId, {
      kind: 'import', data, path: workInputPath(source), maxBytes: DEFAULT_MAX_FILE_BYTES,
    }, expect.any(AbortSignal))
    await expect(client.transferFile(importFile)).resolves.toEqual(imported)
    expect(transferRun).toHaveBeenCalledTimes(1)
    expect((await evidence.get(imported.receipt.id))?.event.body).toEqual(imported.outcome)
    const { file: exportRequest } = exportFile
    if (exportRequest.kind !== 'export') throw new Error('Expected an export fixture')
    await expect(client.transferFile({
      ...exportFile, file: { ...exportRequest, targetSessionId: SessionId('another-recipient') },
    })).rejects.toMatchObject({ code: 'work-recipient-denied' })
    const exported = await client.transferFile(exportFile)
    expect(exported.outcome).toEqual({
      kind: 'file-exported', workId: file.workId, path: exportRequest.path,
      targetSessionId: assistant.mainSessionId, digest: source.attachmentId, bytes: source.bytes,
    })
    expect((await evidence.get(exported.receipt.id))?.event.body).toEqual(exported.outcome)
    expect((await client.status(exported.operationId)).outcome).toEqual(exported.outcome)
    await expect(client.readExportedFile(exported.operationId)).resolves.toEqual({ ...exported, contentBase64: data.toString('base64') })
  })

  it('recovers a retained export snapshot after restart without reading the workspace again', async (test) => {
    const { client, startWitness, startAuthority } = await fixture(test)
    const data = Buffer.from('original snapshot')
    const { transferRun, delegation, exportFile, options } = fileFixture(data)
    const closeWitness = await startWitness()
    const authority = await startAuthority({ maxOperations: 2 }, options)
    await client.execute((await client.propose(delegation)).id)
    const issued = await client.propose(exportFile)
    await closeWitness()
    await expect(client.execute(issued.id)).resolves.toMatchObject({ state: 'pending-outcome-evidence' })
    await expect(client.status(issued.id)).resolves.not.toHaveProperty('outcome')
    await expect(client.readExportedFile(issued.id)).rejects.toMatchObject({ code: 'file-not-settled' })
    await authority.close()
    await startWitness()
    await startAuthority({ maxOperations: 2 }, options)
    const snapshot = await client.readExportedFile(issued.id)
    expect(Buffer.from(snapshot.contentBase64, 'base64')).toEqual(data)
    expect(transferRun).toHaveBeenCalledTimes(1)
  })

  it('blocks a continuation that redefines inputs and denies release and report disclosure after disclosure is revoked', async (test) => {
    const { client, startWitness, startAuthority, run } = await fixture(test)
    const { source, delegation, importFile, exportFile, options } = fileFixture(Buffer.from('owner bytes'))
    const { handoff } = delegation
    if (handoff.delegation === undefined) throw new Error('Expected a delegation fixture')
    await startWitness()
    const authority = await startAuthority({ maxOperations: 5 }, options)
    await client.execute((await client.propose(delegation)).id)
    const workId = handoff.delegation.workId
    const sessionId = handoff.targetSessionId
    expect(await client.overview(sessionId, undefined, workId)).toMatchObject({ disclosesImportedData: true })
    await client.transferFile(importFile)
    const exported = await client.transferFile(exportFile)
    const command = await client.propose(proposal())
    await client.execute(command.id)
    expect(await client.overview(sessionId, undefined, workId)).toMatchObject({ disclosesImportedData: true })
    const next = {
      ...handoff.delegation, workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: handoff.delegation.workId,
    }
    await expect(client.propose({
      ...delegation, requestKey: '5'.repeat(64), handoff: { ...handoff, delegation: { ...next, inputs: [{ ...source, contentIndex: 1 }] } },
    })).rejects.toMatchObject({ code: 'work-input-conflict' })
    const data = { import: true, export: true, discloseToModel: false, discloseToUser: true }
    const permissions = { ...filePermissions, data }
    await expect(client.propose({
      ...delegation, requestKey: '5'.repeat(64), handoff: { ...handoff, delegation: { ...next, permissions } },
    })).rejects.toMatchObject({ code: 'work-disclosure-denied' })
    await authority.close()
    const narrowed = await startAuthority({ maxOperations: 5, fingerprint: '2'.repeat(64) }, { ...options, assistant: { ...assistant, permissions } })
    await expect(client.propose(proposal())).rejects.toMatchObject({ code: 'work-disclosure-denied' })
    await expect(client.status(command.id)).rejects.toMatchObject({ code: 'work-disclosure-denied' })
    await expect(client.readExportedFile(exported.operationId)).rejects.toMatchObject({ code: 'work-disclosure-denied' })
    expect(await client.overview(sessionId, undefined, workId)).toMatchObject({ disclosesImportedData: false })
    expect(await client.overview(SessionId('worker-without-files'))).toMatchObject({ disclosesImportedData: true })
    await narrowed.close()
    await startAuthority({ maxOperations: 5, fingerprint: '3'.repeat(64) }, options)
    expect(await client.overview(sessionId, undefined, workId)).toMatchObject({ disclosesImportedData: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('requires permissions for fresh work and keeps a continuation without them at its predecessor grant', async (test) => {
    const { client, approvalSocketPath, startWitness, startAuthority, evidence } = await fixture(test)
    const data = { import: false, export: false, discloseToModel: false, discloseToUser: false }
    await startWitness()
    await startAuthority({ maxOperations: 8 }, {
      assistant: { ...assistant, permissions: { exec: true, brokerActions: ['capture', 'update'], data: { ...data, returnResponses: true } } },
      approvalSocketPath,
    })
    await expect(client.propose(handoffProposal({
      ...handoffRequest, delegation: { workId: handoffRequest.delegation.workId, previousWorkId: null },
    }))).rejects.toMatchObject({ code: 'work-permission-required' })
    await expect(client.propose(handoffProposal({
      ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions: { exec: true, brokerActions: ['refund'] } },
    }))).rejects.toMatchObject({ code: 'work-permission-denied' })
    const permissions: WorkPermissions = { exec: true, brokerActions: ['capture'], data: { ...data, returnResponses: false } }
    const first = await client.propose(handoffProposal({ ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions } }))
    await expect(client.execute(first.id)).resolves.toMatchObject({ state: 'settled', outcome: { work: { permissions } } })
    expect(await evidence.get(`${first.id}-admission`)).toMatchObject({ event: { body: { permissions } } })
    const continuation = (key: string, workId: string, previousWorkId: string, requested?: WorkPermissions) => handoffProposal({
      ...handoffRequest, key, delegation: {
        workId: workIdSchema.parse(workId), previousWorkId: workIdSchema.parse(previousWorkId),
        ...(requested === undefined ? {} : { permissions: requested }),
      },
    })
    const kept = await client.propose(continuation('keep', '2'.repeat(64), '1'.repeat(64)))
    await expect(client.execute(kept.id)).resolves.toMatchObject({ state: 'settled' })
    expect((await client.status(kept.id)).outcome).toMatchObject({ work: { permissions } })
    expect(await evidence.get(`${kept.id}-admission`)).toMatchObject({ event: { body: { permissions } } })
    await expect(client.propose(continuation('widen', '3'.repeat(64), '2'.repeat(64), {
      ...permissions, data: { ...data, returnResponses: true },
    }))).rejects.toMatchObject({ code: 'work-permission-denied' })
  })

  it('returns response text only to work whose grant allows returnResponses', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run, evidence } = await fixture(test)
    const broker = brokerFixture()
    const data = { import: false, export: false, discloseToModel: false, discloseToUser: false }
    const options = {
      assistant: { ...assistant, permissions: { exec: true, brokerActions: ['capture'], data: { ...data, returnResponses: true } } },
      approvalSocketPath, unattendedShell: true, broker, unattendedActions: [{ action: 'capture' }],
    }
    await startWitness()
    let authority = await startAuthority({ maxOperations: 16 }, options)
    const delegate = async (session: string, digit: string, granted: NonNullable<WorkPermissions['data']>) => {
      const permissions: WorkPermissions = { exec: true, brokerActions: ['capture'], data: granted }
      const issued = await client.propose(handoffProposal({
        ...handoffRequest, key: session, targetSessionId: SessionId(session),
        delegation: { workId: workIdSchema.parse(digit.repeat(64)), previousWorkId: null, permissions },
      }))
      await expect(client.execute(issued.id)).resolves.toMatchObject({ state: 'settled', outcome: { work: { permissions } } })
      expect(await evidence.get(`${issued.id}-admission`)).toMatchObject({ event: { body: { permissions } } })
    }
    const submit = async (session: string, body: string, observed: { body?: string }) => {
      broker.run.mockResolvedValueOnce({ kind: 'http-response', statusCode: 200, ...observed })
      const reply = Promise.withResolvers<{ id?: unknown }>()
      run.mockImplementationOnce(async (_session, _command, signal, request) => {
        if (request === undefined) throw new Error('Expected a live business capability')
        reply.resolve(await request({ requestKey: randomUUID(), action: 'capture', body }, signal) as { id?: unknown })
        return observation
      })
      const issued = await client.propose(proposal(session))
      const waiting = client.waitReview(issued.id)
      const execution = client.execute(issued.id)
      const pending = await waiting
      if (pending !== undefined) await approver.decide(decisionFor(pending, 'approve'))
      expect(await execution).toMatchObject({ state: 'settled' })
      const value = await reply.promise
      const status = await client.status(operationIdSchema.parse(value.id))
      if (status.receipt === undefined) throw new Error('Expected a witnessed business response')
      expect(await evidence.get(status.receipt.id)).toMatchObject({ event: { body: status.outcome } })
      return { reply: value, outcome: status.outcome }
    }
    const text = '{"customer":"private response text"}'
    await delegate('worker-1', '1', { ...data, returnResponses: true })
    await delegate('worker-2', '2', { ...data, returnResponses: false })
    // A grant recorded before returnResponses existed has no such field.
    await delegate('worker-3', '3', data)

    const allowed = await submit('worker-1', '{"n":1}', { body: text })
    expect(allowed.reply).toMatchObject({ status: 200, body: text })
    expect(allowed.outcome).toEqual({ kind: 'business-response', statusCode: 200, responseDigest: createHash('sha256').update(text).digest('hex') })
    const withheld = await submit('worker-2', '{"n":2}', { body: text })
    expect(withheld.reply).toMatchObject({ status: 200, bodyOmitted: 'not-permitted' })
    expect(withheld.reply).not.toHaveProperty('body')
    expect(withheld.outcome).toEqual({ kind: 'business-response', statusCode: 200, responseOmitted: 'not-permitted' })
    const notReturned = await submit('worker-1', '{"n":3}', {})
    expect(notReturned.reply).not.toHaveProperty('body')
    expect(notReturned.reply).not.toHaveProperty('bodyOmitted')
    expect(broker.run).toHaveBeenCalledTimes(3)

    await authority.close()
    authority = await startAuthority({ maxOperations: 16 }, options)
    expect((await submit('worker-3', '{"n":4}', { body: text })).reply).toMatchObject({ status: 200, bodyOmitted: 'not-permitted' })
    await authority.close()
    const narrowed = { ...assistant, permissions: { ...options.assistant.permissions, data } }
    await startAuthority({ maxOperations: 16 }, { ...options, assistant: narrowed })
    expect((await submit('worker-1', '{"n":5}', { body: text })).reply).toMatchObject({ status: 200, bodyOmitted: 'not-permitted' })
  })

  it('refuses out-of-grant broker actions before resolution, reservation, or approval', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run, evidence, grant } = await fixture(test)
    const broker = brokerFixture()
    const permissions: WorkPermissions = { exec: true, brokerActions: ['capture'] }
    await startWitness()
    await startAuthority({ maxOperations: 3 }, {
      assistant: { ...assistant, permissions: { exec: true, brokerActions: ['capture', 'update'] } }, approvalSocketPath, broker,
    })
    const input = handoffProposal({ ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions } })
    const delegation = await client.propose(input)
    await expect(client.execute(delegation.id)).resolves.toMatchObject({ state: 'settled', outcome: { work: { permissions } } })
    const denied = Promise.withResolvers<unknown>()
    const requestKey = randomUUID()
    run.mockImplementationOnce(async (_session, _script, signal, submit) => {
      if (submit === undefined) throw new Error('Expected the worker to receive a broker capability')
      denied.resolve(await submit({ requestKey: randomUUID(), action: 'update', body: '{}' }, signal))
      await submit({ requestKey, action: 'capture', body: '{}' }, signal)
      return observation
    })
    const workId = handoffRequest.delegation.workId
    const parent = await client.propose(proposal())
    expect(parent.review).toMatchObject({ workId, principalId: grant.principalId })
    await approver.decide(decisionFor(parent, 'approve'))
    const execution = client.execute(parent.id)
    await expect(denied.promise).resolves.toMatchObject({ code: 'work-permission-denied' })
    const review = await client.waitReview(parent.id)
    if (review === undefined) throw new Error('The allowed action must reach review')
    expect(review.review).toMatchObject({ workId, principalId: grant.principalId, business: { action: 'capture' } })
    await approver.decide(decisionFor(review, 'approve'))
    await expect(execution).resolves.toMatchObject({ state: 'settled' })
    expect(broker.resolve).toHaveBeenCalledExactlyOnceWith('capture', '{}', { parentId: parent.id, requestKey })
    expect(broker.run).toHaveBeenCalledTimes(1)
    expect(await evidence.get(`${review.id}-admission`)).toMatchObject({
      event: { body: { workId, principalId: grant.principalId, approval: 'human-approved' } },
    })
  })

  it('persists narrowed continuations and prevents prior approval and execution from using the shared Session', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const options = { assistant: { ...assistant, permissions: { exec: true, brokerActions: ['capture', 'update'] } }, approvalSocketPath }
    await startWitness()
    const authority = await startAuthority({ maxOperations: 5 }, options)
    const parentPermissions: WorkPermissions = { exec: true, brokerActions: ['capture'] }
    const input = handoffProposal({ ...handoffRequest, delegation: { ...handoffRequest.delegation, permissions: parentPermissions } })
    const delegation = await client.propose(input)
    await client.execute(delegation.id)
    const awaitingReview = await client.propose(proposal())
    const previouslyApproved = await approver.decide(decisionFor(await client.propose(proposal()), 'approve'))
    const continuation: typeof handoffRequest = {
      ...handoffRequest, key: 'continue-work', delegation: {
        workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: handoffRequest.delegation.workId,
        permissions: { exec: true, brokerActions: [] },
      },
    }
    await expect(client.propose(handoffProposal({ ...continuation, targetSessionId: SessionId('worker-2') })))
      .rejects.toMatchObject({ code: 'work-conflict' })
    await expect(client.propose(handoffProposal({
      ...continuation, delegation: { ...continuation.delegation, permissions: { exec: true, brokerActions: ['update'] } },
    }))).rejects.toMatchObject({ code: 'work-permission-denied' })
    const next = await client.propose(handoffProposal(continuation))
    await expect(client.execute(next.id)).resolves.toMatchObject({
      state: 'settled', outcome: { work: { ...continuation.delegation, sessionId: input.handoff.targetSessionId } },
    })
    await authority.close()
    await startAuthority({ maxOperations: 5 }, options)
    await expect(approver.decide(decisionFor(awaitingReview, 'approve'))).rejects.toMatchObject({ code: 'work-superseded' })
    await expect(client.execute(previouslyApproved.id)).rejects.toMatchObject({ code: 'work-superseded' })
    await expect(client.propose(input)).rejects.toMatchObject({ code: 'work-superseded' })
    await expect(client.propose(proposal())).resolves.toMatchObject({
      state: 'pending-approval', review: { workId: continuation.delegation.workId },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a late approval receipt after a continuation supersedes its work', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, evidence, run } = await fixture(test)
    await startWitness()
    await startAuthority({ maxOperations: 3 }, { assistant, approvalSocketPath })
    await client.execute((await client.propose(handoffProposal())).id)
    const pending = await client.propose(proposal())
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    const append = evidence.append.bind(evidence)
    vi.spyOn(evidence, 'append').mockImplementation(async (event) => {
      if (event.id === `${pending.id}-admission`) {
        entered.resolve(undefined)
        await resume.promise
      }
      return append(event)
    })
    const deciding = expect(approver.decide(decisionFor(pending, 'approve'))).rejects.toMatchObject({ code: 'work-superseded' })
    try {
      await entered.promise
      const continuation = await client.propose(handoffProposal({
        ...handoffRequest, key: 'continuation', delegation: {
          workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: handoffRequest.delegation.workId,
        },
      }))
      await expect(client.execute(continuation.id)).resolves.toMatchObject({ state: 'settled' })
    } finally {
      resume.resolve(undefined)
      await deciding
    }
    await expect(client.execute(pending.id)).rejects.toMatchObject({ code: 'work-superseded' })
    expect(run).not.toHaveBeenCalled()
  })

  it('blocks a continuation until a consumed permit has stopped its worker execution', async (test) => {
    const { client, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority({ maxOperations: 3 }, { assistant })
    await client.execute((await client.propose(handoffProposal())).id)
    const issued = await client.propose(proposal())
    const started = Promise.withResolvers<undefined>()
    const drained = Promise.withResolvers<ExecutionObservation>()
    run.mockImplementationOnce(() => {
      started.resolve(undefined)
      return drained.promise
    })
    const execution = client.execute(issued.id)
    const continuation = handoffProposal({
      ...handoffRequest, key: 'continuation', delegation: {
        workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: handoffRequest.delegation.workId,
      },
    })
    try {
      await started.promise
      await expect(client.propose(continuation)).rejects.toMatchObject({ code: 'work-busy' })
    } finally {
      drained.resolve(observation)
      await execution
    }
    await expect(client.execute((await client.propose(continuation)).id)).resolves.toMatchObject({ state: 'settled' })
  })

  it('does not expand an existing work grant when the operator expands the root grant', async (test) => {
    const { client, approver, approvalSocketPath, startWitness, startAuthority, run } = await fixture(test)
    const broker = brokerFixture()
    await startWitness()
    const initial = await startAuthority({ maxOperations: 4 }, { assistant, approvalSocketPath, broker })
    await client.execute((await client.propose(handoffProposal())).id)
    await initial.close()
    await startAuthority({ maxOperations: 4, fingerprint: '2'.repeat(64) }, {
      assistant: { ...assistant, permissions: { exec: true, brokerActions: ['capture'] } }, approvalSocketPath, broker,
    })
    const continuation = await client.propose(handoffProposal({
      ...handoffRequest, key: 'continuation', delegation: {
        workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: handoffRequest.delegation.workId,
      },
    }))
    await expect(client.execute(continuation.id)).resolves.toMatchObject({
      state: 'settled', outcome: { work: { permissions: assistant.permissions } },
    })
    const result = Promise.withResolvers<unknown>()
    run.mockImplementationOnce(async (_session, _script, signal, submit) => {
      if (submit === undefined) throw new Error('Expected a live broker capability')
      result.resolve(await submit({ requestKey: randomUUID(), action: 'capture', body: '{}' }, signal))
      return observation
    })
    const parent = await approver.decide(decisionFor(await client.propose(proposal()), 'approve'))
    await expect(client.execute(parent.id)).resolves.toMatchObject({ state: 'settled' })
    await expect(result.promise).resolves.toMatchObject({ code: 'work-permission-denied' })
    expect(broker.resolve).not.toHaveBeenCalled()
  })

  it('keeps version 6 history and budget without treating old operations as witnessed work', async (test) => {
    const { client, startWitness, startAuthority, databasePath, grant, run } = await fixture(test)
    await startWitness()
    const legacy = await startAuthority({ maxOperations: 3 })
    const issued = await client.propose(proposal())
    const interrupted = await client.propose(proposal())
    await legacy.close()
    const store = await OperationStore.open(databasePath, grant)
    try {
      store.put({ ...store.get(interrupted.id), state: 'running' }, 'issued')
    } finally {
      store.close()
    }
    simulateLegacyStore(databasePath, 6)
    await startAuthority({ maxOperations: 3 }, { assistant })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'work-not-authorized' })
    await expect(client.status(interrupted.id)).resolves.toMatchObject({ state: 'unknown', outcome: { code: 'authority-interrupted' } })
    await expect(client.propose(handoffProposal({
      ...handoffRequest, delegation: { ...handoffRequest.delegation, previousWorkId: workIdSchema.parse('0'.repeat(64)) },
    }))).rejects.toMatchObject({ code: 'work-conflict' })
    await client.execute((await client.propose(handoffProposal())).id)
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'work-superseded' })
    await expect(client.propose(proposal())).rejects.toMatchObject({ code: 'budget-exhausted' })
    expect(run).not.toHaveBeenCalled()
  })

  it('validates handoff keys, Unicode, and complete request byte limits before spending budget', async (test) => {
    const { client, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    await startAuthority({ maxOperations: 1 }, { assistant })
    const input = handoffProposal()
    await expect(client.propose({ ...input, requestKey: randomUUID() })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(client.propose({ ...proposal(), requestKey: input.requestKey })).rejects.toMatchObject({ code: 'bad-request' })
    for (const content of ['', '\uD800']) {
      await expect(client.propose({ ...input, handoff: { ...input.handoff, content } })).rejects.toMatchObject({ code: 'bad-request' })
    }
    await expect(client.propose({
      ...input, handoff: { ...input.handoff, content: '界'.repeat(90_000) },
    })).rejects.toMatchObject({ code: 'request-too-large' })
    await expect(client.propose(input)).resolves.toMatchObject({ state: 'issued' })
  })

  it('uses the shared budget, binds the exact handoff, and reuses the witnessed release', async (test) => {
    const { client, evidence, startWitness, startAuthority, run, socketPath } = await fixture(test)
    await startWitness()
    await startAuthority({}, { assistant })
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(UnixHandoffControl, { socketPath })
    const input = handoffProposal()
    const release = await ctx.handoffControl.release(handoffRequest)
    const contentDigest = createHash('sha256').update(handoffRequest.content).digest('hex')
    const body = { handoffKind: 'delegation', targetSessionId: handoffRequest.targetSessionId, contentDigest }
    expect(await evidence.get(`${release.operationId}-admission`)).toMatchObject({
      event: { body: { ...body, requestKey: input.requestKey, sessionId: input.sessionId,
        workId: handoffRequest.delegation.workId, previousWorkId: null, permissions: assistant.permissions } },
    })
    expect(await evidence.get(release.receipt.id)).toEqual({
      receipt: release.receipt,
      event: { id: release.receipt.id, operationId: release.operationId, kind: 'outcome', body: { ...body, kind: 'released', work: release.work } },
    })
    await expect(ctx.handoffControl.release(handoffRequest)).resolves.toEqual(release)
    await expect(ctx.handoffControl.release({ ...handoffRequest, content: 'changed payload' })).rejects.toMatchObject({
      code: 'key-conflict', operationId: release.operationId,
    })
    await expect(ctx.handoffControl.release({ ...handoffRequest, targetSessionId: SessionId('worker-2') })).rejects.toMatchObject({
      code: 'key-conflict', operationId: release.operationId,
    })
    await expect(client.propose({
      ...input, handoff: { ...input.handoff, kind: 'delivery', targetSessionId: assistant.mainSessionId },
    })).rejects.toMatchObject({ code: 'key-conflict', operationId: release.operationId })
    await expect(client.propose(proposal())).resolves.toMatchObject({ state: 'issued' })
    await expect(ctx.handoffControl.release({
      ...handoffRequest, key: 'next-call', targetSessionId: SessionId('worker-2'),
      delegation: { workId: workIdSchema.parse('2'.repeat(64)), previousWorkId: null, permissions: assistant.permissions },
    })).rejects.toMatchObject({ code: 'budget-exhausted' })
    expect(run).not.toHaveBeenCalled()
  })

  it('withholds unwitnessed handoffs and recovers their release after authority restart', async (test) => {
    const { client, startWitness, startAuthority, socketPath } = await fixture(test)
    const closeConfigurationWitness = await startWitness()
    const authority = await startAuthority({ maxOperations: 1 }, { assistant })
    await closeConfigurationWitness()
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(UnixHandoffControl, { socketPath })
    const input = handoffProposal()
    const pending = await client.propose(input)
    expect(pending.state).toBe('pending-evidence')
    await expect(ctx.handoffControl.release(handoffRequest)).rejects.toMatchObject({
      code: 'handoff-not-released', operationId: pending.id,
    })
    const closeWitness = await startWitness()
    await expect(client.propose(input)).resolves.toMatchObject({ id: pending.id, state: 'issued' })
    await closeWitness()
    const observed = await client.execute(pending.id)
    expect(observed.state).toBe('pending-outcome-evidence')
    expect(observed.outcome).toBeUndefined()
    await expect(ctx.handoffControl.release(handoffRequest)).rejects.toMatchObject({
      code: 'handoff-not-released', operationId: pending.id,
    })
    await authority.close()
    await startWitness()
    await startAuthority({ maxOperations: 1 }, { assistant })
    await expect(ctx.handoffControl.release(handoffRequest)).resolves.toMatchObject({
      operationId: pending.id, receipt: { id: `${pending.id}-outcome` },
    })
  })

  it('leaves a release pending when the witness replies with a different outcome digest', async (test) => {
    const { client, evidence, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    await startAuthority({}, { assistant })
    const issued = await client.propose(handoffProposal())
    const append = vi.spyOn(evidence, 'append')
    append.mockResolvedValueOnce({ id: `${issued.id}-outcome`, digest: 'a'.repeat(64) })
    const pending = await client.execute(issued.id)
    expect(pending.state).toBe('pending-outcome-evidence')
    expect(pending.outcome).toBeUndefined()
    expect(pending.receipt).toBeUndefined()
    await expect(client.status(issued.id)).resolves.toMatchObject({ state: 'settled', outcome: { kind: 'released' } })
  })

  it.for(['$.outcome.targetSessionId', '$.receipt.digest'])('rejects recovery of a release with corrupt %s', async (field, test) => {
    const { client, startWitness, startAuthority, databasePath } = await fixture(test)
    await startWitness()
    const authority = await startAuthority({}, { assistant })
    const issued = await client.propose(handoffProposal())
    await expect(client.execute(issued.id)).resolves.toMatchObject({ state: 'settled' })
    await authority.close()
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare('UPDATE operations SET record = json_set(record, ?, ?) WHERE id = ?').run(field, 'a'.repeat(64), issued.id)
    } finally {
      db.close()
    }
    await startAuthority({}, { assistant })
    await expect(client.status(issued.id)).rejects.toMatchObject({ code: 'storage-unavailable' })
  })

  it('rejects retrieval of a settled release after expiry or revision change', async (test) => {
    const { client, startWitness, startAuthority, databasePath } = await fixture(test)
    await startWitness()
    const authority = await startAuthority({}, { assistant })
    const input = handoffProposal()
    const issued = await client.propose(input)
    await expect(client.execute(issued.id)).resolves.toMatchObject({ state: 'settled' })
    await authority.close()
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("UPDATE operations SET record = json_set(record, '$.expiresAt', 1) WHERE id = ?").run(issued.id)
    } finally {
      db.close()
    }
    const expired = await startAuthority({}, { assistant })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'grant-expired', operationId: issued.id })
    await expect(client.status(issued.id)).rejects.toMatchObject({ code: 'grant-expired', operationId: issued.id })
    await expect(client.propose(input)).rejects.toMatchObject({ code: 'grant-expired', operationId: issued.id })
    await expired.close()
    await startAuthority({ fingerprint: '2'.repeat(64) }, { assistant: { ...assistant, mainSessionId: SessionId('new-main') } })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch', operationId: issued.id })
    await expect(client.status(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch', operationId: issued.id })
    await expect(client.propose(input)).rejects.toMatchObject({ code: 'revision-mismatch', operationId: issued.id })
  })

  it.for([1, 2, 3, 4, 5, 6, 7])('keeps issued shell permits and reservations when opening a version %s database', async (version, test) => {
    const { client, databasePath, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const authority = await startAuthority({ maxOperations: 1 })
    const input = proposal()
    const issued = await client.propose(input)
    await authority.close()
    simulateLegacyStore(databasePath, version)
    await startAuthority({ maxOperations: 1 })
    await expect(client.propose(input)).resolves.toEqual(issued)
    await expect(client.propose(proposal())).rejects.toMatchObject({ code: 'budget-exhausted' })
    await expect(client.execute(issued.id)).resolves.toMatchObject({ state: 'settled', outcome: { kind: 'exited', observation } })
  })

  it('reserves across Sessions and consumes one permit under concurrent requests', async (test) => {
    const { client, evidence, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority()
    const input = proposal()
    const [issued, duplicate] = await Promise.all([client.propose(input), client.propose(input)])
    expect(issued.state).toBe('issued')
    expect(duplicate).toEqual(issued)
    await expect(client.propose({ ...input, command: 'different' })).rejects.toMatchObject({ code: 'key-conflict', operationId: issued.id })
    const [next, exhausted] = await Promise.allSettled([client.propose(proposal('worker-2')), client.propose(proposal('worker-3'))])
    expect([next.status, exhausted.status].sort()).toEqual(['fulfilled', 'rejected'])
    const denied = next.status === 'rejected' ? next : exhausted
    expect(denied).toMatchObject({ reason: { code: 'budget-exhausted' } })
    const executions = await Promise.all([client.execute(issued.id), client.execute(issued.id)])
    expect(executions.some(result => result.state === 'settled')).toBe(true)
    const settled = await client.execute(issued.id)
    expect(settled).toMatchObject({ state: 'settled', outcome: { kind: 'exited', observation } })
    expect(run).toHaveBeenCalledExactlyOnceWith(input.sessionId, input.command, expect.any(AbortSignal))
    expect(await evidence.get(issued.admission!.id)).toMatchObject({
      receipt: issued.admission, event: { operationId: issued.id, kind: 'admission', body: { sessionId: input.sessionId } },
    })
    expect(await evidence.get(settled.receipt!.id)).toMatchObject({
      receipt: settled.receipt, event: { operationId: issued.id, kind: 'outcome', body: { exitCode: 7, stopped: true } },
    })
  })

  it('fails closed without admission evidence and repairs missing outcome evidence without executing again', async (test) => {
    const { client, evidence, startWitness, startAuthority, run } = await fixture(test)
    const closeConfigurationWitness = await startWitness()
    await startAuthority()
    await closeConfigurationWitness()
    const input = proposal()
    const waiting = await client.propose(input)
    expect(waiting.state).toBe('pending-evidence')
    expect((await client.execute(waiting.id)).state).toBe('pending-evidence')
    expect(run).not.toHaveBeenCalled()
    const closeWitness = await startWitness()
    const issued = await client.propose(input)
    expect(issued).toMatchObject({ id: waiting.id, state: 'issued' })
    await closeWitness()
    expect(await client.execute(issued.id)).toMatchObject({ state: 'pending-outcome-evidence', outcome: { kind: 'exited' } })
    await startWitness()
    expect(await client.overview(input.sessionId)).toMatchObject({
      reserved: 1, unknown: 1, lastFailure: { id: issued.id, code: 'outcome-evidence-unavailable' },
    })
    expect(await evidence.get(`${issued.id}-outcome`)).toBeUndefined()
    expect(await client.status(issued.id)).toMatchObject({ state: 'settled', receipt: { id: `${issued.id}-outcome` } })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rejects expired and superseded grants, including a configuration reverted after restart', async (test) => {
    const { client, startWitness, startAuthority, run, databasePath } = await fixture(test)
    await startWitness()
    const authority = await startAuthority()
    const input = proposal()
    const issued = await client.propose(input)
    await authority.close()
    const db = new DatabaseSync(databasePath)
    try {
      db.prepare("UPDATE operations SET record = json_set(record, '$.expiresAt', 1) WHERE id = ?").run(issued.id)
    } finally {
      db.close()
    }
    const expired = await startAuthority()
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'grant-expired', operationId: issued.id })
    await expired.close()
    const revised = await startAuthority({ fingerprint: '2'.repeat(64) })
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch', operationId: issued.id })
    await revised.close()
    await startAuthority()
    expect((await client.propose(input)).id).toBe(issued.id)
    await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch' })
    expect(run).not.toHaveBeenCalled()
  })

  it.for(['command', 'handoff'])('marks an interrupted consumed %s permit unknown and preserves it without replay', async (kind, test) => {
    const { client, evidence, startWitness, startAuthority, run, databasePath, grant } = await fixture(test)
    await startWitness()
    const options = kind === 'handoff' ? { assistant } : {}
    const authority = await startAuthority({}, options)
    const input = kind === 'command' ? proposal() : handoffProposal()
    const issued = await client.propose(input)
    await authority.close()
    const crashed = await OperationStore.open(databasePath, { ...grant, ...options })
    try {
      const operation = crashed.get(issued.id)
      crashed.put({ ...operation, state: 'running' }, 'issued')
      await expect(OperationStore.open(databasePath, grant)).rejects.toThrow()
    } finally {
      crashed.close()
    }
    await startAuthority({}, options)
    expect(await client.overview(input.sessionId)).toMatchObject({
      reserved: 1, remaining: 1, unknown: 1, lastFailure: { id: issued.id, code: 'authority-interrupted' },
    })
    expect(await evidence.get(`${issued.id}-outcome`)).toBeUndefined()
    expect(await client.execute(issued.id)).toMatchObject({
      state: 'unknown', outcome: { kind: 'unknown', code: 'authority-interrupted' }, receipt: { id: `${issued.id}-outcome` },
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('preserves a revocation and never consumes a canceled permit', async (test) => {
    const { client, evidence, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority()
    const issued = await client.propose(proposal())
    const canceled = await client.cancel(issued.id)
    expect(canceled).toMatchObject({ state: 'canceled', receipt: { id: `${issued.id}-revocation` } })
    expect(await evidence.get(canceled.receipt!.id)).toMatchObject({
      receipt: canceled.receipt, event: { operationId: issued.id, kind: 'revocation' },
    })
    expect(await client.execute(issued.id)).toEqual(canceled)
    expect(run).not.toHaveBeenCalled()
  })

  it('continues independently of the HTTP wait and drains a canceled command before replying', async (test) => {
    const { client, startWitness, startAuthority, run } = await fixture(test)
    await startWitness()
    await startAuthority()
    const started = Promise.withResolvers<AbortSignal>()
    const drained = Promise.withResolvers<ExecutionObservation>()
    run.mockImplementationOnce((_session, _command, signal) => {
      started.resolve(signal)
      return drained.promise
    })
    const issued = await client.propose(proposal())
    const waiting = new AbortController()
    const execution = client.execute(issued.id, waiting.signal)
    const signal = await started.promise
    waiting.abort()
    await expect(execution).rejects.toMatchObject({ code: 'authority-unavailable', operationId: issued.id })
    expect((await client.status(issued.id)).state).toBe('running')
    expect(signal.aborted).toBe(false)
    const aborted = Promise.withResolvers<undefined>()
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    const canceling = client.cancel(issued.id)
    try {
      await aborted.promise
      expect((await client.status(issued.id)).state).toBe('running')
    } finally {
      drained.resolve(observation)
    }
    expect(await canceling).toMatchObject({ state: 'settled', outcome: { observation } })
    expect(run).toHaveBeenCalledTimes(1)
  })
})

/** A broker provider that lists configured actions; these tests send nothing through it. */
class ListedBroker extends OperationBroker {
  override readonly fingerprint: string
  private readonly listed: readonly BrokerActionDescription[]

  constructor(ctx: Context, config: { actions: readonly BrokerActionDescription[] }) {
    super(ctx)
    this.listed = config.actions
    this.fingerprint = createHash('sha256').update(JSON.stringify(config.actions)).digest('hex')
  }

  override actions(): readonly BrokerActionDescription[] { return this.listed }
  override resolve(): PreparedBrokerRequest { throw new Error('The listed broker prepares no request') }
  override run(): Promise<BrokerObservation> { throw new Error('The listed broker sends no request') }
  override reconcile(): Promise<BrokerResolution> { throw new Error('The listed broker looks up no request') }
}

describe.skipIf(process.platform === 'win32')('configuration record at start', () => {
  const captureAction: BrokerActionDescription = {
    action: brokerActionId('capture'), description: 'Capture a payment.', credentialRef: credentialRef('CAPTURE_TOKEN'),
    routeDigest: 'c'.repeat(64),
  }
  const refundAction: BrokerActionDescription = {
    action: brokerActionId('refund'), credentialRef: credentialRef('REFUND_TOKEN'), returnsResponse: true, routeDigest: 'd'.repeat(64),
  }

  async function configurationEvents(evidence: EvidenceClient): Promise<Witness.EvidenceEvent[]> {
    const { records } = await evidence.list(0)
    return records.flatMap(({ event }) => event.id.startsWith('configuration-') ? [event] : [])
  }

  async function profileFixture(test: TestContext) {
    const f = await fixture(test)
    const profile = {
      principalId: 'agent-1', scopeId: 'offline-shell', socketPath: f.socketPath, approvalSocketPath: f.approvalSocketPath,
      databasePath: f.databasePath, evidenceSocketPath: f.evidencePath, grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 4,
      broker: ['operationBroker'],
      unattendedBrokerActions: [{ action: 'capture', match: { kind: 'auto' }, allow: [] }],
      model: { provider: 'fixture-provider', model: 'fixture-model', credentialRef: 'FIXTURE_MODEL_KEY' },
      assistant: {
        mainSessionId: 'assistant-main',
        permissions: {
          exec: true, brokerActions: ['capture'],
          data: { import: false, export: false, discloseToModel: true, discloseToUser: false, returnResponses: false },
        },
      },
    }
    /** Run the plugin as a launched profile does, with an execution backend that runs nothing. */
    const start = async (config: Config, actions: readonly BrokerActionDescription[] = [captureAction, refundAction]) => {
      const ctx = new Context()
      const stop = () => ctx.fiber.dispose()
      f.own(stop)
      ctx.provide('isolatedExecution', {
        reservedPaths: [],
        open: () => ({
          ready: Promise.resolve({ fingerprint: 'e'.repeat(64), maxCommandBytes: 32_768, maxOutputBytes: 131_072, supportsBroker: true }),
          run: () => Promise.resolve(observation),
          dispose: () => Promise.resolve(),
        }),
      })
      await ctx.plugin(LlmRuntime)
      class FixtureAdapter extends LlmAdapter { override stream = vi.fn() }
      ctx.llm.registerAdapter(['fixture-provider', 'other-provider'], new FixtureAdapter())
      await ctx.plugin(ListedBroker, { actions })
      await ctx.plugin(OperationControl, config)
      return stop
    }
    return { ...f, profile, start }
  }

  it('requires routes for permitted broker actions and starts with an empty permission list', async (test) => {
    const { client, profile, start, startWitness } = await profileFixture(test)
    await startWitness()
    const config = { ...profile, unattendedBrokerActions: [] }
    const permissions = { ...profile.assistant.permissions, brokerActions: ['missing-capture', 'missing-refund'] }
    await expect(start({ ...config, assistant: { ...profile.assistant, permissions } }, [])).rejects.toThrow(
      'No configured broker provides permitted actions: "missing-capture", "missing-refund". Add their routes or remove them from assistant.permissions.brokerActions.',
    )
    await start({
      ...config, assistant: { ...profile.assistant, permissions: { ...permissions, brokerActions: [] } },
    }, [])
    expect(await client.overview(SessionId('worker-1'))).toMatchObject({ reserved: 0 })
  })

  it('records the permitted ceiling, actions, rules, model route, and limits once for a new store', async (test) => {
    const { approver, client, evidence, profile, start, startWitness } = await profileFixture(test)
    await startWitness()
    const stop = await start(profile)
    const [event, ...others] = await configurationEvents(evidence)
    if (event === undefined) throw new Error('Expected the configuration record of the first start')
    expect(others).toEqual([])
    const { revision, configuration } = await approver.grant()
    expect(configuration).toEqual({ id: event.id, digest: digestEvidenceEvent(event) })
    expect(event).toEqual({
      id: expect.stringMatching(/^configuration-[a-f0-9]{64}$/u) as string,
      operationId: expect.stringMatching(/^grant-[a-f0-9]{64}$/u) as string,
      kind: 'admission',
      body: {
        kind: 'configuration', principalId: 'agent-1', scopeId: 'offline-shell', previousRevision: null, revision,
        configuration: {
          permissions: {
            mainSessionId: 'assistant-main', exec: true, brokerActions: ['capture'],
            data: { import: false, export: false, discloseToModel: true, discloseToUser: false, returnResponses: false },
          },
          broker: {
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
            actions: [{ action: 'capture', credentialRef: 'CAPTURE_TOKEN', returnsResponse: false }],
          },
          unattendedShell: false,
          unattendedBrokerActions: [{ action: 'capture', match: { kind: 'auto' }, allow: [] }],
          model: { provider: 'fixture-provider', model: 'fixture-model', credentialRef: 'FIXTURE_MODEL_KEY' },
          execution: 'e'.repeat(64),
          limits: { expiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 4, maxFileBytes: DEFAULT_MAX_FILE_BYTES },
        },
      },
    })
    await stop()
    await start(profile)
    expect(await configurationEvents(evidence)).toHaveLength(1)
    expect(await approver.grant()).toMatchObject({ revision, configuration })
    expect(await client.overview(SessionId('worker-1'))).toMatchObject({ reserved: 0 })
  })

  it('records each changed start with the previous and the new revision', async (test) => {
    const { approver, evidence, profile, start, startWitness } = await profileFixture(test)
    await startWitness()
    const { assistant } = profile
    const noData = { ...assistant.permissions, data: undefined }
    const twoActions = { ...noData, brokerActions: ['capture', 'refund'] }
    const changes = [
      { ...profile, assistant: { ...assistant, permissions: noData } },
      { ...profile, assistant: { ...assistant, permissions: twoActions } },
      { ...profile, unattendedShell: true, assistant: { ...assistant, permissions: twoActions } },
      { ...profile, unattendedShell: true, model: { provider: 'other-provider', model: 'other-model' }, assistant: { ...assistant, permissions: twoActions } },
    ]
    let stop = await start(profile)
    let { revision } = await approver.grant()
    const bodies: Witness.EvidenceJson[] = []
    for (const config of changes) {
      await stop()
      stop = await start(config)
      const event = (await configurationEvents(evidence)).at(-1)
      const settings = await approver.grant()
      expect(event?.id).toBe(settings.configuration.id)
      expect(event?.body).toMatchObject({ previousRevision: revision, revision: settings.revision })
      expect(settings.revision).not.toBe(revision)
      revision = settings.revision
      if (event !== undefined) bodies.push(event.body)
    }
    expect(await configurationEvents(evidence)).toHaveLength(5)
    expect(bodies).toMatchObject([
      { configuration: { permissions: { brokerActions: ['capture'], data: null } } },
      {
        configuration: {
          permissions: { brokerActions: ['capture', 'refund'] },
          broker: {
            actions: [
              { action: 'capture', credentialRef: 'CAPTURE_TOKEN', returnsResponse: false },
              { action: 'refund', credentialRef: 'REFUND_TOKEN', returnsResponse: true },
            ],
          },
          unattendedShell: false,
        },
      },
      { configuration: { unattendedShell: true, model: { provider: 'fixture-provider' } } },
      { configuration: { model: { provider: 'other-provider', model: 'other-model', credentialRef: null } } },
    ])
  })

  it('refuses every request until the witness confirms the record, then admits under its revision', async (test) => {
    const { client, approver, evidence, profile, start, startWitness } = await profileFixture(test)
    const stopWitness = await startWitness()
    const stop = await start(profile)
    const { revision } = await approver.grant()
    await stop()
    await stopWitness()
    await start({ ...profile, unattendedShell: true })
    const sessionId = SessionId('worker-1')
    const requests = [
      () => client.propose(proposal()), () => client.overview(sessionId), () => approver.grant(), () => approver.businessRecords(),
    ]
    for (const request of requests) {
      await expect(request()).rejects.toMatchObject({ code: 'configuration-evidence-unavailable',
        message: "The witness service is not confirming records. This operation did not run or send anything. Check Vardock's services with pnpm vardock doctor. Vardock recovers automatically when the witness returns.",
      })
    }
    await startWitness()
    const settings = await approver.grant()
    const events = await configurationEvents(evidence)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ id: settings.configuration.id, body: { previousRevision: revision, revision: settings.revision } })
    expect(await client.overview(sessionId)).toMatchObject({ reserved: 0 })
  })

  it('refuses to start when the record exceeds the witness request limit', async (test) => {
    const { evidence, profile, start, startWitness } = await profileFixture(test)
    await startWitness()
    const allow = Array.from({ length: 64 }, (_, index) => `${'field'.repeat(50)}${index}`)
    const rules = Array.from({ length: 5 }, (_, index) => ({ action: 'capture', match: { kind: `auto-${index}` }, allow }))
    await expect(start({ ...profile, unattendedBrokerActions: rules })).rejects.toMatchObject({
      code: 'configuration-evidence-refused', message: expect.stringContaining('request byte limit') as string,
    })
    expect(await configurationEvents(evidence)).toEqual([])
  })

  it('repeats a record the witness confirmed before the store committed its receipt', async (test) => {
    const { approver, approvalSocketPath, databasePath, evidence, grant, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const crashed = await OperationStore.open(databasePath, grant)
    const event = crashed.configurationEvent
    try {
      if (event === undefined) throw new Error('Expected a new store to await its configuration record')
      await evidence.append(event)
    } finally {
      crashed.close()
    }
    await startAuthority({}, { approvalSocketPath })
    expect((await approver.grant()).configuration.id).toBe(event.id)
    expect(await configurationEvents(evidence)).toEqual([event])
  })

  it('records the configuration of a database from the previous schema once and keeps its revision', async (test) => {
    const { client, approver, approvalSocketPath, databasePath, evidence, startWitness, startAuthority } = await fixture(test)
    await startWitness()
    const first = await startAuthority({}, { approvalSocketPath })
    const pending = await client.propose(proposal())
    const before = await approver.grant()
    await first.close()
    simulateLegacyStore(databasePath, 11)
    const migrated = await startAuthority({}, { approvalSocketPath })
    const after = await approver.grant()
    expect(after.revision).toBe(before.revision)
    expect(after.configuration.id).not.toBe(before.configuration.id)
    expect((await configurationEvents(evidence)).at(-1)?.body).toMatchObject({
      previousRevision: before.revision, revision: before.revision,
    })
    expect(await approver.decide(decisionFor(pending, 'approve'))).toMatchObject({ state: 'issued' })
    await migrated.close()
    await startAuthority({}, { approvalSocketPath })
    expect(await configurationEvents(evidence)).toHaveLength(2)
  })
})
