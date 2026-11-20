/** Verify kernel ownership and restart recovery through separately launched dsh profiles. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { SessionId } from '@deepseek-ai/dsh-session'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { execa } from 'execa'
import { expect, it, type TestContext } from 'vitest'
import { z } from 'zod'
import { OperationControlClient, type OperationStatus } from '../src/client.ts'
import { workIdSchema } from '../src/protocol.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const scope = '@deepseek-ai'
const witnessPackage = 'dsh-operation-evidence'
const authorityPackage = 'dsh-operation-control'
const executionPackage = 'dsh-execution-container'
const subprocessPackage = 'dsh-subprocess-local'
const readiness = 'operation-service-ready'

type Plugin = {
  readonly name: string
  /** Package subpath that exports the plugin, when it is not the main entry. */
  readonly entry?: string
  readonly config?: object
  readonly inject?: readonly string[]
} & ({ readonly directory: string; readonly source?: never } | { readonly source: string; readonly directory?: never })

async function writeProfile(home: string, profile: string, socketPath: string, plugins: readonly Plugin[]): Promise<void> {
  const path = join(home, 'profiles', profile)
  const modules = join(path, 'node_modules', scope)
  await mkdir(modules, { recursive: true })
  const packages = new Map(plugins.flatMap(({ name, directory }) => directory === undefined ? [] : [[name, directory]]))
  await Promise.all([
    ...plugins.flatMap(({ name, directory, source }) => directory === undefined ? [writeFile(join(path, name), source)] : []),
    ...[...packages].map(([name, directory]) => symlink(join(repo, directory), join(modules, name), 'dir')),
  ])
  await writeFile(join(path, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: { profile: { bundles: [] } },
    dependencies: Object.fromEntries([...packages.keys()].map(name => [`${scope}/${name}`, '*'])),
  }))
  await writeFile(join(path, 'ready.mjs'), [
    "import { createConnection } from 'node:net'",
    "export const inject = ['appReady']",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.appReady.onReady(() => {',
    `    const probe = createConnection(${JSON.stringify(socketPath)})`,
    `    probe.once('connect', () => { probe.destroy(); process.stdout.write(${JSON.stringify(`${readiness}\n`)}) })`,
    "    probe.once('error', () => { probe.destroy() })",
    '  }))',
    '}',
    '',
  ].join('\n'))
  await writeFile(join(path, 'cordis.patch.yml'), JSON.stringify([{
    insert: [
      ...plugins.map(({ name, entry, config, inject, directory }) => ({
        name: directory === undefined ? `./${name}` : [scope, name, ...entry === undefined ? [] : [entry]].join('/'), config, inject,
      })),
      { name: './ready.mjs' },
    ],
  }]))
}

function launch(root: string, home: string, profile: string, environment: NodeJS.ProcessEnv = {}) {
  const invocation = resolveExampleLaunch({
    srcBin: join(repo, 'apps/cli/src/bin.ts'),
    tsconfigPath: join(repo, 'tsconfig.json'),
    sourceImport: 'tsx/esm',
    configArgs: ['--profile', profile],
    env: { DSH_HOME: home, DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', TMPDIR: root, ...environment },
  })
  return execa(invocation.command, invocation.args, {
    cwd: root, env: invocation.env, stdin: 'ignore', timeout: 45_000, killSignal: 'SIGKILL', reject: false,
  })
}

function start(children: ReturnType<typeof launch>[], root: string, home: string, profile: string, environment?: NodeJS.ProcessEnv) {
  const child = launch(root, home, profile, environment)
  children.push(child)
  return child
}

async function waitUntilReady(child: ReturnType<typeof launch>): Promise<void> {
  const lines = createInterface({ input: child.stdout })
  const ready = Promise.withResolvers<undefined>()
  lines.on('line', (line) => { if (line === readiness) ready.resolve(undefined) })
  try {
    await Promise.race([
      ready.promise,
      child.then((result) => { throw new Error(`Service exited before readiness\n${result.stderr}\n${result.stdout}`) }),
    ])
  } finally {
    lines.close()
  }
}

function approve(approver: OperationControlClient, pending: OperationStatus): Promise<OperationStatus> {
  if (pending.review === undefined) throw new Error('The command must be reviewed before execution')
  const { revision, payloadDigest } = pending.review
  return approver.decide({ id: pending.id, revision, payloadDigest, decision: 'approve' })
}

async function httpsFixture(test: TestContext, root: string, handler: RequestListener) {
  const cert = join(root, 'cert.pem')
  const key = join(root, 'key.pem')
  await execa('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert,
  ], { timeout: 10_000 })
  const server = createSecureServer({ cert: await readFile(cert), key: await readFile(key) }, handler)
  test.onTestFinished(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The HTTPS fixture is not listening')
  return { cert, origin: `https://127.0.0.1:${address.port}` }
}

it.skipIf(process.platform === 'win32')('restarts both services after SIGKILL and rejects a live socket contender with another database', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'ds-'))
  const home = join(root, 'home')
  const children: ReturnType<typeof launch>[] = []
  test.onTestFinished(async () => {
    try {
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(children)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const witnessSocket = join(root, 'w.sock')
  const authoritySocket = join(root, 'a.sock')
  const approvalSocketPath = join(root, 'p.sock')
  const mainSessionId = SessionId('assistant-main')
  const witnessDirectory = 'packages/experimental/operation-evidence'
  const docker = join(root, 'docker')
  await writeFile(docker, [
    '#!/bin/sh',
    'case "$5 $6" in',
    `  'image inspect') printf '%s\n' 'sha256:${'a'.repeat(64)} linux 0';;`,
    '  \'container ls\'|\'container start\'|\'container stop\') :;;',
    `  'container create') printf '%s\n' '${'b'.repeat(64)}';;`,
    '  \'container exec\') if [ "$7" = "--interactive" ]; then [ "$(cat)" = "printf ready" ] || exit 64; printf ready; fi;;',
    '  *) exit 64;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 })
  await Promise.all([
    ...['witness', 'contender'].map(profile => writeProfile(home, profile, witnessSocket, [{
      name: witnessPackage,
      directory: witnessDirectory,
      config: { socketPath: witnessSocket, databasePath: join(root, `${profile}.sqlite`) },
    }])),
    writeProfile(home, 'authority', authoritySocket, [
      { name: subprocessPackage, directory: 'packages/subprocess/subprocess-local' },
      {
        name: executionPackage,
        directory: 'packages/experimental/execution-container',
        config: { backend: 'docker', command: docker, dockerSocket: join(root, 'docker.sock'), image: 'fixture' },
      },
      {
        name: authorityPackage,
        directory: 'packages/experimental/operation-control',
        config: {
          socketPath: authoritySocket,
          approvalSocketPath,
          databasePath: join(root, 'a.sqlite'),
          evidenceSocketPath: witnessSocket,
          principalId: 'agent',
          scopeId: 'exec',
          grantExpiresAt: Number.MAX_SAFE_INTEGER,
          maxOperations: 2,
          assistant: { mainSessionId, permissions: { exec: true, brokerActions: [] } },
        },
      },
    ]),
  ])
  const witness = start(children, root, home, 'witness')
  const authority = start(children, root, home, 'authority')
  await Promise.all([waitUntilReady(witness), waitUntilReady(authority)])
  const client = new OperationControlClient({ socketPath: authoritySocket })
  const approver = new OperationControlClient({ socketPath: approvalSocketPath })
  const evidence = new EvidenceClient({ socketPath: witnessSocket })
  const input = { requestKey: randomUUID(), sessionId: SessionId('restart'), command: 'printf ready' }
  const workId = workIdSchema.parse('d'.repeat(64))
  const handoff = {
    requestKey: 'c'.repeat(64), sessionId: mainSessionId,
    handoff: {
      kind: 'delegation', targetSessionId: input.sessionId, content: JSON.stringify({ prompt: 'Check readiness.' }),
      delegation: { workId, previousWorkId: null, permissions: { exec: true, brokerActions: [] } },
    },
  } as const
  await expect(client.propose(input)).rejects.toMatchObject({ code: 'work-not-authorized' })
  const handoffIssued = await client.propose(handoff)
  const released = await client.execute(handoffIssued.id)
  const outcomeId = `${handoffIssued.id}-outcome`
  expect(released).toMatchObject({
    state: 'settled', receipt: { id: outcomeId },
    outcome: { kind: 'released', handoffKind: 'delegation', work: { workId, principalId: 'agent', sessionId: input.sessionId } },
  })
  const releaseEvidence = await evidence.get(outcomeId)
  expect(releaseEvidence?.receipt).toEqual(released.receipt)
  const pending = await client.propose(input)
  expect(pending).toMatchObject({
    state: 'pending-approval', review: { command: input.command, sessionId: input.sessionId, workId, principalId: 'agent' },
  })
  expect(await client.execute(pending.id)).toEqual(pending)
  const issued = await approve(approver, pending)
  expect(issued).toMatchObject({ state: 'issued', admission: { id: `${issued.id}-admission` } })
  const receiptId = `${issued.id}-admission`
  const admission = await evidence.get(receiptId)
  expect(admission?.receipt).toEqual(issued.admission)

  const original = await approver.grant()
  expect((await evidence.get(original.configuration.id))?.event.body).toMatchObject({
    kind: 'configuration', previousRevision: null, revision: original.revision,
    configuration: { permissions: { mainSessionId, exec: true, brokerActions: [] }, limits: { maxOperations: 2 } },
  })
  const update = { revision: original.revision, maxOperations: 3, expiresAt: Date.now() + 60_000 }
  await expect(client.updateGrant(update)).rejects.toMatchObject({ code: 'approval-forbidden' })
  const changed = await approver.updateGrant(update)
  expect(changed).toMatchObject({ maxOperations: 3, reserved: 2, remaining: 1 })
  const nextInput = { ...input, requestKey: randomUUID() }
  const next = await approve(approver, await client.propose(nextInput))
  expect(next.state).toBe('issued')

  const contender = await start(children, root, home, 'contender')
  expect(contender.timedOut, contender.stderr).toBe(false)
  expect(contender.signal, contender.stderr).toBeUndefined()
  expect(contender.exitCode, contender.stderr).toBe(0)
  expect(contender.stderr).toContain('already has an owner')
  expect(await evidence.get(receiptId)).toEqual(admission)

  for (const child of [witness, authority]) child.kill('SIGKILL')
  for (const result of await Promise.all([witness, authority])) {
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBe('SIGKILL')
  }
  for (const socket of [witnessSocket, authoritySocket, approvalSocketPath]) expect((await lstat(socket)).isSocket()).toBe(true)

  const restarted = [start(children, root, home, 'witness'), start(children, root, home, 'authority')]
  await Promise.all(restarted.map(waitUntilReady))
  expect(await approver.grant()).toEqual({ ...changed, reserved: 3, remaining: 0 })
  expect(await evidence.get(receiptId)).toEqual(admission)
  expect(await client.propose(input)).toEqual(issued)
  await expect(client.execute(issued.id)).rejects.toMatchObject({ code: 'revision-mismatch' })
  expect(await evidence.get(outcomeId)).toEqual(releaseEvidence)
  expect(await client.propose(handoff)).toEqual(released)
  expect(await client.propose(nextInput)).toEqual(next)
  const executed = await client.execute(next.id)
  expect(executed).toMatchObject({
    state: 'settled',
    outcome: { kind: 'exited', observation: { exitCode: 0, stdout: 'ready', stopped: true } },
  })
  expect((await evidence.get(`${next.id}-outcome`))?.receipt).toEqual(executed.receipt)
  const recorded = await approver.grant()
  expect(recorded.configuration).toEqual(original.configuration)
  const stopAll = async (running: readonly ReturnType<typeof launch>[]) => {
    for (const child of running) child.kill('SIGTERM')
    for (const result of await Promise.all(running)) {
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.signal, result.stderr).toBeUndefined()
      expect(result.exitCode, result.stderr).toBe(0)
    }
  }
  await stopAll(restarted)

  // A profile edit takes effect only after the witness records the changed configuration.
  const patchPath = join(home, 'profiles', 'authority', 'cordis.patch.yml')
  await writeFile(patchPath, (await readFile(patchPath, 'utf8')).replace('"maxOperations":2', '"maxOperations":5'))
  const changedAuthority = start(children, root, home, 'authority')
  await waitUntilReady(changedAuthority)
  await expect(client.propose({ ...input, requestKey: randomUUID() })).rejects.toMatchObject({ code: 'configuration-evidence-unavailable' })
  await expect(approver.grant()).rejects.toMatchObject({ code: 'configuration-evidence-unavailable' })
  const witnessed = start(children, root, home, 'witness')
  await waitUntilReady(witnessed)
  const reconfigured = await approver.grant()
  expect(reconfigured).toMatchObject({ maxOperations: 3, reserved: 3 })
  expect(reconfigured.revision).not.toBe(recorded.revision)
  // The owner's limit edit derives the grant revision, so the record chains the configuration revisions instead.
  const configurationRevision = z.object({ revision: z.string().length(64) })
  const first = configurationRevision.parse((await evidence.get(original.configuration.id))?.event.body).revision
  const reconfiguredBody = (await evidence.get(reconfigured.configuration.id))?.event.body
  expect(reconfiguredBody).toMatchObject({
    kind: 'configuration', previousRevision: first, configuration: { limits: { maxOperations: 5 } },
  })
  expect(configurationRevision.parse(reconfiguredBody).revision).not.toBe(first)
  await stopAll([witnessed, changedAuthority])
  for (const socket of [witnessSocket, authoritySocket, approvalSocketPath]) {
    await expect(lstat(socket)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(`${socket}.lock`)).isFile()).toBe(true)
  }
})

/** An execution provider whose script is one broker request; it prints the authority's reply to that request. */
const executionFixture: Plugin = {
  name: 'execution-fixture.mjs',
  source: `export function apply(ctx) {
  ctx.provide('isolatedExecution', {
    reservedPaths: [],
    open() {
      return {
        ready: Promise.resolve({ fingerprint: 'fixture-execution', maxCommandBytes: 32768, maxOutputBytes: 131072, supportsBroker: true }),
        async run(_session, command, signal, submit) {
          const reply = await submit(JSON.parse(command), signal)
          return {
            exitCode: 0, stdout: JSON.stringify(reply), stderr: '', stdoutTruncated: false, stderrTruncated: false,
            containerId: '${'b'.repeat(64)}', stopped: true,
          }
        },
        async dispose() {},
      }
    },
  })
}
`,
}

it.skipIf(process.platform === 'win32')('reconciles a POST whose response was lost to SIGKILL without sending it again', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dr-'))
  const home = join(root, 'home')
  const children: ReturnType<typeof launch>[] = []
  test.onTestFinished(async () => {
    try {
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(children)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const witnessSocket = join(root, 'w.sock')
  const authoritySocket = join(root, 'a.sock')
  const approvalSocketPath = join(root, 'p.sock')
  const credentialRef = 'DSH_BROKER_CRASH_TOKEN'
  const token = 'fixture-crash-token'
  const arrived = Promise.withResolvers<{
    operationId: string | undefined
    payloadDigest: string | undefined
    authorization: string | undefined
    body: string
  }>()
  let committed: Awaited<typeof arrived.promise> | undefined
  const lookups: Array<{ operationId: string | null; payloadDigest: string | null; authorization: string | undefined }> = []
  let posts = 0
  const { cert, origin } = await httpsFixture(test, root, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://fixture.invalid')
    if (request.method === 'POST' && url.pathname === '/submit') {
      posts++
      let body = ''
      request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
      request.once('end', () => {
        committed = {
          operationId: request.headers['idempotency-key']?.toString(),
          payloadDigest: request.headers['x-dsh-request-digest']?.toString(),
          authorization: request.headers.authorization,
          body,
        }
        arrived.resolve(committed)
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      const operationId = url.searchParams.get('operationId')
      const payloadDigest = url.searchParams.get('payloadDigest')
      lookups.push({ operationId, payloadDigest, authorization: request.headers.authorization })
      if (operationId !== committed?.operationId || payloadDigest !== committed?.payloadDigest) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        operationId, payloadDigest, status: 'succeeded', receiptId: 'fixture-business-receipt',
      }))
      return
    }
    response.writeHead(404).end()
  })
  const endpoint = `${origin}/submit`
  const reconciliationEndpoint = `${origin}/status`
  await Promise.all([
    writeProfile(home, 'witness', witnessSocket, [{
      name: witnessPackage,
      directory: 'packages/experimental/operation-evidence',
      config: { socketPath: witnessSocket, databasePath: join(root, 'w.sqlite') },
    }]),
    writeProfile(home, 'authority', authoritySocket, [
      { name: 'dsh-credentials-local', directory: 'packages/credentials/credentials-local' },
      {
        name: 'dsh-operation-broker', directory: 'packages/experimental/operation-broker',
        config: { routes: [{ action: 'submit', endpoint, reconciliationEndpoint, credentialRef }] },
      },
      executionFixture,
      {
        name: authorityPackage,
        directory: 'packages/experimental/operation-control',
        inject: ['operationBroker'],
        config: {
          socketPath: authoritySocket, approvalSocketPath, evidenceSocketPath: witnessSocket, databasePath: join(root, 'a.sqlite'),
          principalId: 'agent', scopeId: 'business', grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 2, broker: ['operationBroker'],
        },
      },
    ]),
  ])
  const environment = { NODE_EXTRA_CA_CERTS: cert, [credentialRef]: token }
  const authority = start(children, root, home, 'authority', environment)
  await Promise.all([waitUntilReady(authority), waitUntilReady(start(children, root, home, 'witness'))])
  const client = new OperationControlClient({ socketPath: authoritySocket })
  const approver = new OperationControlClient({ socketPath: approvalSocketPath })
  const evidence = new EvidenceClient({ socketPath: witnessSocket })
  const sessionId = SessionId('worker-with-interrupted-dispatch')
  const body = '{"task":"approved external operation"}'
  const command = JSON.stringify({ requestKey: randomUUID(), action: 'submit', body })
  const parent = await approve(approver, await client.propose({ requestKey: randomUUID(), sessionId, command }))
  const reviewing = client.waitReview(parent.id)
  const execution = client.execute(parent.id).then(value => ({ value }), (error: unknown) => ({ error }))
  const pending = await reviewing
  if (pending?.review === undefined) throw new Error('The fixture expected a child approval')
  const { id } = pending
  const { payloadDigest } = pending.review
  expect(pending.review).toMatchObject({ business: { reconciliationEndpoint, body } })
  await approve(approver, pending)
  expect(await arrived.promise).toEqual({ operationId: id, payloadDigest, authorization: `Bearer ${token}`, body })
  expect(await evidence.get(`${id}-outcome`)).toBeUndefined()
  authority.kill('SIGKILL')
  const killed = await authority
  expect(killed.timedOut, killed.stderr).toBe(false)
  expect(killed.signal, killed.stderr).toBe('SIGKILL')
  expect(await execution).toMatchObject({ error: { code: 'authority-unavailable' } })
  await waitUntilReady(start(children, root, home, 'authority', environment))
  const unknown = { kind: 'unknown', code: 'authority-interrupted' }
  expect(await client.overview(sessionId)).toMatchObject({
    reserved: 2, remaining: 0, unknown: 2, businessCompletion: { unconfirmed: 1, succeeded: 0 },
    lastFailure: { id, code: 'authority-interrupted' },
  })
  expect(await evidence.get(`${id}-outcome`)).toBeUndefined()
  expect(await client.businessOperations(sessionId)).toMatchObject({
    operations: [{ id, state: 'unknown', outcome: unknown, businessCompletion: { kind: 'unconfirmed' } }],
  })
  expect(lookups).toEqual([])
  const result = await client.reconcile(sessionId, id)
  expect(result).toMatchObject({
    id, state: 'unknown', outcome: unknown, receipt: { id: `${id}-outcome` }, canReconcile: false,
    businessCompletion: { kind: 'succeeded', receiptId: 'fixture-business-receipt' },
  })
  const lookupReceipt = result.businessCompletion.receipt
  if (lookupReceipt === undefined) throw new Error('The fixture expected reconciliation evidence')
  expect(await evidence.get(lookupReceipt.id)).toMatchObject({ receipt: lookupReceipt, event: { operationId: id, kind: 'outcome' } })
  expect(await evidence.get(lookupReceipt.id.replace(/-outcome$/u, '-admission'))).toMatchObject({
    event: { operationId: id, kind: 'admission', body: { payloadDigest } },
  })
  expect(await client.reconcile(sessionId, id)).toEqual(result)
  expect(await client.status(id)).toMatchObject({ state: 'unknown', outcome: unknown, receipt: result.receipt })
  expect(await client.overview(sessionId)).toMatchObject({
    reserved: 2, unknown: 1, businessCompletion: { unconfirmed: 0, succeeded: 1 },
  })
  expect(lookups).toEqual([{ operationId: id, payloadDigest, authorization: `Bearer ${token}` }])
  expect(posts).toBe(1)
})

it.skipIf(process.platform === 'win32')('calls an approved MCP tool with a token the owner stored and returns its result to the execution', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dr-'))
  const home = join(root, 'home')
  const children: ReturnType<typeof launch>[] = []
  const calls: Array<{ text: string; authorization: string | null | undefined }> = []
  const mcp = createMcpHandler(({ requestInfo }) => {
    const server = new McpServer({ name: 'authority-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.registerTool('post_note', { description: 'Stores a note.', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => {
      calls.push({ text, authorization: requestInfo?.headers.get('authorization') })
      return { content: [{ type: 'text', text: `stored ${text}` }] }
    })
    return server
  })
  test.onTestFinished(async () => {
    try {
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(children)
      await mcp.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const handle = toNodeHandler(mcp)
  const { cert, origin } = await httpsFixture(test, root, (request, response) => {
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => { response.writeHead(500).end(String(error)) })
  })
  const witnessSocket = join(root, 'w.sock')
  const authoritySocket = join(root, 'a.sock')
  const approvalSocketPath = join(root, 'p.sock')
  const url = `${origin}/mcp`
  const mainSessionId = SessionId('main')
  const permissions = {
    exec: true, brokerActions: ['post-note'],
    data: { import: false, export: false, discloseToModel: false, discloseToUser: false, returnResponses: true },
  }
  const credentialRef = 'DSH_MCP_NOTES_TOKEN'
  const token = 'fixture-mcp-token'
  await Promise.all([
    writeProfile(home, 'witness', witnessSocket, [{
      name: witnessPackage,
      directory: 'packages/experimental/operation-evidence',
      config: { socketPath: witnessSocket, databasePath: join(root, 'w.sqlite') },
    }]),
    writeProfile(home, 'authority', authoritySocket, [
      { name: 'dsh-credentials-local', directory: 'packages/credentials/credentials-local' },
      {
        name: 'dsh-operation-broker', entry: 'mcp', directory: 'packages/experimental/operation-broker',
        config: { servers: [{ url, credentialRef, tools: [{ action: 'post-note', tool: 'post_note', returnResponse: true }] }] },
      },
      executionFixture,
      {
        name: authorityPackage,
        directory: 'packages/experimental/operation-control',
        inject: ['operationBrokerMcp'],
        config: {
          socketPath: authoritySocket, approvalSocketPath, evidenceSocketPath: witnessSocket, databasePath: join(root, 'a.sqlite'),
          principalId: 'agent', scopeId: 'business', grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 3, broker: ['operationBrokerMcp'],
          assistant: { mainSessionId, permissions },
        },
      },
    ]),
  ])
  const authority = start(children, root, home, 'authority', { NODE_EXTRA_CA_CERTS: cert })
  await Promise.all([waitUntilReady(authority), waitUntilReady(start(children, root, home, 'witness'))])
  const client = new OperationControlClient({ socketPath: authoritySocket })
  const approver = new OperationControlClient({ socketPath: approvalSocketPath })
  const evidence = new EvidenceClient({ socketPath: witnessSocket })
  expect(await approver.brokerConnections()).toMatchObject({ connections: [{ action: 'post-note', credentialRef, configured: false, returnsResponse: true }] })
  expect(await approver.setBrokerConnection({ action: 'post-note', value: token })).toMatchObject({ connections: [{ configured: true }] })

  const sessionId = SessionId('worker-calling-a-tool')
  const workId = workIdSchema.parse('d'.repeat(64))
  const delegation = await client.propose({
    requestKey: workId, sessionId: mainSessionId,
    handoff: { kind: 'delegation', targetSessionId: sessionId, content: 'Store the note.', delegation: { workId, previousWorkId: null, permissions } },
  })
  expect(await client.execute(delegation.id)).toMatchObject({ state: 'settled', outcome: { work: { workId, sessionId, permissions } } })
  const body = '{"text":"hello"}'
  const command = JSON.stringify({ requestKey: randomUUID(), action: 'post-note', body })
  const parent = await approve(approver, await client.propose({ requestKey: randomUUID(), sessionId, command }))
  const reviewing = client.waitReview(parent.id)
  const execution = client.execute(parent.id)
  const pending = await reviewing
  if (pending?.review === undefined) throw new Error('The fixture expected a child approval')
  expect(pending.review).toMatchObject({ business: { action: 'post-note', tool: 'post_note', endpoint: url, body } })
  expect(calls).toEqual([])
  await approve(approver, pending)
  const settled = await execution
  if (settled.outcome?.kind !== 'exited') throw new Error('The fixture expected a completed execution')
  expect(JSON.parse(settled.outcome.observation.stdout)).toMatchObject({ id: pending.id, toolError: false, body: 'stored hello' })
  expect(calls).toEqual([{ text: 'hello', authorization: `Bearer ${token}` }])
  expect(await evidence.get(`${pending.id}-admission`)).toMatchObject({ event: { body: { tool: 'post_note' } } })
  expect(await evidence.get(`${pending.id}-outcome`)).toMatchObject({ event: { body: { kind: 'business-response', toolError: false } } })
})

const vmImage = process.env.DSH_EXEC_VM_TEST_IMAGE

function vmNameFor(gatewaySocket: string, home: string, principalId: string, scopeId: string, sessionId: SessionId): string {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
  const namespace = JSON.stringify([home, principalId, scopeId])
  return `dsh-vm-${sha256(gatewaySocket).slice(0, 12)}-${sha256(JSON.stringify([namespace, sessionId])).slice(0, 32)}`
}

async function removeTestVm(vmCommand: string, vmName: string): Promise<void> {
  const { stdout } = await execa(vmCommand, ['list', '--all', '--quiet'], { timeout: 10_000 })
  if (stdout.split('\n').includes(vmName)) await execa(vmCommand, ['delete', '--force', vmName], { timeout: 10_000 })
}

it.skipIf(process.platform !== 'darwin' || vmImage === undefined)(
  'routes one witnessed operation through the Apple VM gateway and retains the workspace after restart',
  async (test) => {
    if (vmImage === undefined) throw new Error('The operation smoke needs a preloaded Apple container image')
    const root = await mkdtemp(join(tmpdir(), 'dv-'))
    const home = join(root, 'home')
    const witnessSocket = join(root, 'w.sock')
    const authoritySocket = join(root, 'a.sock')
    const approvalSocketPath = join(root, 'p.sock')
    const gatewaySocket = join(root, 'g.sock')
    const principalId = 'agent'
    const scopeId = 'vm'
    const sessionId = SessionId(randomUUID())
    const vmCommand = process.env.DSH_EXEC_VM_TEST_COMMAND ?? 'container'
    const vmName = vmNameFor(gatewaySocket, home, principalId, scopeId, sessionId)
    const children: ReturnType<typeof launch>[] = []
    let hits = 0
    const target = createServer((_request, response) => {
      hits++
      response.end('via-gateway')
    })
    test.onTestFinished(async () => {
      try {
        for (const child of children) child.kill('SIGKILL')
        await Promise.all(children)
        await removeTestVm(vmCommand, vmName)
      } finally {
        target.closeAllConnections()
        await Promise.all([
          new Promise<void>((resolve) => { target.close(() => { resolve() }) }),
          rm(root, { recursive: true, force: true }),
        ])
      }
    })
    await new Promise<void>((resolve, reject) => target.once('error', reject).listen(0, '127.0.0.1', resolve))
    const address = target.address()
    if (address === null || typeof address === 'string') throw new Error('The test gateway target is not listening')
    const allowedTarget = `127.0.0.1:${address.port}`
    await Promise.all([
      writeProfile(home, 'witness', witnessSocket, [{
        name: witnessPackage,
        directory: 'packages/experimental/operation-evidence',
        config: { socketPath: witnessSocket, databasePath: join(root, 'w.sqlite') },
      }]),
      writeProfile(home, 'authority', authoritySocket, [
        { name: subprocessPackage, directory: 'packages/subprocess/subprocess-local' },
        {
          name: executionPackage,
          directory: 'packages/experimental/execution-container',
          config: {
            backend: 'apple-vm', vmCommand, image: vmImage, gatewaySocket, allowedTargets: [allowedTarget],
            timeoutMs: 30_000, stopTimeoutMs: 8_000,
          },
        },
        {
          name: authorityPackage,
          directory: 'packages/experimental/operation-control',
          config: {
            socketPath: authoritySocket, approvalSocketPath, evidenceSocketPath: witnessSocket, databasePath: join(root, 'a.sqlite'),
            principalId, scopeId, grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 2,
          },
        },
      ]),
    ])
    const authority = start(children, root, home, 'authority')
    await Promise.all([waitUntilReady(authority), waitUntilReady(start(children, root, home, 'witness'))])
    const client = new OperationControlClient({ socketPath: authoritySocket })
    const approver = new OperationControlClient({ socketPath: approvalSocketPath })
    const evidence = new EvidenceClient({ socketPath: witnessSocket })
    const proposal = { requestKey: randomUUID(), sessionId, command: `
set -eu
test "$(ls /sys/class/net)" = lo
node <<'NODE'
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
net.connect(${address.port}, '127.0.0.1').on('connect', () => {
  throw new Error('The VM reached the target directly')
}).on('error', error => assert.equal(error.code, 'ECONNREFUSED'))
http.request({ host: '127.0.0.1', port: 3128, method: 'CONNECT', path: '${allowedTarget}', agent: false })
  .on('connect', (response, socket) => {
    assert.equal(response.statusCode, 200)
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => {
      assert.match(data, /via-gateway/)
      process.stdout.write('via-gateway')
    })
    socket.write('GET / HTTP/1.0\\r\\n\\r\\n')
  }).end()
NODE
printf x >> evidence
` }
    const pending = await client.propose(proposal)
    expect(pending).toMatchObject({ state: 'pending-approval', review: { command: proposal.command, sessionId } })
    expect(await client.execute(pending.id)).toEqual(pending)
    expect(hits).toBe(0)
    const { id, state } = await approve(approver, pending)
    expect(state).toBe('issued')
    const outcome = await client.execute(id)
    expect(outcome).toMatchObject({
      state: 'settled', outcome: { kind: 'exited', observation: { exitCode: 0, stdout: 'via-gateway', stopped: true } },
    })
    expect((await evidence.get(`${id}-outcome`))?.receipt).toEqual(outcome.receipt)
    expect(await client.propose(proposal)).toEqual(outcome)
    expect(await client.execute(id)).toEqual(outcome)
    expect(hits).toBe(1)

    authority.kill('SIGTERM')
    const stopped = await authority
    expect(stopped.exitCode, stopped.stderr).toBe(0)
    const restarted = start(children, root, home, 'authority')
    await waitUntilReady(restarted)
    expect(await client.status(id)).toEqual(outcome)
    const continuation = await client.propose({ requestKey: randomUUID(), sessionId, command: 'cat evidence' })
    expect(await approve(approver, continuation)).toMatchObject({ state: 'issued' })
    expect(await client.execute(continuation.id)).toMatchObject({
      state: 'settled', outcome: { kind: 'exited', observation: { exitCode: 0, stdout: 'x', stopped: true } },
    })
    expect(hits).toBe(1)
  },
)

const dockerSocket = process.env.DSH_EXEC_TEST_SOCKET
const dockerImage = process.env.DSH_EXEC_TEST_IMAGE
// One of the execution provider's Docker runtime names; omit for its default.
const dockerRuntime = process.env.DSH_EXEC_TEST_RUNTIME

function containerNameFor(home: string, principalId: string, scopeId: string, sessionId: SessionId): string {
  const namespace = JSON.stringify([home, principalId, scopeId])
  return `dsh-exec-${createHash('sha256').update(JSON.stringify([namespace, sessionId])).digest('hex').slice(0, 32)}`
}

/** A real work guest for the business case: its execution provider config and how to remove it afterwards. */
interface BusinessGuest {
  readonly config: (gatewaySocket: string) => Record<string, unknown>
  readonly remove: (gatewaySocket: string, home: string, principalId: string, scopeId: string, sessionId: SessionId) => Promise<void>
}

const appleVmGuest: BusinessGuest = {
  config: gatewaySocket => ({
    backend: 'apple-vm', vmCommand: process.env.DSH_EXEC_VM_TEST_COMMAND ?? 'container', image: vmImage, gatewaySocket, timeoutMs: 30_000, stopTimeoutMs: 8_000,
  }),
  remove: (gatewaySocket, home, principalId, scopeId, sessionId) =>
    removeTestVm(process.env.DSH_EXEC_VM_TEST_COMMAND ?? 'container', vmNameFor(gatewaySocket, home, principalId, scopeId, sessionId)),
}

const dockerGuest: BusinessGuest = {
  config: gatewaySocket => ({
    backend: 'docker', dockerSocket, image: dockerImage, gatewaySocket, timeoutMs: 60_000, stopTimeoutMs: 15_000,
    ...dockerRuntime === undefined ? {} : { runtime: dockerRuntime },
  }),
  async remove(_gatewaySocket, home, principalId, scopeId, sessionId) {
    if (dockerSocket === undefined) return
    const docker = (...args: string[]) => execa('docker', ['--host', `unix://${dockerSocket}`, ...args], { timeout: 30_000 })
    const { stdout } = await docker('container', 'ls', '-aq', '--filter', `name=^/${containerNameFor(home, principalId, scopeId, sessionId)}$`)
    if (stdout) await docker('container', 'rm', '-fv', stdout)
  },
}

it.skipIf(process.platform !== 'darwin' || vmImage === undefined)(
  'limits a real VM to its work grant and posts only the approved HTTPS request',
  test => businessCase(test, appleVmGuest),
)

it.skipIf(process.platform !== 'linux' || dockerSocket === undefined || dockerImage === undefined)(
  'limits a real Docker container to its work grant and posts only the approved HTTPS request',
  test => businessCase(test, dockerGuest),
  180_000,
)

async function businessCase(test: TestContext, guest: BusinessGuest): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'db-'))
  const home = join(root, 'home')
  const witnessSocket = join(root, 'w.sock')
  const authoritySocket = join(root, 'a.sock')
  const approvalSocketPath = join(root, 'p.sock')
  const gatewaySocket = join(root, 'g.sock')
  const principalId = 'agent'
  const scopeId = 'business'
  const mainSessionId = SessionId('assistant-main')
  const sessionId = SessionId(randomUUID())
  const workId = workIdSchema.parse(createHash('sha256').update(sessionId).digest('hex'))
  const children: ReturnType<typeof launch>[] = []
  test.onTestFinished(async () => {
    try {
      for (const child of children) child.kill('SIGKILL')
      await Promise.all(children)
      await guest.remove(gatewaySocket, home, principalId, scopeId, sessionId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
  const received: { authorization: string | undefined; body: string }[] = []
  const { cert, origin } = await httpsFixture(test, root, (request, response) => {
    let body = ''
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk })
    request.once('end', () => {
      received.push({ authorization: request.headers.authorization, body })
      response.writeHead(202).end('fixture response body is not released')
    })
  })
  const endpoint = `${origin}/submit`
  const credentialRef = 'DSH_BROKER_E2E_TOKEN'
  const token = 'fixture-broker-token'
  await Promise.all([
    writeProfile(home, 'witness', witnessSocket, [{
      name: witnessPackage,
      directory: 'packages/experimental/operation-evidence',
      config: { socketPath: witnessSocket, databasePath: join(root, 'w.sqlite') },
    }]),
    writeProfile(home, 'authority', authoritySocket, [
      { name: subprocessPackage, directory: 'packages/subprocess/subprocess-local' },
      { name: 'dsh-credentials-local', directory: 'packages/credentials/credentials-local' },
      {
        name: 'dsh-operation-broker', directory: 'packages/experimental/operation-broker',
        config: { routes: [
          { action: 'submit', description: 'Submit the fixture request.', endpoint, credentialRef },
          { action: 'blocked', endpoint, credentialRef },
          { action: 'unpermitted', endpoint, credentialRef },
        ] },
      },
      {
        name: 'dsh-operation-broker', entry: 'mcp', directory: 'packages/experimental/operation-broker',
        config: { servers: [{ url: `${origin}/mcp`, credentialRef, tools: [
          { action: 'create-note', tool: 'create_note', description: 'Create one note. The body is {"text": string}.' },
        ] }] },
      },
      {
        name: executionPackage,
        directory: 'packages/experimental/execution-container',
        config: guest.config(gatewaySocket),
      },
      {
        name: authorityPackage,
        directory: 'packages/experimental/operation-control',
        inject: ['operationBroker', 'operationBrokerMcp'],
        config: {
          socketPath: authoritySocket, approvalSocketPath, evidenceSocketPath: witnessSocket, databasePath: join(root, 'a.sqlite'),
          principalId, scopeId, grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 3,
          broker: ['operationBroker', 'operationBrokerMcp'],
          assistant: { mainSessionId, permissions: { exec: true, brokerActions: ['submit', 'blocked', 'create-note'] } },
        },
      },
    ]),
  ])
  const authority = start(children, root, home, 'authority', { NODE_EXTRA_CA_CERTS: cert, [credentialRef]: token })
  await Promise.all([waitUntilReady(authority), waitUntilReady(start(children, root, home, 'witness'))])
  const client = new OperationControlClient({ socketPath: authoritySocket })
  const approver = new OperationControlClient({ socketPath: approvalSocketPath })
  const evidence = new EvidenceClient({ socketPath: witnessSocket })
  expect(await client.businessActions()).toEqual({
    actions: [
      { action: 'blocked' },
      { action: 'create-note', description: 'Create one note. The body is {"text": string}.' },
      { action: 'submit', description: 'Submit the fixture request.' },
    ],
  })
  await expect(client.brokerConnections()).rejects.toMatchObject({ code: 'approval-forbidden' })
  expect(await approver.brokerConnections()).toMatchObject({ unattendedShell: false, connections: [
    { action: 'blocked', credentialRef, configured: true, returnsResponse: false, unattended: [], routeChangedSinceRulesSaved: false },
    expect.objectContaining({ action: 'create-note', credentialRef, configured: true, unattended: [], routeChangedSinceRulesSaved: false }),
    {
      action: 'submit', description: 'Submit the fixture request.', credentialRef, configured: true, returnsResponse: false, unattended: [],
      routeChangedSinceRulesSaved: false,
    },
  ] })
  await expect(approver.setBrokerConnection({ action: 'unpermitted', value: token })).rejects.toMatchObject({ code: 'broker-action-unavailable' })
  await expect(approver.setBrokerConnection({ action: 'submit', value: 'not a bearer token' })).rejects.toMatchObject({ code: 'broker-credential-invalid' })
  expect(await approver.setBrokerConnection({ action: 'submit', value: token })).toMatchObject({ connections: [{}, {}, { action: 'submit', configured: true }] })
  const permissions = { exec: true, brokerActions: ['submit'] }
  const delegation = await client.propose({
    requestKey: workId, sessionId: mainSessionId,
    handoff: { kind: 'delegation', targetSessionId: sessionId, content: 'Submit the fixture request.', delegation: {
      workId, previousWorkId: null, permissions,
    } },
  })
  await expect(client.execute(delegation.id)).resolves.toMatchObject({
    state: 'settled', outcome: { work: { workId, principalId, sessionId, permissions } },
  })
  const body = '{\n  "text": "exact business request"\n}'
  const request = { requestKey: randomUUID(), action: 'submit', body }
  const blockedRequest = { requestKey: randomUUID(), action: 'blocked', body }
  const shell = await client.propose({ requestKey: randomUUID(), sessionId, command: `
set -eu
test -z "\${${credentialRef}-}"
node <<'NODE'
const http = require('node:http')
const assert = require('node:assert/strict')
function submit(input) {
  const body = JSON.stringify(input)
  return new Promise((resolve, reject) => {
    const request = http.request(process.env.DSH_BROKER_URL, {
      method: 'POST', agent: false, headers: {
        authorization: 'Bearer ' + process.env.DSH_BROKER_TOKEN,
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, response => {
      let data = ''
      response.on('error', reject)
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200)
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}
async function run() {
  const blocked = await submit(${JSON.stringify(blockedRequest)})
  assert.equal(blocked.code, 'work-permission-denied')
  process.stdout.write(blocked.code + '\\n')
  const allowed = await submit(${JSON.stringify(request)})
  assert.equal(allowed.status, 202)
  assert.deepEqual(Object.keys(allowed).sort(), ['id', 'receipt', 'status'])
  process.stdout.write(String(allowed.status))
}
run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
NODE
` })
  expect(shell).toMatchObject({ state: 'pending-approval', review: { sessionId, workId, principalId } })
  const parent = await approve(approver, shell)
  const execution = client.execute(parent.id)
  const ended = execution.then(result => ({ result }))
  let pending: OperationStatus | undefined
  while (pending === undefined) {
    const next = await Promise.race([client.waitReview(parent.id).then(review => ({ review })), ended])
    if ('result' in next) throw new Error(`The VM exited before submitting a business review: ${JSON.stringify(next.result)}`)
    pending = next.review
  }
  expect(pending).toMatchObject({
    state: 'pending-approval', review: { sessionId, workId, principalId, business: { parentId: parent.id, action: 'submit', endpoint, body } },
  })
  expect(received).toEqual([])
  await expect(client.execute(pending.id)).rejects.toMatchObject({ code: 'broker-execute-forbidden' })
  expect(await approve(approver, pending)).toMatchObject({ state: 'issued' })
  expect(await execution).toMatchObject({
    state: 'settled', outcome: { kind: 'exited', observation: { exitCode: 0, stdout: 'work-permission-denied\n202' } },
  })
  expect(received).toEqual([{ authorization: `Bearer ${token}`, body }])
  const business = await client.businessOperations(sessionId)
  expect(business.operations.map(({ id }) => id)).toEqual([pending.id])
  const settled = await client.status(pending.id)
  expect(settled).toMatchObject({ state: 'settled', outcome: { kind: 'business-response', statusCode: 202 } })
  expect(await evidence.get(`${pending.id}-admission`)).toMatchObject({ event: { body: { parentId: parent.id, action: 'submit', endpoint } } })
  expect((await evidence.get(`${pending.id}-outcome`))?.receipt).toEqual(settled.receipt)
}
