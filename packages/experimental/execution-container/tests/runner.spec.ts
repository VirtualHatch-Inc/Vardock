/** Deterministic Docker CLI protocol failures through the isolated runner. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { text } from 'node:stream/consumers'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess, { type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it, vi, type TestContext } from 'vitest'
import { ContainerExecutor, DockerConfig, type ResolvedDockerConfig } from '../src/docker.ts'
import ConfiguredIsolatedExecution from '../src/index.ts'
import { RELAY_SCRIPT } from '../src/relay.ts'
import { createExecTool, renderExecutionObservation } from '../src/tool.ts'

const image = `sha256:${'a'.repeat(64)}`
const id = 'b'.repeat(64)
const session = SessionId('unit-test-session')
const home = '/unit-test-home'
const activeSignal = new AbortController().signal
const config = DockerConfig({
  dockerSocket: '/test.sock', image: 'unit:local', maxCommandBytes: 32, maxOutputBytes: 256,
}) as ResolvedDockerConfig

type Response = {
  text?: string
  stderr?: string
  exitCode?: number | null
  waitForAbort?: boolean
  fails?: boolean
  missingStderr?: boolean
  /** Runs before the command reports its exit. */
  during?: () => Promise<void>
  handle?: SubprocessHandle
}

class DockerFixture extends Subprocess {
  readonly responses: Response[] = []
  readonly calls: string[][] = []
  readonly environments: (NodeJS.ProcessEnv | undefined)[] = []
  readonly inputs: SubprocessSpawnSpec['stdio']['stdin'][] = []
  readonly executing = Promise.withResolvers<undefined>()

  async resolveExecutable(): Promise<string> { return '/test/docker' }
  terminalEnvironment(): never { throw new Error('unexpected terminal inspection') }
  spawnTerminal(): never { throw new Error('unexpected terminal spawn') }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec.argv.slice(5))
    this.environments.push(spec.env)
    this.inputs.push(spec.stdio.stdin)
    const response = this.responses.shift()
    if (response === undefined || response.fails) throw new Error('Docker process unavailable')
    if (response.handle !== undefined) return response.handle
    const stdout = {
      readFrom: () => ({ text: response.text ?? '', nextOffset: 0, lossy: false }),
    }
    const stderr = { readFrom: () => ({ text: response.stderr ?? '', nextOffset: 0, lossy: false }) }
    const outcome = { exitCode: response.exitCode === undefined ? 0 : response.exitCode, signal: null }
    const exited = response.waitForAbort ? new Promise<typeof outcome>((resolve) => {
      spec.signal?.addEventListener('abort', () => { resolve(outcome) }, { once: true })
      this.executing.resolve(undefined)
    }) : Promise.resolve(outcome)
    const done = response.during === undefined ? exited : Promise.all([response.during(), exited]).then(([, value]) => value)
    return {
      done, collected: { stdout, ...response.missingStderr ? {} : { stderr } },
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      terminate() {}, async waitForExit() { return true },
    }
  }
}

async function fixture(
  test: TestContext, startup = { text: `${image} linux 0` }, timeoutMs = config.timeoutMs, settings: Partial<DockerConfig> = {},
) {
  const ctx = new Context()
  await ctx.plugin(DockerFixture)
  const docker = ctx.subprocess as DockerFixture
  docker.responses.push(startup)
  const executor = new ContainerExecutor(ctx, { ...config, ...settings, timeoutMs }, home)
  test.onTestFinished(async () => {
    await executor.dispose()
    await ctx.fiber.dispose()
    expect(docker.responses).toEqual([])
  })
  return { docker, executor }
}

function inspection(state: string, digest = image, runtime = 'runc'): string {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const owner = hash(JSON.stringify([home, session]))
  const policy = hash(JSON.stringify([
    'dsh-isolated-container', config.image, runtime, config.memoryMiB, config.cpus, config.pidsLimit, config.timeoutMs, config.stopTimeoutMs,
  ]))
  return `${owner} ${policy} ${digest} ${state}`
}

