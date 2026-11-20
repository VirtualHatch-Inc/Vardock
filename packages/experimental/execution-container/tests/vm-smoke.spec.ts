/** Opt-in smoke test for the real Apple container runtime and VM gateway. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, type TestContext } from 'vitest'
import { AppleVmConfig, AppleVmExecutor } from '../src/vm.ts'

const image = process.env.DSH_EXEC_VM_TEST_IMAGE
const command = process.env.DSH_EXEC_VM_TEST_COMMAND ?? 'container'
const spawn = promisify(execFile)

async function boot(test: TestContext, allowedTargets: string[] = []) {
  if (image === undefined) throw new Error('Apple VM smoke needs a preloaded image')
  const host = async (...args: string[]) => (await spawn(command, args, { timeout: 10_000 })).stdout.trim()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vm-'))
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const session = SessionId(randomUUID())
  const namespace = randomUUID()
  const owner = createHash('sha256').update(JSON.stringify([namespace, session])).digest('hex')
  const gatewaySocket = join(directory, 'gateway.sock')
  const gatewayOwner = createHash('sha256').update(gatewaySocket).digest('hex')
  const id = `dsh-vm-${gatewayOwner.slice(0, 12)}-${owner.slice(0, 32)}`
  test.onTestFinished(async () => {
    if ((await host('list', '--all', '--quiet')).split('\n').includes(id)) {
      await host('delete', '--force', id)
    }
  })
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocess)
  const config = AppleVmConfig({
    vmCommand: command, image, gatewaySocket, allowedTargets, timeoutMs: 25_000, stopTimeoutMs: 8_000,
  }) as Required<AppleVmConfig>
  const executor = new AppleVmExecutor(ctx, config, namespace)
  test.onTestFinished(() => executor.dispose())
  await executor.ready
  return { host, id, session, namespace, config, executor, ctx }
}

it.skipIf(process.platform !== 'darwin' || image === undefined)(
  'runs with only loopback, tunnels to one approved destination, and retains stopped Session storage',
  async (test) => {
    const target = createServer((_request, response) => response.end('via-gateway'))
    test.onTestFinished(() => new Promise<void>((resolve, reject) => {
      target.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    }))
    await new Promise<void>((resolve, reject) => target.once('error', reject).listen(0, '127.0.0.1', resolve))
    const address = target.address()
    if (address === null || typeof address === 'string') throw new Error('Could not start the smoke target')
    const allowedTarget = `127.0.0.1:${address.port}`
    const { host, id, session, namespace, config, executor, ctx } = await boot(test, [allowedTarget])
    const signal = new AbortController().signal
    const observed = await executor.run(session, `
set -eu
test "$(id -u)" -eq 65532
test "$(ls /sys/class/net)" = lo
test "$(pwd)" = /workspace
test -S /run/dsh-gateway.sock
test ! -S /var/run/docker.sock
node <<'NODE'
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const options = { host: '127.0.0.1', port: 3128, method: 'CONNECT', agent: false }
http.request({ ...options, path: '${allowedTarget}' }).on('connect', (response, socket) => {
  assert.equal(response.statusCode, 200)
  let data = ''
  socket.on('data', chunk => { data += chunk })
  socket.on('end', () => assert.match(data, /via-gateway/))
  socket.write('GET / HTTP/1.0\\r\\n\\r\\n')
}).end()
http.request({ ...options, path: 'denied.invalid:443' }).on('connect', (response, socket) => {
  assert.equal(response.statusCode, 403)
  socket.destroy()
}).end()
net.connect(443, '1.1.1.1').on('connect', () => {
  throw new Error('The VM has direct egress')
}).on('error', error => assert.equal(error.code, 'ENETUNREACH'))
NODE
printf 'retained' > evidence
(sleep 2; touch escaped) </dev/null >/dev/null 2>&1 &
printf 'isolated'
`, signal)
    expect(observed).toMatchObject({ exitCode: 0, stdout: 'isolated', stopped: true })
    const inspection: unknown = JSON.parse(await host('inspect', id))
    expect(inspection).toMatchObject([{ id, status: { state: 'stopped', networks: [] } }])
    await host('start', id)
    await executor.dispose()
    const resumed = new AppleVmExecutor(ctx, config, namespace)
    test.onTestFinished(() => resumed.dispose())
    await resumed.ready
    await expect(resumed.run(session, 'touch replayed', signal)).rejects.toMatchObject({ code: 'EXEC_PREVIOUS_UNKNOWN' })
    expect(await resumed.run(session, 'test ! -e escaped && test ! -e replayed && cat evidence', signal))
      .toMatchObject({ exitCode: 0, stdout: 'retained', containerId: observed.containerId, stopped: true })
  },
  50_000,
)

it.skipIf(process.platform !== 'darwin' || image === undefined)(
  'copies binary input and a selected artifact through separate, stopped VM invocations',
  async (test) => {
    const { executor, host, id, session } = await boot(test)
    const signal = new AbortController().signal
    const data = Buffer.from([0, 10, 13, 128, 255])
    const digest = createHash('sha256').update(data).digest('hex')
    const path = `input/sha256:${digest}/source.bin`
    await expect(executor.transfer(session, { kind: 'import', path, data, maxBytes: data.length }, signal))
      .resolves.toEqual({ kind: 'imported', bytes: data.length, digest })
    expect(JSON.parse(await host('inspect', id))).toMatchObject([{ status: { state: 'stopped' } }])
    expect(await executor.run(session, `set -e; cp '${path}' artifact.bin; ln -s /etc/passwd outside`, signal))
      .toMatchObject({ exitCode: 0, stopped: true })
    await expect(executor.transfer(session, { kind: 'export', path: 'artifact.bin', maxBytes: data.length }, signal))
      .resolves.toEqual({ kind: 'exported', bytes: data.length, digest, data })
    await expect(executor.transfer(session, { kind: 'export', path: 'outside', maxBytes: data.length }, signal))
      .rejects.toMatchObject({ code: 'EXEC_TRANSFER_FILE' })
    expect(JSON.parse(await host('inspect', id))).toMatchObject([{ status: { state: 'stopped' } }])
  },
  50_000,
)

it.skipIf(process.platform !== 'darwin' || image === undefined)(
  'carries a business request from the real VM and refuses the saved credential on the next shell call',
  async (test) => {
    const { executor, session } = await boot(test)
    const signal = new AbortController().signal
    const received: unknown[] = []
    const observed = await executor.run(session, `
set -eu
test -n "$DSH_BROKER_TOKEN"
printf '%s' "$DSH_BROKER_TOKEN" > saved-credential
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
const response = await fetch(process.env.DSH_BROKER_URL, {
  method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.DSH_BROKER_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'smoke' }),
})
assert.equal(response.status, 200)
assert.deepEqual(await response.json(), { accepted: true })
NODE
`, signal, (request) => {
      received.push(request)
      return Promise.resolve({ accepted: true })
    })
    expect(observed).toMatchObject({ exitCode: 0, stderr: '', stopped: true })
    expect(received).toEqual([{ action: 'smoke' }])
    const resumed = await executor.run(session, `
set -e
test -z "$DSH_BROKER_TOKEN"
test -z "$DSH_BROKER_URL"
NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const response = await fetch('http://127.0.0.1:3128/business', {
  method: 'POST', headers: { authorization: 'Bearer ' + readFileSync('saved-credential', 'utf8') }, body: '{}',
})
assert.equal(response.status, 403)
await response.text()
NODE
`, signal)
    expect(resumed).toMatchObject({ exitCode: 0, stderr: '', stopped: true, containerId: observed.containerId })
    expect(received).toHaveLength(1)
  },
  50_000,
)
