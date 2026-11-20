/** Exercise Apple microVM admission and quiescence against the CLI protocol. */
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess, { type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it, vi, type TestContext } from 'vitest'
import { AppleVmConfig, AppleVmExecutor } from '../src/vm.ts'

const image = `sha256:${'a'.repeat(64)}`
const session = SessionId('vm-session')
const signal = new AbortController().signal

class VmCli extends Subprocess {
  readonly calls: SubprocessSpawnSpec[] = []
  readonly gatewayPresentAtStop: boolean[] = []
  readonly executing = Promise.withResolvers<undefined>()
  state = 'stopped'
  stopWorks = true
  attachNetwork = false
  waitForCancellation = false
  failScript = false
  transferOutput = ''
  id = ''
  labels: Record<string, string> = {}
  gateway = ''

  async resolveExecutable(): Promise<string> { return '/test/container' }
  terminalEnvironment(): never { throw new Error('unexpected terminal inspection') }
  spawnTerminal(): never { throw new Error('unexpected terminal spawn') }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(spec)
    const [, verb, ...args] = spec.argv
    let text = ''
    let exitCode = 0
    switch (verb) {
      case 'image':
        text = JSON.stringify([{
          configuration: { descriptor: { digest: image } },
          variants: [{ platform: { os: 'linux', architecture: 'arm64' } }],
        }])
        break
      case 'list':
        text = this.id
        break
      case 'create':
        this.id = args[args.indexOf('--name') + 1] ?? ''
        this.gateway = args[args.lastIndexOf('--volume') + 1]?.split(':')[0] ?? ''
        this.labels = Object.fromEntries(args.flatMap((arg, index): [string, string][] => {
          if (arg !== '--label') return []
          const [key, value] = args[index + 1]?.split('=') ?? []
          if (key === undefined || value === undefined) throw new Error('invalid label in create command')
          return [[key, value]]
        }))
        break
      case 'inspect':
        text = JSON.stringify([{
          id: this.id,
          status: { state: this.state },
          configuration: {
            labels: this.labels, image: { descriptor: { digest: image } },
            networks: this.attachNetwork ? [{ network: 'default' }] : [],
            mounts: [
              { type: { volume: { format: 'ext4' } }, destination: '/workspace' },
              { type: { virtiofs: {} }, destination: '/run/dsh-gateway.sock', source: this.gateway },
            ],
          },
        }])
        break
      case 'start':
        this.state = 'running'
        break
      case 'exec':
        if (args.includes('--interactive')) {
          const transfer = args.includes('/usr/local/bin/node')
          if (this.failScript) throw new Error(`Could not spawn ${spec.argv.join(' ')}`)
          text = transfer ? this.transferOutput : 'workspace output'
          exitCode = transfer ? 0 : 7
        }
        break
      case 'stop':
        this.gatewayPresentAtStop.push(existsSync(this.gateway))
        if (this.stopWorks) this.state = 'stopped'
        break
      default:
        throw new Error(`unexpected Apple container command ${verb}`)
    }
    const outcome = { exitCode, signal: null }
    const done = verb === 'exec' && args.includes('--interactive') && this.waitForCancellation
      ? new Promise<typeof outcome>((resolve) => {
        spec.signal?.addEventListener('abort', () => { resolve(outcome) }, { once: true })
        this.executing.resolve(undefined)
      })
      : Promise.resolve(outcome)
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text, nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      terminate() {}, async waitForExit() { return true },
    }
  }
}

async function fixture(test: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vm-'))
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(VmCli)
  const cli = ctx.subprocess as VmCli
  const gatewaySocket = join(directory, 'gateway.sock')
  const config = AppleVmConfig({ image: 'test:local', gatewaySocket }) as Required<AppleVmConfig>
  const executor = new AppleVmExecutor(ctx, config, 'test namespace')
  test.onTestFinished(() => executor.dispose())
  await expect(executor.ready).resolves.toBe(image)
  return { executor, cli, gatewaySocket, ctx, config }
}

it('admits a NIC-free VM and observes shutdown after returning the bounded script status', async (test) => {
  const { executor, cli, gatewaySocket } = await fixture(test)
  const result = await executor.run(session, 'exit 7', signal)
  expect(result).toMatchObject({ exitCode: 7, stdout: 'workspace output', stopped: true })
  expect(result.containerId).toMatch(/^[a-f0-9]{64}$/u)
  const create = cli.calls.find(call => call.argv[1] === 'create')
  expect(create?.argv).toEqual(expect.arrayContaining([
    '--network', 'none', '--no-dns', '--read-only', '--cap-drop', 'ALL', `${gatewaySocket}:/run/dsh-gateway.sock`,
  ]))
  expect(cli.calls.find(call => call.argv.includes('--interactive'))?.stdio?.stdin).toEqual({ data: 'exit 7' })
  expect(cli.calls.slice(-2).map(call => call.argv.slice(1))).toEqual([
    ['stop', '--time', '0', cli.id], ['inspect', cli.id],
  ])
})

it('stops a prior running VM and rejects before replaying the script', async (test) => {
  const { executor, cli } = await fixture(test)
  await executor.run(session, 'exit 7', signal)
  cli.calls.length = 0
  cli.state = 'running'
  await expect(executor.run(session, 'exit 7', signal)).rejects.toMatchObject({ code: 'EXEC_PREVIOUS_UNKNOWN' })
  expect(cli.calls.map(call => call.argv[1])).toEqual(['list', 'inspect', 'stop', 'inspect'])
  expect(cli.state).toBe('stopped')
})