it('caps output and validates scripts before invoking Docker', async (test) => {
  const { docker, executor } = await fixture(test)
  await expect(executor.ready).resolves.toBe(image)
  expect(() => executor.run(session, '', activeSignal)).toThrow(/non-empty/)
  expect(() => executor.run(session, 'a\0b', activeSignal)).toThrow(/non-empty/)
  expect(() => executor.run(session, '東'.repeat(11), activeSignal)).toThrow(/byte limit/)
  docker.responses.push({}, { text: id }, {}, {}, { text: '東'.repeat(100), stderr: 'é'.repeat(100), exitCode: 7 }, {})
  const observation = await executor.run(session, 'test', activeSignal)
  expect(observation).toMatchObject({
    containerId: id, stopped: true, exitCode: 7,
    stdoutTruncated: true,
    stderrTruncated: true,
  })
  expect(observation.stdout).toMatch(/^東+$/u)
  expect(observation.stderr).toMatch(/^é+$/u)
  const result = renderExecutionObservation(observation)
  expect(result).toContain('Exit status: 7')
  expect(result).toContain('stdout (truncated)')
  expect(result).toContain('stderr (truncated)')
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(256)
  expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'stop'])
})

it('refuses reuse when a preloaded image tag resolves to a different image', async (test) => {
  const { docker, executor } = await fixture(test)
  await executor.ready
  docker.responses.push({ text: id }, { text: inspection('exited', `sha256:${'c'.repeat(64)}`) })
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_CONTAINER_CONFLICT' })
  expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'inspect'])
})

it('snapshots import bytes before starting Docker and returns after stopping the container', async (test) => {
  const { docker, executor } = await fixture(test)
  docker.responses.push({ text: id }, { text: inspection('exited') }, {}, {}, {}, {})
  const data = Buffer.from([0, 128, 255])
  const digest = createHash('sha256').update(data).digest('hex')
  const encoded = data.toString('base64')
  const pending = executor.transfer(session, { kind: 'import', path: 'input/source.bin', data, maxBytes: data.length }, activeSignal)
  data.fill(1)
  await expect(pending).resolves.toEqual({ kind: 'imported', bytes: data.length, digest })
  const calls = docker.calls.slice(-2)
  expect(calls[0]?.slice(0, 6)).toEqual(['container', 'exec', '--interactive', id, '/usr/local/bin/node', '-e'])
  expect(docker.inputs.at(-2)).toEqual({ data: encoded })
  expect(calls[1]?.slice(0, 2)).toEqual(['container', 'stop'])
})

it('stops interrupted work without executing the requested script', async (test) => {
  const { docker, executor } = await fixture(test)
  await executor.ready
  docker.responses.push({ text: id }, { text: inspection('running') }, {})
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_PREVIOUS_UNKNOWN' })
  expect(docker.calls.map(args => args[1])).toEqual(['inspect', 'ls', 'inspect', 'stop'])
})

it('cancels an active script and rejects overlapping execution', async (test) => {
  const { docker, executor } = await fixture(test)
  await executor.ready
  docker.responses.push({ text: id }, { text: inspection('created') }, {}, {}, { waitForAbort: true }, {})
  const abort = new AbortController()
  const result = executor.run(session, 'test', abort.signal)
  await docker.executing.promise
  expect(() => executor.run(session, 'test', activeSignal)).toThrow(/already has an active/)
  abort.abort()
  await expect(result).rejects.toMatchObject({ code: 'EXEC_CANCELLED' })
  expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'stop'])
})

it('reports unknown cleanup state when Docker fails to stop the container', async (test) => {
  const { docker, executor } = await fixture(test)
  await executor.ready
  docker.responses.push({ text: id }, { text: inspection('exited') }, {}, {}, {}, { exitCode: 1 })
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_STOP_UNKNOWN' })
})

it('rejects invalid startup images and invalid container identities', async (test) => {
  const bad = await fixture(test, { text: `${image} linux 1` })
  await expect(bad.executor.ready).rejects.toMatchObject({ code: 'EXEC_IMAGE' })
  const { docker, executor } = await fixture(test)
  await executor.ready
  docker.responses.push({ text: 'not-a-container-id' })
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_DOCKER' })
})

