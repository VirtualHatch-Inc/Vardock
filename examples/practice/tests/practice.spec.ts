/** Keyless practice walkthrough through dsh profiles and the authority socket harness. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { OperationControlClient, type OperationId, type OperationStatus } from '@deepseek-ai/dsh-operation-control/library'
import { workIdSchema } from '../../../packages/experimental/operation-control/src/protocol.ts'
import { EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { SessionId } from '@deepseek-ai/dsh-session'
import { execa } from 'execa'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const example = fileURLToPath(new URL('../', import.meta.url))
const repo = fileURLToPath(new URL('../../../', import.meta.url))

it.skipIf(process.platform === 'win32')('reviews an exact update, confirms its receipt, and admits only the read under an owner rule', async (test) => {
  const root = await mkdtemp('/tmp/practice-')
  const home = join(root, 'service')
  const children: ReturnType<typeof launch>[] = []
  test.onTestFinished(async () => {
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(children)
    await rm(root, { recursive: true, force: true })
  })
  const environment = {
    PATH: process.env.PATH, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, '.agents'),
    TMPDIR: root, VARDOCK_PRACTICE_HOME: home, TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'),
  }
  function launch(dshHome: string, profile: string) {
    const invocation = resolveExampleLaunch({
      mode: 'src', srcBin: join(repo, 'apps/cli/src/bin.ts'), tsconfigPath: join(repo, 'tsconfig.json'), sourceImport: 'tsx/esm',
      configArgs: ['--profile', profile],
      env: { ...environment, DSH_HOME: dshHome },
    })
    const child = execa(invocation.command, invocation.args, {
      cwd: example, env: invocation.env, extendEnv: false, stdin: 'ignore', reject: false, timeout: 80_000, killSignal: 'SIGKILL',
    })
    return child
  }
  async function ready(child: ReturnType<typeof launch>, marker: string) {
    const lines = createInterface({ input: child.stdout })
    const signal = Promise.withResolvers<string>()
    lines.on('line', (line) => { if (line.startsWith(marker)) signal.resolve(line) })
    try {
      return await Promise.race([signal.promise, child.then((result) => { throw new Error(`Profile exited before readiness: ${result.stderr}\n${result.stdout}`) })])
    } finally { lines.close() }
  }
  function approve(approver: OperationControlClient, pending: OperationStatus) {
    if (pending.review === undefined) throw new Error('Expected an approval review')
    return approver.decide({ id: pending.id, revision: pending.review.revision, payloadDigest: pending.review.payloadDigest, decision: 'approve' })
  }

  const service = launch(example, 'practice')
  children.push(service)
  const setup = await ready(service, 'pnpm vardock setup ')
  const permitActions = [...setup.matchAll(/--permit-action ([a-z-]+)/gu)].map(match => match[1])
  expect(permitActions).toEqual(['list-items', 'set-quantity'])
  expect(setup).toContain(`--authority-patch '${join(home, 'authority.patch.yml')}'`)
  const patchPath = join(home, 'authority.patch.yml')
  const generated = await readFile(patchPath, 'utf8')
  expect(load(generated)).toEqual([{ id: 'operation-broker', config: { routes: expect.arrayContaining([
    {
      action: 'list-items', description: expect.any(String) as string, endpoint: 'https://127.0.0.1:19443/items',
      credentialRef: 'PRACTICE_TOKEN', ca: join(home, 'server.pem'), returnResponse: true,
    },
    {
      action: 'set-quantity', description: expect.any(String) as string, endpoint: 'https://127.0.0.1:19443/quantity',
      reconciliationEndpoint: 'https://127.0.0.1:19443/status', credentialRef: 'PRACTICE_TOKEN', ca: join(home, 'server.pem'),
    },
  ]) as object[] } }])
  for (const name of ['server.pem', 'server-key.pem', 'authority.patch.yml']) {
    expect((await stat(join(home, name))).mode & 0o777).toBe(0o600)
  }

  const authorityHome = join(root, 'authority')
  const witnessHome = join(root, 'witness')
  const operationSocket = join(root, 'operation.sock')
  const approvalSocket = join(root, 'approval.sock')
  const witnessSocket = join(root, 'evidence.sock')
  const execution = join(root, 'execution.mjs')
  await writeFile(execution, `export function apply(ctx) {
  ctx.provide('isolatedExecution', {
    reservedPaths: [],
    open() { return {
      ready: Promise.resolve({ fingerprint: 'fixture-execution', maxCommandBytes: 32768, maxOutputBytes: 131072, supportsBroker: true }),
      async run(_session, command, signal, submit) {
        const reply = await submit(JSON.parse(command), signal)
        return { exitCode: 0, stdout: JSON.stringify(reply), stderr: '', stdoutTruncated: false, stderrTruncated: false,
          containerId: '${'b'.repeat(64)}', stopped: true }
      },
      async dispose() {},
    } },
  })
}\n`)
  const readiness = join(root, 'ready.mjs')
  await writeFile(readiness, `import { createConnection } from 'node:net'
export const inject = ['appReady']
export function apply(ctx, config) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    const socket = createConnection(config.socket)
    socket.once('connect', () => { socket.destroy(); process.stdout.write('operation-service-ready\\n') })
    socket.once('error', () => { socket.destroy() })
  }))
}\n`)
  const permissions = {
    exec: true, brokerActions: ['list-items', 'set-quantity'],
    data: { import: false, export: false, discloseToModel: true, discloseToUser: true, returnResponses: true },
  }
  const authorityEntries = applyEntryPatches([
    { id: 'credentials', name: join(repo, 'packages/credentials/credentials-local/src/index.ts') },
    { id: 'operation-broker', name: join(repo, 'packages/experimental/operation-broker/src/index.ts'), config: { routes: [] } },
    { id: 'execution', name: execution },
    { id: 'operation-control', name: join(repo, 'packages/experimental/operation-control/src/index.ts'), inject: ['operationBroker'], config: {
      principalId: 'owner', scopeId: 'offline-shell', socketPath: operationSocket, approvalSocketPath: approvalSocket,
      evidenceSocketPath: witnessSocket, databasePath: join(root, 'authority.sqlite'),
      grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 1000, broker: ['operationBroker'], unattendedShell: true,
      assistant: { mainSessionId: 'assistant-main', permissions: { ...permissions, brokerActions: permitActions } },
    } },
    { id: 'ready', name: readiness, config: { socket: operationSocket } },
  ], loadOverlayPatches('practice', patchPath), (format, ...args) => { throw new Error(`${format} ${args.join(' ')}`) })
  for (const [profileHome, profileName, entries] of [
    [authorityHome, 'authority', authorityEntries],
    [witnessHome, 'witness', [
      { name: join(repo, 'packages/experimental/operation-evidence/src/index.ts'), config: { socketPath: witnessSocket, databasePath: join(root, 'witness.sqlite') } },
      { id: 'ready', name: readiness, config: { socket: witnessSocket } },
    ]],
  ] as const) {
    const profilePath = join(profileHome, 'profiles', profileName)
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
    await writeFile(join(profilePath, 'cordis.patch.yml'), JSON.stringify([{ insert: entries }]))
  }
  const authority = launch(authorityHome, 'authority')
  const witness = launch(witnessHome, 'witness')
  children.push(authority, witness)
  await Promise.all([ready(authority, 'operation-service-ready'), ready(witness, 'operation-service-ready')])
  const client = new OperationControlClient({ socketPath: operationSocket })
  const approver = new OperationControlClient({ socketPath: approvalSocket })
  const evidence = new EvidenceClient({ socketPath: witnessSocket })
  await approver.setBrokerConnection({ action: 'list-items', value: 'practice-only-token' })
  const sessionId = SessionId('practice-worker')
  const workId = workIdSchema.parse('c'.repeat(64))
  const delegation = await client.propose({
    requestKey: workId, sessionId: SessionId('assistant-main'),
    handoff: { kind: 'delegation', targetSessionId: sessionId, content: 'Practice inventory.', delegation: { workId, previousWorkId: null, permissions } },
  })
  expect(await client.execute(delegation.id)).toMatchObject({ state: 'settled' })
  const body = '{"sku":"pencil","quantity":7}'
  const parent = await client.propose({ requestKey: randomUUID(), sessionId, command: JSON.stringify({ requestKey: randomUUID(), action: 'set-quantity', body }) })
  const waiting = client.waitReview(parent.id)
  const sending = client.execute(parent.id)
  const pending = await waiting
  if (pending === undefined) throw new Error('Expected an attended business request')
  expect(pending).toMatchObject({ state: 'pending-approval', review: { business: { action: 'set-quantity', endpoint: 'https://127.0.0.1:19443/quantity', body } } })
  expect((await client.businessOperations(sessionId)).operations).toMatchObject([{ id: pending.id, state: 'pending-approval' }])
  await approve(approver, pending)
  expect(await sending).toMatchObject({ state: 'settled', outcome: { kind: 'exited', observation: { exitCode: 0 } } })
  const settled = await client.status(pending.id)
  expect((await evidence.get(`${pending.id}-outcome`))?.receipt).toEqual(settled.receipt)
  const confirmed = await client.reconcile(sessionId, pending.id)
  expect(confirmed.businessCompletion).toMatchObject({ kind: 'succeeded', receiptId: expect.any(String) as string })
  expect(confirmed.businessCompletion.receipt).toBeDefined()
  if (confirmed.businessCompletion.receipt === undefined) throw new Error('Expected witnessed lookup evidence')
  expect((await evidence.get(confirmed.businessCompletion.receipt.id))?.receipt).toEqual(confirmed.businessCompletion.receipt)

  const connections = await approver.brokerConnections()
  await approver.setBrokerConnection({ action: 'list-items', unattended: [{}], revision: connections.revision })
  const read = await client.propose({ requestKey: randomUUID(), sessionId, command: JSON.stringify({ requestKey: randomUUID(), action: 'list-items', body: '{}' }) })
  const automatic = await client.execute(read.id)
  if (automatic.outcome?.kind !== 'exited') throw new Error('Expected the rule-admitted read to finish')
  const returned = JSON.parse(automatic.outcome.observation.stdout) as { id: OperationId; body: string }
  expect(JSON.parse(returned.body)).toMatchObject({ items: expect.arrayContaining([{ sku: 'pencil', quantity: 7 }]) as object[] })
  expect((await evidence.get(`${returned.id}-outcome`))?.receipt).toEqual((await client.status(returned.id)).receipt)
  const update = await client.propose({ requestKey: randomUUID(), sessionId, command: JSON.stringify({ requestKey: randomUUID(), action: 'set-quantity', body: '{"sku":"pencil","quantity":8}' }) })
  const nextReview = client.waitReview(update.id)
  const nextExecution = client.execute(update.id)
  const stillWaiting = await nextReview
  expect(stillWaiting).toMatchObject({ state: 'pending-approval', review: { business: { action: 'set-quantity' } } })
  if (stillWaiting?.review === undefined) throw new Error('Expected update approval after the read rule')
  await approver.decide({ id: stillWaiting.id, revision: stillWaiting.review.revision, payloadDigest: stillWaiting.review.payloadDigest, decision: 'deny' })
  await nextExecution
})
