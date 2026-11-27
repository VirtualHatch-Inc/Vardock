/** Start the practice service with a real operation authority and witness, each through its own dsh profile. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { OperationControlClient } from '@deepseek-ai/dsh-operation-control/library'
import { EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import { execa } from 'execa'
import type { TestContext } from 'vitest'

const example = fileURLToPath(new URL('../', import.meta.url))
const repo = fileURLToPath(new URL('../../../', import.meta.url))

/** Work permissions the authority's Assistant ceiling grants in this example. */
export const practicePermissions = {
  exec: true, brokerActions: ['list-items', 'set-quantity'],
  data: { import: false, export: false, discloseToModel: true, discloseToUser: true, returnResponses: true },
}

/**
 * Start the practice inventory, an authority and a witness for one test, and stop them when it finishes.
 * @param test - owner of the processes and the temporary directory.
 * @param mainSessionId - entrance Session the authority's Assistant grant names.
 * @returns sockets, clients, the printed setup command, and a direct read of the inventory.
 */
export async function startPracticeStack(test: TestContext, mainSessionId = 'assistant-main') {
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
    return execa(invocation.command, invocation.args, {
      cwd: example, env: invocation.env, extendEnv: false, stdin: 'ignore', reject: false, timeout: 80_000, killSignal: 'SIGKILL',
    })
  }
  async function ready(child: ReturnType<typeof launch>, marker: string) {
    const lines = createInterface({ input: child.stdout })
    const signal = Promise.withResolvers<string>()
    lines.on('line', (line) => { if (line.startsWith(marker)) signal.resolve(line) })
    try {
      return await Promise.race([signal.promise, child.then((result) => { throw new Error(`Profile exited before readiness: ${result.stderr}\n${result.stdout}`) })])
    } finally { lines.close() }
  }

  const service = launch(example, 'practice')
  children.push(service)
  const setup = await ready(service, 'pnpm vardock setup ')
  const permitActions = [...setup.matchAll(/--permit-action ([a-z-]+)/gu)].map(match => match[1])
  const patchPath = join(home, 'authority.patch.yml')
  const operationSocket = join(root, 'operation.sock')
  const approvalSocket = join(root, 'approval.sock')
  const witnessSocket = join(root, 'evidence.sock')
  const execution = join(root, 'execution.mjs')
  // The test execution provider reads each command as one broker submission and returns the authority's reply.
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
  const authorityEntries = applyEntryPatches([
    { id: 'credentials', name: join(repo, 'packages/credentials/credentials-local/src/index.ts') },
    { id: 'operation-broker', name: join(repo, 'packages/experimental/operation-broker/src/index.ts'), config: { routes: [] } },
    { id: 'execution', name: execution },
    { id: 'operation-control', name: join(repo, 'packages/experimental/operation-control/src/index.ts'), inject: ['operationBroker'], config: {
      principalId: 'owner', scopeId: 'offline-shell', socketPath: operationSocket, approvalSocketPath: approvalSocket,
      evidenceSocketPath: witnessSocket, databasePath: join(root, 'authority.sqlite'),
      grantExpiresAt: Number.MAX_SAFE_INTEGER, maxOperations: 1000, broker: ['operationBroker'], unattendedShell: true,
      assistant: { mainSessionId, permissions: { ...practicePermissions, brokerActions: permitActions } },
    } },
    { id: 'ready', name: readiness, config: { socket: operationSocket } },
  ], loadOverlayPatches('practice', patchPath), (format, ...args) => { throw new Error(`${format} ${args.join(' ')}`) })
  for (const [profileHome, profileName, entries] of [
    [join(root, 'authority'), 'authority', authorityEntries],
    [join(root, 'witness'), 'witness', [
      { name: join(repo, 'packages/experimental/operation-evidence/src/index.ts'), config: { socketPath: witnessSocket, databasePath: join(root, 'witness.sqlite') } },
      { id: 'ready', name: readiness, config: { socket: witnessSocket } },
    ]],
  ] as const) {
    const profilePath = join(profileHome, 'profiles', profileName)
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }))
    await writeFile(join(profilePath, 'cordis.patch.yml'), JSON.stringify([{ insert: entries }]))
  }
  const authority = launch(join(root, 'authority'), 'authority')
  const witness = launch(join(root, 'witness'), 'witness')
  children.push(authority, witness)
  await Promise.all([ready(authority, 'operation-service-ready'), ready(witness, 'operation-service-ready')])
  const approver = new OperationControlClient({ socketPath: approvalSocket })
  await approver.setBrokerConnection({ action: 'list-items', value: 'practice-only-token' })
  const ca = await readFile(join(home, 'server.pem'))

  /** Read the inventory from the service itself, bypassing the authority, the broker and every report. */
  const inventory = () => new Promise<Record<string, number>>((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port: 19443, path: '/items', method: 'POST', ca,
      headers: { authorization: 'Bearer practice-only-token', 'content-type': 'application/json' } }, (response) => {
      let text = ''
      response.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
      response.once('end', () => {
        const { items } = JSON.parse(text) as { items: { sku: string; quantity: number }[] }
        resolve(Object.fromEntries(items.map(({ sku, quantity }) => [sku, quantity])))
      })
    })
    call.once('error', reject)
    call.end('{}')
  })
  return {
    setup, patchPath, home, permitActions, operationSocket, approvalSocket, inventory, approver,
    client: new OperationControlClient({ socketPath: operationSocket }), evidence: new EvidenceClient({ socketPath: witnessSocket }),
  }
}