it('bounds execution and stops Docker when the CLI loses its exit status', async (test) => {
  const timed = await fixture(test, undefined, 20)
  timed.docker.responses.push({}, { text: id }, {}, {}, { waitForAbort: true }, {})
  await expect(timed.executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_TIMEOUT' })
  const { docker, executor } = await fixture(test)
  docker.responses.push({}, { text: id }, {}, {}, { exitCode: null }, {})
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_UNKNOWN' })
  docker.responses.push({}, { text: id }, {}, {}, { fails: true }, {})
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_DOCKER' })
  const waiting = await brokerFixture(test, 20)
  await waiting.executor.ready
  const relay = pipedCommand(test)
  waiting.docker.responses.push({}, { text: id }, {}, {}, { handle: relay.handle }, {})
  await expect(waiting.executor.run(session, 'test', activeSignal, () => Promise.resolve(null)))
    .rejects.toMatchObject({ code: 'EXEC_TIMEOUT' })
  expect(waiting.docker.calls.some(args => args.includes('/bin/sh'))).toBe(false)
})

it('passes Session identity and script to the authority callback for native execution', async (test) => {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Tools)
  await ctx.plugin(Native)
  const run = vi.fn(async () => 'workspace result')
  ctx.tools.register(createExecTool(run))
  const description = ctx.tools.schemas().find(tool => tool.name === 'exec')?.description
  expect(description).toContain('POSIX /bin/sh and Node.js 24')
  expect(description).toContain('Python and curl are not installed')
  expect(description).toContain('Node.js fetch')
  expect(description).toContain('without a leading semicolon')
  expect(description).toContain('Scripts may run automatically under the operator’s policy.')
  expect(description).toContain('External requests wait for owner approval unless a configured rule admits them.')
  expect(ctx.tools.get('exec')?.presentCall?.({ command: 'test' })).toMatchObject({ card: 'terminal', cwd: '/workspace' })
  const input = { signal: activeSignal, calls: [
    { type: 'tool-call' as const, name: 'exec', id: ToolCallId('call'), arguments: '{"command":"test"}' },
  ] }
  const missing = await ctx.tools.execute(input)
  expect(missing.results[0]?.result).toMatchObject({ error: { info: { code: 'EXEC_NO_SESSION' } } })
  expect(run).not.toHaveBeenCalled()
  const batch = await ctx.tools.execute({ ...input, agent: { id: session } as Agent })
  expect(batch.results[0]?.result.content).toEqual([{ type: 'text', text: 'workspace result' }])
  expect(run).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledWith(session, 'test', expect.any(AbortSignal))
})

it('ignores ambient Docker routing and requires both subprocess output readers', async (test) => {
  vi.stubEnv('DOCKER_HOST', 'ssh://unexpected.invalid')
  try {
    const { docker, executor } = await fixture(test)
    await executor.ready
    expect(docker.environments[0]).toHaveProperty('DOCKER_HOST', undefined)
    docker.responses.push({}, { text: id }, {}, {}, { missingStderr: true }, {})
    await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_DOCKER' })
    expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'stop'])
  } finally {
    vi.unstubAllEnvs()
  }
})

it('creates the container under the configured runtime and refuses one created under another', async (test) => {
  const { docker, executor } = await fixture(test, undefined, undefined, { runtime: 'runsc' })
  docker.responses.push({}, { text: id }, {}, {}, {}, {})
  await executor.run(session, 'test', activeSignal)
  const create = docker.calls.find(args => args[1] === 'create') ?? []
  expect(create.slice(create.indexOf('--runtime'), create.indexOf('--runtime') + 2)).toEqual(['--runtime', 'runsc'])
  expect(create.slice(create.indexOf('--dns'), create.indexOf('--dns') + 4)).toEqual(['--dns', '127.0.0.1', '--dns-search', '.'])
  docker.responses.push({ text: id }, { text: inspection('exited') })
  await expect(executor.run(session, 'test', activeSignal)).rejects.toMatchObject({ code: 'EXEC_CONTAINER_CONFLICT' })
  docker.responses.push({ text: id }, { text: inspection('exited', image, 'runsc') }, {}, {}, {}, {})
  await expect(executor.run(session, 'test', activeSignal)).resolves.toMatchObject({ exitCode: 0 })
})

