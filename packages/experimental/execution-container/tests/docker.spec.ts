/** Exercise the authority's runner against an isolated Linux Docker daemon. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi, type TestContext } from 'vitest'
import { ContainerExecutor, DockerConfig, type DockerRuntime, type ResolvedDockerConfig } from '../src/docker.ts'
import { renderExecutionObservation } from '../src/tool.ts'

const dockerSocket = process.env.DSH_EXEC_TEST_SOCKET
const image = process.env.DSH_EXEC_TEST_IMAGE
// One of the supported OCI runtime names; the daemon must have it registered. Omit for runc.
const requestedRuntime = process.env.DSH_EXEC_TEST_RUNTIME
const { runtime } = DockerConfig({
  dockerSocket: '/unused.sock', image: 'unused:local',
  ...requestedRuntime === undefined ? {} : { runtime: requestedRuntime as DockerRuntime },
}) as ResolvedDockerConfig
const spawn = promisify(execFile)
// Each call spawns about six Docker CLI processes, which take seconds on a loaded test host; these deadlines cover them.
const timeoutMs = 30_000
const stopTimeoutMs = 15_000
// Guest checks avoid /sys/class/net and cgroup files, which runsc does not expose.

async function boot(test: TestContext, config: DockerConfig, home: string) {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocess)
  const executor = new ContainerExecutor(ctx, DockerConfig(config) as ResolvedDockerConfig, home)
  test.onTestFinished(() => executor.dispose())
  return executor
}

function dockerCli(socket: string) {
  return async (...args: string[]) => (await spawn('docker', ['--host', `unix://${socket}`, ...args], { timeout: stopTimeoutMs })).stdout.trim()
}

function sessionContainer(session: SessionId, home: string): string {
  return `dsh-exec-${createHash('sha256').update(JSON.stringify([home, session])).digest('hex').slice(0, 32)}`
}

it('fails startup when the configured Docker executable is missing', async (test) => {
  const executor = await boot(test, {
    command: join(tmpdir(), randomUUID(), 'docker'),
    dockerSocket: '/unused.sock',
    image: 'unused:local',
  }, tmpdir())
  await expect(executor.ready).rejects.toThrow('is not an executable file')
})

it.skipIf(dockerSocket === undefined || image === undefined)(
  'keeps Session files across authority restarts and stops cancelled and interrupted commands',
  async (test) => {
    if (dockerSocket === undefined || image === undefined) throw new Error('Docker smoke needs a socket and a preloaded image')
    const docker = dockerCli(dockerSocket)
    const first = SessionId(randomUUID())
    const second = SessionId(randomUUID())
    const foreign = SessionId(randomUUID())
    const home = join(tmpdir(), randomUUID())
    const otherHome = join(tmpdir(), randomUUID())
    const firstContainer = sessionContainer(first, home)
    const foreignContainer = sessionContainer(foreign, home)
    for (const name of [firstContainer, sessionContainer(second, home), sessionContainer(first, otherHome), foreignContainer]) {
      test.onTestFinished(async () => {
        const id = await docker('container', 'ls', '-aq', '--filter', `name=^/${name}$`)
        if (id) await docker('container', 'rm', '-fv', id)
      }, 2 * stopTimeoutMs)
    }

    const config = { dockerSocket, image, runtime, timeoutMs, stopTimeoutMs, maxOutputBytes: 512 }
    const initial = await boot(test, config, home)
    await initial.ready
    const signal = new AbortController().signal
    const isolation = await initial.run(first, `
set -eu
test "$(id -u)" -eq 65532
node -e "if (Object.keys(require('node:os').networkInterfaces()).join() !== 'lo') process.exit(1)"
test ! -S /var/run/docker.sock
test "$(pwd)" = /workspace
test "$HOME" = /workspace
if touch /outside; then exit 72; fi
grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status
grep -q '^CapEff:[[:space:]]*0*$' /proc/self/status
test "$(grep -v '^#' /etc/resolv.conf | grep .)" = 'nameserver 127.0.0.1'
printf 'retained' > evidence
(sleep 2; touch escaped) </dev/null >/dev/null 2>&1 &
printf 'isolated'
`, signal)
    const containerId = await docker('container', 'inspect', '--format', '{{.Id}}', firstContainer)
    expect(isolation).toMatchObject({ exitCode: 0, stdout: 'isolated', containerId, stopped: true })
    expect(await docker('container', 'inspect', '--format', '{{.State.Status}}', firstContainer)).toBe('exited')
    expect(await docker('container', 'inspect', '--format', '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}', firstContainer)).toBe('volume:/workspace')
    expect((await initial.run(second, 'test ! -e evidence', signal)).exitCode).toBe(0)
    const other = await boot(test, config, otherHome)
    expect((await other.run(first, 'test ! -e evidence', signal)).exitCode).toBe(0)

    await initial.dispose()
    await docker('container', 'start', firstContainer)
    const resumed = await boot(test, config, home)
    await expect(resumed.run(first, 'touch replayed', signal)).rejects.toMatchObject({ code: 'EXEC_PREVIOUS_UNKNOWN' })
    expect(await resumed.run(first, 'test ! -e replayed && test ! -e escaped && cat evidence', signal)).toMatchObject({
      exitCode: 0, stdout: 'retained', containerId, stopped: true,
    })

    const large = await resumed.run(first, 'i=0; while test "$i" -lt 100; do printf "東京東京東京"; i=$((i+1)); done; exit 7', signal)
    expect(large).toMatchObject({ exitCode: 7, stdoutTruncated: true, stderrTruncated: false })
    expect(Buffer.byteLength(renderExecutionObservation(large))).toBeLessThanOrEqual(config.maxOutputBytes)

    const abort = new AbortController()
    const pending = resumed.run(first, 'touch entered; sleep 90; touch after-cancel', abort.signal)
      .catch((error: unknown) => error)
    try {
      await vi.waitFor(async () => {
        await docker('container', 'exec', firstContainer, '/bin/sh', '-c', 'test -f entered')
      }, { timeout: timeoutMs })
    } finally {
      abort.abort()
      await pending
    }
    expect(await pending).toMatchObject({ code: 'EXEC_CANCELLED' })
    expect(await docker('container', 'inspect', '--format', '{{.State.Status}}', firstContainer)).toBe('exited')
    expect((await resumed.run(first, 'test -e entered && test ! -e after-cancel', signal)).exitCode).toBe(0)

    await expect(resumed.run(first, 'touch before-timeout; sleep 90; touch after-timeout', signal))
      .rejects.toMatchObject({ code: 'EXEC_TIMEOUT' })
    expect(await docker('container', 'inspect', '--format', '{{.State.Status}}', firstContainer)).toBe('exited')
    expect((await resumed.run(first, 'test -e before-timeout && test ! -e after-timeout', signal)).exitCode).toBe(0)

    const foreignId = await docker('container', 'create', '--pull', 'never', '--name', foreignContainer, image, '/bin/sleep', '600')
    await expect(resumed.run(foreign, 'touch unexpected', signal)).rejects.toMatchObject({ code: 'EXEC_CONTAINER_CONFLICT' })
    expect(await docker('container', 'inspect', '--format', '{{.Id}} {{.State.Status}}', foreignContainer)).toBe(`${foreignId} created`)
  },
  // The deliberate script deadline shares this budget with Docker restarts and inspection.
  300_000,
)

it.skipIf(dockerSocket === undefined || image === undefined)(
  'carries concurrent business requests and refuses their saved credential on the next call',
  async (test) => {
    if (dockerSocket === undefined || image === undefined) throw new Error('Docker smoke needs a socket and a preloaded image')
    const docker = dockerCli(dockerSocket)
    const session = SessionId(randomUUID())
    const home = join(tmpdir(), randomUUID())
    const name = sessionContainer(session, home)
    test.onTestFinished(async () => {
      const id = await docker('container', 'ls', '-aq', '--filter', `name=^/${name}$`)
      if (id) await docker('container', 'rm', '-fv', id)
    }, 2 * stopTimeoutMs)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-docker-gateway-'))
    test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const executor = await boot(test, {
      dockerSocket, image, runtime, gatewaySocket: join(directory, 'gateway.sock'), timeoutMs, stopTimeoutMs,
      ...runtime === 'runc' ? { pidsLimit: 20 } : runtime === 'runsc' ? { pidsLimit: 48 } : {},
    }, home)
    await executor.ready
    const signal = new AbortController().signal
    const received: unknown[] = []
    const observed = await executor.run(session, `
set -eu
node -e "if (Object.keys(require('node:os').networkInterfaces()).join() !== 'lo') process.exit(1)"
test -n "$DSH_BROKER_TOKEN"
printf '%s' "$DSH_BROKER_TOKEN" > saved-credential
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
const replies = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
  const response = await fetch(process.env.DSH_BROKER_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.DSH_BROKER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'smoke', index }),
  })
  assert.equal(response.status, 200)
  return response.json()
}))
assert.deepEqual(replies, Array.from({ length: 8 }, () => ({ accepted: true })))
await new Promise((resolve, reject) => {
  connect(443, '1.1.1.1').on('connect', () => { reject(new Error('The container has direct egress')) }).on('error', resolve)
})
NODE
`, signal, (request) => {
      received.push(request)
      return Promise.resolve({ accepted: true })
    })
    expect(observed).toMatchObject({ exitCode: 0, stderr: '', stopped: true })
    expect(received).toEqual(expect.arrayContaining(Array.from({ length: 8 }, (_, index) => ({ action: 'smoke', index }))))
    expect(received).toHaveLength(8)
    expect(await docker('container', 'inspect', '--format', '{{.State.Status}} {{.HostConfig.Runtime}}', name)).toBe(`exited ${runtime}`)
    const refused = await executor.run(session, `
set -e
test "$DSH_BROKER_TOKEN" != "$(cat saved-credential)"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const response = await fetch(process.env.DSH_BROKER_URL, {
  method: 'POST', headers: { authorization: 'Bearer ' + readFileSync('saved-credential', 'utf8') }, body: '{}',
})
assert.equal(response.status, 403)
await response.text()
NODE
`, signal, () => Promise.resolve({ unexpected: true }))
    expect(refused).toMatchObject({ exitCode: 0, stderr: '', stopped: true })
    const offline = await executor.run(session, `
set -e
test -z "$DSH_BROKER_TOKEN"
test -z "$DSH_BROKER_URL"
if node -e "fetch('http://127.0.0.1:3128/business', { method: 'POST', body: '{}' }).then(() => process.exit(0), () => process.exit(3))"; then exit 4; fi
`, signal)
    expect(offline).toMatchObject({ exitCode: 0, stderr: '', stopped: true })
    expect(received).toHaveLength(8)
    expect(await docker('container', 'inspect', '--format', '{{.State.Status}}', name)).toBe('exited')
  },
  180_000,
)

it.skipIf(dockerSocket === undefined || image === undefined)(
  'cancels a pending business request and stops its container when execution is cancelled',
  async (test) => {
    if (dockerSocket === undefined || image === undefined) throw new Error('Docker smoke needs a socket and a preloaded image')
    const docker = dockerCli(dockerSocket)
    const session = SessionId(randomUUID())
    const home = join(tmpdir(), randomUUID())
    const name = sessionContainer(session, home)
    test.onTestFinished(async () => {
      const id = await docker('container', 'ls', '-aq', '--filter', `name=^/${name}$`)
      if (id) await docker('container', 'rm', '-fv', id)
    }, 2 * stopTimeoutMs)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-docker-gateway-'))
    test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const executor = await boot(test, {
      dockerSocket, image, runtime, gatewaySocket: join(directory, 'gateway.sock'), timeoutMs, stopTimeoutMs,
    }, home)
    await executor.ready
    const signal = new AbortController().signal

    // Each pending request resolves only when the gateway aborts it.
    const pending: AbortSignal[] = []
    const entered = () => vi.waitFor(() => { expect(pending.at(-1)?.aborted).toBe(false) }, { timeout: timeoutMs })
    const hold = (_input: unknown, aborted: AbortSignal) => new Promise<null>((resolve) => {
      pending.push(aborted)
      aborted.addEventListener('abort', () => { resolve(null) }, { once: true })
    })
    const request = 'node -e "fetch(process.env.DSH_BROKER_URL, { method: \'POST\', headers: { authorization: \'Bearer \' + process.env.DSH_BROKER_TOKEN }, body: \'{}\' })'

    // The credential is withdrawn before the stop, so the script sees its request fail; the sleep outlasts the stop.
    const abort = new AbortController()
    const cancelled = executor.run(session, `${request}.then(() => process.exit(6))"; sleep 90; touch after-cancel`, abort.signal, hold)
      .catch((error: unknown) => error)
    await entered()
    abort.abort()
    expect(await cancelled).toMatchObject({ code: 'EXEC_CANCELLED' })
    expect(pending).toHaveLength(1)
    expect(pending[0]?.aborted).toBe(true)

    expect(await docker('container', 'inspect', '--format', '{{.State.Status}}', name)).toBe('exited')
    expect((await executor.run(session, 'test ! -e after-cancel', signal)).exitCode).toBe(0)
  },
  300_000,
)