it('rejects a VM configured with a network before starting it', async (test) => {
  const { executor, cli } = await fixture(test)
  cli.attachNetwork = true
  await expect(executor.run(session, 'exit 7', signal)).rejects.toMatchObject({ code: 'EXEC_CONTAINER_CONFLICT' })
  expect(cli.calls.every(call => call.argv[1] !== 'start')).toBe(true)
})

it('confirms VM shutdown even after the caller cancels a running script', async (test) => {
  const { executor, cli } = await fixture(test)
  cli.waitForCancellation = true
  const abort = new AbortController()
  const pending = executor.run(session, 'exit 7', abort.signal)
  await Promise.race([cli.executing.promise, pending])
  expect(() => executor.transfer(session, { kind: 'export', path: 'result.bin', maxBytes: 10 }, signal)).toThrow(/active execution/)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ code: 'EXEC_CANCELLED' })
  expect(cli.calls.slice(-2).map(call => call.argv[1])).toEqual(['stop', 'inspect'])
  expect(cli.state).toBe('stopped')
})

it('transfers in its own VM invocation without a broker token and waits for confirmed stop', async (test) => {
  const { executor, cli } = await fixture(test)
  const data = Buffer.from([0, 128, 255])
  cli.transferOutput = data.toString('base64')
  await expect(executor.transfer(session, { kind: 'export', path: 'result.bin', maxBytes: data.length }, signal))
    .resolves.toMatchObject({ kind: 'exported', bytes: data.length, data })
  const call = cli.calls.find(({ argv }) => argv.includes('--interactive'))
  expect(call?.argv.slice(1, 6)).toEqual(['exec', '--interactive', cli.id, '/usr/local/bin/node', '-e'])
  expect(call?.argv.slice(-4)).toEqual(['/workspace', 'export', 'result.bin', String(data.length)])
  expect(call?.stdio.stdin).toBe('ignore')
  expect(cli.calls.slice(-2).map(({ argv }) => argv[1])).toEqual(['stop', 'inspect'])
  expect(cli.state).toBe('stopped')
})

it('rejects when Apple container cannot confirm the VM stopped', async (test) => {
  const { executor, cli, gatewaySocket } = await fixture(test)
  cli.stopWorks = false
  await expect(executor.run(session, 'exit 7', signal)).rejects.toMatchObject({ code: 'EXEC_STOP_UNKNOWN' })
  await expect(lstat(gatewaySocket)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('stops orphaned VMs before listening on a recovered gateway path', async (test) => {
  const { executor, cli, gatewaySocket, ctx, config } = await fixture(test)
  await executor.run(session, 'exit 7', signal)
  await executor.dispose()
  cli.calls.length = 0
  cli.state = 'running'
  const resumed = new AppleVmExecutor(ctx, config, 'test namespace')
  test.onTestFinished(() => resumed.dispose())
  await resumed.ready
  expect(cli.calls.map(call => call.argv[1])).toEqual(['image', 'list', 'inspect', 'stop', 'inspect'])
  expect(cli.gatewayPresentAtStop).toEqual([true, false])
  expect((await lstat(gatewaySocket)).isSocket()).toBe(true)
  await expect(resumed.run(session, 'exit 7', signal)).rejects.toMatchObject({ code: 'EXEC_PREVIOUS_UNKNOWN' })
  expect(cli.calls.some(call => call.argv[1] === 'start')).toBe(false)
})

it.for([
  ['exit', undefined], ['spawn', 'EXEC_VM'],
] as const)(
  'keeps broker values off CLI arguments and diagnostics after %s', async ([outcome, code], test) => {
    const { executor, cli, ctx } = await fixture(test)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    test.onTestFinished(() => { warn.mockRestore() })
    vi.stubEnv('CONTAINER_HOST', 'ambient-routing')
    test.onTestFinished(() => { vi.unstubAllEnvs() })
    cli.failScript = outcome === 'spawn'
    const abort = new AbortController()
    const pending = executor.run(session, 'exit 7', abort.signal, async () => null).then(
      result => ({ result }),
      (error: unknown) => ({ error }),
    )
    const settled = await pending
    const scriptCall = cli.calls.find(({ argv }) => argv.includes('/bin/sh') && argv.includes('--interactive'))
    const token = scriptCall?.env?.DSH_BROKER_TOKEN
    const startCall = cli.calls.find(({ argv }) => argv[1] === 'start')
    expect(token).toMatch(/^[a-f0-9]{64}$/u)
    expect(startCall?.env).toHaveProperty('CONTAINER_HOST', undefined)
    expect(scriptCall?.env).toEqual({
      ...startCall?.env,
      DSH_BROKER_URL: 'http://127.0.0.1:3128/business', DSH_BROKER_TOKEN: token,
    })
    expect(scriptCall?.argv.slice(1, 7)).toEqual([
      'exec', '--interactive', '--env', 'DSH_BROKER_URL', '--env', 'DSH_BROKER_TOKEN',
    ])
    expect(inspect(cli.calls.map(({ argv }) => argv))).not.toContain(token)
    expect(cli.calls.filter(call => call !== scriptCall).every(call => call.env?.DSH_BROKER_TOKEN === undefined
      && call.env?.DSH_BROKER_URL === undefined)).toBe(true)
    expect(inspect(settled, { depth: null })).not.toContain(token)
    expect(inspect(warn.mock.calls, { depth: null })).not.toContain(token)
    expect(settled).toMatchObject(code === undefined ? { result: { exitCode: 7, stopped: true } } : { error: { code } })
    expect(cli.calls.slice(-2).map(({ argv }) => argv[1])).toEqual(['stop', 'inspect'])
    expect(cli.state).toBe('stopped')
    cli.failScript = false
    await executor.run(session, 'exit 7', signal)
    expect(cli.calls.findLast(({ argv }) => argv.includes('--interactive'))?.env).toEqual(startCall?.env)
  },
)