it('refuses a business request when no gateway socket is configured', async (test) => {
  const { executor } = await fixture(test)
  await executor.ready
  await expect(executor.run(session, 'test', activeSignal, () => Promise.resolve(null)))
    .rejects.toMatchObject({ code: 'EXEC_BROKER_UNAVAILABLE' })
})

async function brokerFixture(test: TestContext, timeoutMs = config.timeoutMs, settings: Partial<DockerConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-docker-gateway-'))
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const gatewaySocket = join(directory, 'gateway.sock')
  return { ...await fixture(test, undefined, timeoutMs, { ...settings, gatewaySocket }), gatewaySocket }
}

function post(socketPath: string, token: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    request({ socketPath, path: '/business', method: 'POST', agent: false, headers: { authorization: `Bearer ${token}` } }, (response) => {
      void text(response).then(() => { resolve(response.statusCode) }, reject)
    }).on('error', reject).end('{}')
  })
}

function scriptToken(docker: DockerFixture): string {
  const token = docker.environments[docker.calls.findIndex(args => args.includes('/bin/sh'))]?.DSH_BROKER_TOKEN
  if (token === undefined) throw new Error('The script received no broker credential')
  return token
}

/** A piped subprocess whose termination and output closure the test can control independently. */
function pipedCommand(test: TestContext) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const exited = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const finish = (): void => { stdout.end(); stdin.end(); exited.resolve({ exitCode: 0, signal: null }) }
  const terminate = vi.fn(finish)
  test.onTestFinished(finish)
  const handle: SubprocessHandle = {
    done: exited.promise, collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
    stdin, stdout, stderr: undefined, control: undefined, terminate, async waitForExit() { return true },
  }
  return { handle, stdout, finish, terminate }
}

it('starts the relay before the script and gives the broker credential only to the script', async (test) => {
  const { docker, executor, gatewaySocket } = await brokerFixture(test)
  await executor.ready
  const relay = pipedCommand(test)
  const broker = vi.fn(async () => null)
  docker.responses.push({}, { text: id }, {}, {}, { handle: relay.handle }, {
    during: async () => { expect(await post(gatewaySocket, scriptToken(docker))).toBe(200) },
  }, {})
  const pending = executor.run(session, 'test', activeSignal, broker)
  await vi.waitFor(() => { expect(docker.calls.some(args => args.includes('/usr/local/bin/node'))).toBe(true) })
  expect(docker.calls.some(args => args.includes('/bin/sh'))).toBe(false)
  relay.stdout.write('{"ready":true}\n')
  await expect(pending).resolves.toMatchObject({ exitCode: 0, stopped: true })
  expect(broker).toHaveBeenCalledExactlyOnceWith({}, expect.any(AbortSignal))
  expect(docker.calls.flat()).toContain(RELAY_SCRIPT)
  const token = scriptToken(docker)
  const scriptIndex = docker.calls.findIndex(args => args.includes('/bin/sh'))
  expect(docker.calls.flat()).not.toContain(token)
  expect(docker.environments[scriptIndex]).toMatchObject({ DSH_BROKER_URL: 'http://127.0.0.1:3128/business', DSH_BROKER_TOKEN: token })
  expect(docker.environments.filter(env => env?.DSH_BROKER_TOKEN !== undefined)).toHaveLength(1)
})

it.for(['success', 'cancellation'] as const)(
  'withdraws the credential before stopping and waits for request drain and relay closure on %s', async (outcome, test) => {
    const { docker, executor, gatewaySocket } = await brokerFixture(test)
    await executor.ready
    const relay = pipedCommand(test)
    const terminated = Promise.withResolvers<undefined>()
    relay.terminate.mockImplementation(() => { terminated.resolve(undefined) })
    relay.stdout.write('{"ready":true}\n')
    const entered = Promise.withResolvers<AbortSignal>()
    const released = Promise.withResolvers<null>()
    const stopped = Promise.withResolvers<undefined>()
    const abort = new AbortController()
    let requestDone: Promise<unknown> | undefined
    let drained = false
    docker.responses.push({}, { text: id }, {}, {}, { handle: relay.handle }, {
      waitForAbort: outcome === 'cancellation',
      during: async () => {
        requestDone = post(gatewaySocket, scriptToken(docker)).catch((error: unknown) => error)
        await entered.promise
        if (outcome === 'cancellation') abort.abort()
      },
    }, { during: async () => {
      expect(await post(gatewaySocket, scriptToken(docker))).toBe(403)
      stopped.resolve(undefined)
    } })
    const pending = executor.run(session, 'test', abort.signal, (_input, signal) => {
      entered.resolve(signal)
      return released.promise.then((value) => { drained = true; return value })
    }).then(value => ({ value, closed: relay.stdout.closed, drained }),
      (error: unknown) => ({ error, closed: relay.stdout.closed, drained }))
    try {
      await stopped.promise
      expect((await entered.promise).aborted).toBe(true)
      released.resolve(null)
      await terminated.promise
      relay.finish()
      const result = await pending
      expect(result).toMatchObject({ closed: true, drained: true })
      if (outcome === 'success') expect(result).toMatchObject({ value: { exitCode: 0 } })
      else expect(result).toMatchObject({ error: { code: 'EXEC_CANCELLED' } })
    } finally {
      released.resolve(null)
      relay.finish()
      await pending
      await requestDone
    }
  },
)

it('stops the container without running the script when the relay ends before it is ready', async (test) => {
  const { docker, executor } = await brokerFixture(test)
  await executor.ready
  const relay = pipedCommand(test)
  docker.responses.push({}, { text: id }, {}, {}, { handle: relay.handle }, {})
  const pending = executor.run(session, 'test', activeSignal, () => Promise.resolve(null))
  await vi.waitFor(() => { expect(docker.calls.some(args => args.includes('/usr/local/bin/node'))).toBe(true) })
  relay.finish()
  await expect(pending).rejects.toMatchObject({ code: 'EXEC_DOCKER' })
  expect(docker.calls.some(args => args.includes('/bin/sh'))).toBe(false)
  expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'stop'])
})

it('starts no relay and hands out no credential for transfers and scripts without a broker', async (test) => {
  const { docker, executor } = await brokerFixture(test)
  await executor.ready
  docker.responses.push({}, { text: id }, {}, {}, {}, {})
  await executor.run(session, 'test', activeSignal)
  docker.responses.push({ text: id }, { text: inspection('exited') }, {}, {}, { text: '' }, {})
  await expect(executor.transfer(session, { kind: 'export', path: 'result.bin', maxBytes: 0 }, activeSignal))
    .resolves.toMatchObject({ kind: 'exported', bytes: 0 })
  expect(docker.calls.flat()).not.toContain(RELAY_SCRIPT)
  expect(docker.calls.flat().some(arg => arg.startsWith('DSH_BROKER'))).toBe(false)
  expect(docker.environments.some(env => Object.keys(env ?? {}).some(name => name.startsWith('DSH_BROKER')))).toBe(false)
})

it.for([['runc', 19, 20], ['runsc', 47, 48]] as const)(
  'refuses at load a %s process limit below what the broker relay needs', ([runtime, refused, accepted]) => {
    const offline = { backend: 'docker' as const, dockerSocket: '/test.sock', image: 'unit:local', runtime }
    const brokered = { ...offline, gatewaySocket: '/private/gateway.sock' }
    expect(() => new ConfiguredIsolatedExecution(new Context(), { ...brokered, pidsLimit: refused })).toThrow(`at least ${accepted}`)
    expect(new ConfiguredIsolatedExecution(new Context(), { ...brokered, pidsLimit: accepted }).reservedPaths)
      .toEqual(['/test.sock', '/private/gateway.sock'])
    expect(new ConfiguredIsolatedExecution(new Context(), { ...offline, pidsLimit: 3 }).reservedPaths).toEqual(['/test.sock'])
  },
)
