/** Exercise the lifecycle CLI with private homes, real readiness endpoints, and fake system commands. */
import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createSocketServer, type Server } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi, type TestContext } from 'vitest'

const execute = promisify(execFile)
const source = new URL('../vardock/', import.meta.url)
const script = fileURLToPath(new URL('manage.mjs', source))
const label = 'io.github.virtualhatch-inc.vardock'
const earlierLabel = 'io.deepseek.dsh.assistant-dev'
const roles = ['witness', 'authority', 'web'] as const
type Role = typeof roles[number]
type FakeJob = { home: string; pid?: number; exitCode?: number; inactive?: boolean }

const shim = `
import childProcess from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

const { fixture, checkout, home, port, socketPaths, platform } = JSON.parse(process.env.VARDOCK_TEST_FIXTURE)
Object.defineProperties(process, { platform: { value: platform }, arch: { value: 'arm64' } })
const statePath = join(fixture, 'state.json')
const trace = join(fixture, 'trace.jsonl')
const label = '${label}'
const profile = { witness: 'operation-witness', authority: 'operation-authority', web: 'web' }
const result = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr, signal: null })
childProcess.spawnSync = (command, args, options) => {
  const name = basename(command)
  appendFileSync(trace, JSON.stringify([name, ...args]) + '\\n')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const save = () => writeFileSync(statePath, JSON.stringify(state))
  switch (name) {
    case 'sw_vers': return result(0, '26.0\\n')
    case 'pnpm': return args[0] === '--version' ? result(0, '11.28.5\\n') : result()
    case 'codex': return options.env.OPENAI_API_KEY === undefined ? result() : result(1)
    case 'container': {
      if (args[1] === 'status') {
        return state.containerRunning ? result(0, '{"status":"running"}') : result(1, '{"status":"unregistered"}')
      }
      if (args[0] === 'system' && args[1] === 'start') {
        state.containerRunning = true
        save()
        return result()
      }
      if (args[0] === 'image' && args[1] === 'list') {
        return result(0, state.image ? 'dsh-execution:local\\n' : '')
      }
      if (args[0] === 'build') {
        state.image = true
        save()
        return result()
      }
      break
    }
    case 'loginctl': return result(0, 'Linger=' + (state.linger ? 'yes' : 'no') + '\\n')
    case 'systemd-run': return result(state.serviceDocker ? 0 : 1, JSON.stringify(state.dockerInfo))
    case 'systemd-analyze': return result(state.invalidUnit ? 1 : 0)
    case 'docker': {
      const operation = args[0] === '--host' ? args.slice(2) : args
      if (operation[0] === 'context') return result(0, JSON.stringify([{ Endpoints: { docker: { Host: state.dockerEndpoint } } }]))
      if (operation[0] === 'image') return result(0, state.image ? 'dsh-execution:local\\n' : '')
      if (operation[0] === 'build') {
        state.image = true
        save()
        return result()
      }
      break
    }
    case 'systemctl': {
      const operation = args[1]
      if (operation === 'is-system-running') return state.managerUnavailable ? result(1, 'offline') : result(0, 'running')
      const role = basename(args.at(-1), '.service').split('.').at(-1)
      const job = state.jobs[role]
      if (operation === 'show') {
        if (job === undefined) return result(0, 'LoadState=not-found\\n')
        return result(0, [
          'LoadState=loaded',
          'MainPID=' + (job.pid ?? 0),
          'ExecMainStatus=' + (job.exitCode ?? 0),
          'FragmentPath=' + join(job.home, label + '.' + role + '.service'),
          'WorkingDirectory=' + join(job.home, role),
        ].join('\\n') + '\\n')
      }
      if (operation === 'enable') {
        if (job !== undefined && !job.inactive) return result(1)
        state.jobs[role] = { home, pid: 2147483600 + Object.keys(profile).indexOf(role) }
        save()
        return result()
      }
      if (operation === 'disable') {
        if (args[2] !== '--now') throw new Error('Stop must disable and stop the unit together.')
        // A unit can remain loaded but inactive after disable --now.
        if (job !== undefined) {
          job.inactive = true
          delete job.pid
        }
        save()
        return result()
      }
      break
    }
    case 'plutil': {
      const role = basename(args.at(-1)).split('.').at(-2)
      const working = join(home, role)
      return result(0, JSON.stringify({
        Label: label + '.' + role,
        WorkingDirectory: working,
        EnvironmentVariables: { DSH_HOME: working },
        ProgramArguments: [process.execPath, join(checkout, 'apps/cli/lib/bin.js'), '--profile', profile[role]],
        StandardOutPath: join(working, 'stdout.log'),
      }))
    }
    case 'launchctl': {
      const target = args[0] === 'bootstrap' ? basename(args[2], '.plist') : args[1].split('/').at(-1)
      const role = target.split('.').at(-1)
      const job = state.jobs[role]
      if (args[0] === 'print' && !target.startsWith(label + '.')) {
        return state.earlierJobs.includes(role) ? result(0, '\\tpid = 1\\n') : result(113)
      }
      if (args[0] === 'print') {
        if (job === undefined) return result(113)
        const working = join(job.home, role)
        const fields = [
          '\\tpath = ' + join(job.home, label + '.' + role + '.plist'),
          '\\tworking directory = ' + working,
          '\\t\\tDSH_HOME => ' + working,
          ...(job.pid === undefined ? [] : ['\\tpid = ' + job.pid]),
          ...(job.exitCode === undefined ? [] : ['\\tlast exit code = ' + job.exitCode]),
        ]
        return result(0, fields.join('\\n') + '\\n')
      }
      if (args[0] === 'bootstrap') {
        if (job !== undefined) return result(1)
        state.jobs[role] = { home, pid: 2147483600 + Object.keys(profile).indexOf(role) }
        save()
        return result()
      }
      if (args[0] === 'bootout') {
        delete state.jobs[role]
        save()
        return result()
      }
      break
    }
    case 'lsof': {
      if (args.includes('-U')) {
        const pid = Number(args[args.indexOf('-p') + 1])
        const role = Object.keys(state.jobs).find(role => state.jobs[role].pid === pid)
        const paths = role === 'witness' ? [socketPaths.evidence] : [socketPaths.operation, socketPaths.approval]
        return result(0, paths.map(path => 'n' + path + (platform === 'linux' ? ' type=STREAM' : '')).join('\\n') + '\\n')
      }
      return result(0, 'p' + state.jobs.web.pid + '\\nn127.0.0.1:' + port + '\\n')
    }
    case 'open': return result()
  }
  throw new Error('Unexpected fixture command ' + name + ' ' + args.join(' '))
}
syncBuiltinESMExports()
`

function fixture(test: TestContext, platform = 'darwin') {
  const root = realpathSync(mkdtempSync('/tmp/vardock-'))
  const servers: Server[] = []
  let execution: ReturnType<typeof execute> | undefined
  test.onTestFinished(async () => {
    execution?.child.kill()
    await Promise.allSettled(execution === undefined ? [] : [execution])
    await Promise.all(servers.map(server => new Promise<void>((done, reject) => {
      server.close((error) => { if (error) reject(error); else done() })
    })))
    rmSync(root, { recursive: true, force: true })
  })

  const checkout = join(root, 'checkout')
  const home = join(root, 'vardock')
  const commands = join(root, 'bin')
  const trace = join(root, 'trace.jsonl')
  const statePath = join(root, 'state.json')
  const vardock = join(checkout, 'packages/experimental/assistant/vardock')
  const entry = join(vardock, basename(script))
  const bin = join(checkout, 'node_modules/.bin')
  const cli = join(checkout, 'apps/cli/lib/bin.js')
  const socketPaths = {
    evidence: join(home, 'witness/evidence.sock'),
    operation: join(home, 'authority/operation.sock'),
    approval: join(home, 'authority/approval.sock'),
  }
  const state = (jobs: Partial<Record<Role, FakeJob>> = {}, containerRunning = false, image = false, earlierJobs: Role[] = []) => {
    writeFileSync(statePath, JSON.stringify({
      jobs, containerRunning, image, earlierJobs, linger: true, serviceDocker: true,
      dockerEndpoint: 'unix:///var/run/docker.sock',
      dockerInfo: { CgroupVersion: '2', MemoryLimit: true, PidsLimit: true, CpuCfsQuota: true,
        Runtimes: { runc: {}, runsc: {}, 'io.containerd.kata.v2': {} } },
    }))
  }
  const calls = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
  state()
  writeFileSync(trace, '')
  mkdirSync(vardock, { recursive: true })
  for (const file of ['manage.mjs', 'prepare.mjs', 'launchd.mjs', 'systemd.mjs']) copyFileSync(new URL(file, source), join(vardock, file))
  writeFileSync(join(checkout, 'package.json'), '{"packageManager":"pnpm@11.28.5"}')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'tsx'), '')
  const rootYaml = new URL('../../../../node_modules/js-yaml', import.meta.url)
  symlinkSync(fileURLToPath(rootYaml), join(checkout, 'node_modules/js-yaml'), 'dir')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, '')
  mkdirSync(commands)
  for (const name of ['pnpm', 'codex', 'container', 'docker']) writeFileSync(join(commands, name), '', { mode: 0o700 })
  const preload = join(root, 'fake-system.mjs')
  writeFileSync(preload, shim)

  const run = async (args: string[], port?: number) => {
    const env = {
      ...process.env,
      PATH: `${commands}:/usr/bin:/bin`,
      OPENAI_API_KEY: 'private-environment-value',
      VARDOCK_TEST_FIXTURE: JSON.stringify({ fixture: root, checkout, home, port, socketPaths, platform }),
    }
    try {
      const pending = execute(process.execPath, ['--import', preload, entry, ...args, '--home', home], {
        env, encoding: 'utf8', timeout: 30_000,
      })
      execution = pending
      const output = await pending
      return { ...output, code: 0 }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number'
        || !('stdout' in error) || typeof error.stdout !== 'string'
        || !('stderr' in error) || typeof error.stderr !== 'string') throw error
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
  }

  async function listen<T extends Server>(server: T, start: (ready: () => void) => void) {
    await new Promise<void>((ready, reject) => {
      server.once('error', reject)
      start(ready)
    })
    servers.push(server)
    return server
  }

  const linuxState = (changes: Record<string, unknown>) => {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    writeFileSync(statePath, JSON.stringify({ ...saved, ...changes }))
  }
  return { root, home, checkout, state, calls, run, socketPaths, listen, linuxState }
}

const localCodex = ['--model-provider', 'codex-local', '--model', 'default']
const linuxSetup = ['setup', '--model-provider', 'openai', '--model', 'fixture-model', '--runtime', 'runc']
const deploymentHost = process.platform === 'darwin' || process.platform === 'linux'

async function runHost(args: string[]) {
  try {
    const output = await execute(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15_000 })
    return { code: 0, stdout: output.stdout, stderr: output.stderr }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number'
      || !('stdout' in error) || typeof error.stdout !== 'string'
      || !('stderr' in error) || typeof error.stderr !== 'string') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

it('prints usage on this host without requiring a deployment platform', async () => {
  const help = await runHost(['--help'])
  expect(help).toMatchObject({ code: 0, stderr: '' })
  expect(help.stdout).toContain('Usage: pnpm vardock')
  expect(help.stdout).toContain('Default home: ~/.vardock')
})

it.skipIf(deploymentHost)('refuses setup and doctor on this host with the unsupported-platform error and no stack frames', async () => {
  for (const args of [['setup', '--model-provider', 'openai', '--model', 'fixture-model'], ['doctor']]) {
    const result = await runHost(args)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Vardock supports macOS and Linux only.')
    expect(result.stderr).not.toContain('at ')
  }
})

it.skipIf(process.platform === 'win32')('prints help and rejects invalid command options before checking the host', async (test) => {
  const { run } = fixture(test)
  const help = await run(['--help'])
  expect(help.code).toBe(0)
  expect(help.stdout).toMatchInlineSnapshot(`
    "Usage: pnpm vardock <setup|start|stop|doctor|verify> [--home <directory>]
      setup --model-provider <route> --model <id> [--port <0-65535>] [--review-scripts] [--authority-patch <file>] [--permit-action <action-id>]
                               Build dsh and prepare a new private home; --review-scripts asks before every script
      --authority-patch <file> Merge a Cordis patch into the authority profile (repeatable)
      --permit-action <action-id> Write an Assistant broker permission (repeatable); unprovided actions fail authority startup
      start [--no-open]        Start the jobs and open Vardock
      stop                     Unload the jobs
      doctor                   Check setup and running jobs
      verify                   Compare the witness's events with the authority's records
    Model routes:
      LLM API provider  a pi-ai provider route that takes an API key, such as openai, anthropic, deepseek, or xai, and its model ID
      Local Codex       --model-provider codex-local --model default, after codex login
    Default home: ~/.vardock
    "
  `)
  const invalid = await run(['setup', ...localCodex, '--port', '65536'])
  expect(invalid.code).toBe(1)
  expect(invalid.stderr).toContain('a port from 0 through 65535')
  expect((await run(['start', '--authority-patch', 'file.yml'])).stderr).toContain('Use --authority-patch only with setup.')
  expect((await run(['start', '--review-scripts'])).stderr).toContain('Use --review-scripts only with setup.')
  expect((await run(['stop', '--no-open'])).stderr).toContain('Use --no-open with start.')
  expect((await run(['start', '--model-provider', 'openai', '--model', 'fixture-model'])).stderr).toContain('Use --model-provider and --model only with setup.')
})

it.skipIf(process.platform === 'win32')('refuses setup without a model route, listing the routes, before changing anything', async (test) => {
  const { home, calls, run } = fixture(test)
  for (const args of [[], ['--model', 'fixture-model'], ['--model-provider', 'openai']]) {
    const result = await run(['setup', ...args])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`Choose the model route with --model-provider <route> --model <id>:
  LLM API provider  a pi-ai provider route that takes an API key, such as openai, anthropic, deepseek, or xai, and its model ID
  Local Codex       --model-provider codex-local --model default, after codex login
`)
  }
  expect(calls()).toEqual([])
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32')('prepares an API provider route without a Codex login and asks for its key', async (test) => {
  const { home, calls, run } = fixture(test)
  const setup = await run(['setup', '--model-provider', 'openai', '--model', 'fixture-model'])
  expect(setup).toMatchObject({ code: 0, stderr: '' })
  expect(setup.stdout).toContain('Then save the model API key under Plugins, Connections.')
  expect(calls().filter(([name]) => name === 'codex')).toEqual([])
  const authority: unknown = JSON.parse(readFileSync(join(home, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8'))
  expect(authority).toMatchObject([{ insert: [
    { id: 'subprocess' }, { id: 'llm' },
    { id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } } },
    { id: 'execution-container' }, { id: 'credentials' }, { id: 'operation-broker' },
    { id: 'operation-control', config: { principalId: 'owner', unattendedShell: true, model: { provider: 'openai', model: 'fixture-model', credentialRef: 'OPENAI_API_KEY' } } },
  ] }])
})

it.skipIf(process.platform === 'win32')('prepares a fresh deployment and keeps existing settings and state on repeat', async (test) => {
  const { home, checkout, calls, run } = fixture(test)
  const setup = await run(['setup', ...localCodex, '--port', '3080'])
  expect(setup.stderr).toBe('')
  expect(setup.code).toBe(0)
  expect(setup.stdout).toBe(`Prepared Vardock in ${home}. Run pnpm vardock start --home '${home}'.\n`)
  expect(calls()).toContainEqual(['codex', 'login', 'status'])
  const authority: unknown = JSON.parse(readFileSync(join(home, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8'))
  expect(authority).toMatchObject([{ insert: [
    { id: 'subprocess' }, { id: 'llm' }, { id: 'llm-codex' },
    { id: 'execution-container' }, { id: 'credentials' }, { id: 'operation-broker' },
    { id: 'operation-control', config: { principalId: 'owner', unattendedShell: true, model: { provider: 'codex-local', model: 'default' } } },
  ] }])
  expect(roles.map(role => existsSync(join(home, `${label}.${role}.plist`)))).toEqual([true, true, true])
  const changes = calls().filter(([name, operation]) =>
    (name === 'pnpm' && operation === 'run') || (name === 'container' && ['system', 'build'].includes(operation ?? '')))
  expect(changes).toEqual([
    ['pnpm', 'run', 'build:artifacts'],
    ['container', 'system', 'status', '--format', 'json'],
    ['container', 'system', 'start', '--enable-kernel-install'],
    ['container', 'system', 'status', '--format', 'json'],
    ['container', 'build', '-t', 'dsh-execution:local', join(checkout, 'packages/experimental/execution-container')],
  ])
  const plist = readFileSync(join(home, `${label}.web.plist`), 'utf8')
  expect(plist).toContain('<string>3080</string>')
  const patch = join(home, 'authority/profiles/operation-authority/cordis.patch.yml')
  appendFileSync(patch, '# operator edit\n')
  const edited = readFileSync(patch, 'utf8')
  const data = join(home, 'web', 'saved-session')
  writeFileSync(data, 'session data')
  const before = calls().length
  const repeated = await run(['setup', ...localCodex])
  expect(repeated.code).toBe(1)
  expect(repeated.stderr).toContain('already exists')
  expect(readFileSync(patch, 'utf8')).toBe(edited)
  expect(readFileSync(data, 'utf8')).toBe('session data')
  expect(calls().slice(before).filter(([name, action]) => name !== 'sw_vers' && action !== 'print')).toEqual([])
})

it.skipIf(process.platform === 'win32').for(['darwin', 'linux'])('asks before every script on %s when setup selects review-scripts', async (platform, test) => {
  const { home, run } = fixture(test, platform)
  expect(await run([...(platform === 'linux' ? linuxSetup : ['setup', ...localCodex]), '--review-scripts'])).toMatchObject({ code: 0, stderr: '' })
  const authority = JSON.parse(readFileSync(join(home, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8')) as {
    insert: { id: string; config?: { unattendedShell?: boolean } }[]
  }[]
  expect(authority[0]?.insert.find(row => row.id === 'operation-control')?.config?.unattendedShell).toBe(false)
})

it.skipIf(process.platform === 'win32')('rejects another deployment before setup, startup, or teardown changes anything', async (test) => {
  const { root, home, calls, state, run } = fixture(test)
  state({ witness: { home: join(root, 'other-home') }, web: { home } })
  for (const command of [['setup', ...localCodex], ['start'], ['stop']]) {
    const result = await run(command)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Stop the other deployment from its home first.')
  }
  expect(calls().filter(([name, action]) => name !== 'sw_vers' && action !== 'print')).toEqual([])
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32')('refuses a deployment prepared with the earlier launchd labels until it is migrated', async (test) => {
  const { home, calls, state, run } = fixture(test)
  const unchanged = () => calls().filter(([name, action]) => name !== 'sw_vers' && action !== 'print')
  const steps = (stderr: string) => {
    expect(stderr).toContain(`A deployment prepared with the earlier launchd labels ${earlierLabel}.<role> is loaded or in ${home}.`)
    expect(stderr).toContain(`launchctl bootout gui/${process.getuid?.()}/${earlierLabel}.<role> for web, authority, then witness`)
    expect(stderr).toContain(`rename each ${earlierLabel}.<role>.plist to ${label}.<role>.plist and run plutil -replace Label -string ${label}.<role>`)
  }

  // Jobs of an earlier deployment are loaded under the earlier labels, from any home.
  state({}, false, false, ['witness', 'authority', 'web'])
  const setup = await run(['setup', ...localCodex])
  expect(setup.code).toBe(1)
  steps(setup.stderr)
  expect(existsSync(home)).toBe(false)

  // A stopped earlier home still carries the earlier job files.
  state()
  mkdirSync(home, { mode: 0o700 })
  for (const role of roles) writeFileSync(join(home, `${earlierLabel}.${role}.plist`), '', { mode: 0o600 })
  for (const command of [['start'], ['stop'], ['doctor'], ['verify']]) {
    const result = await run(command)
    expect(result.code).toBe(1)
    steps(result.stderr)
  }
  expect(unchanged()).toEqual([])
})

it.skipIf(process.platform === 'win32')('leaves a partial startup visible for an explicit stop', async (test) => {
  const { home, calls, run, state, socketPaths, listen } = fixture(test)
  expect((await run(['setup', ...localCodex])).code).toBe(0)
  state({ authority: { home, exitCode: 78 } }, true, true)
  const witness = createSocketServer((socket) => { socket.end() })
  await listen(witness, (ready) => { witness.listen(socketPaths.evidence, ready) })

  const failed = await run(['start'])
  expect(failed.code).toBe(1)
  expect(failed.stderr).toContain('authority exited with code 78')
  const log = join(home, 'authority/stderr.log')
  const profile = join(home, 'authority/profiles/operation-authority/cordis.patch.yml')
  expect(failed.stderr).toContain(`Read ${log} for the startup error. Check ${profile}`)
  expect(failed.stderr).toContain('pnpm vardock stop')
  const diagnosed = await run(['doctor'])
  expect(diagnosed.code).toBe(1)
  expect(diagnosed.stdout).toContain(`Fix authority. Job is loaded but unready. Last exit code 78. Read ${log} for the startup error. Check ${profile}`)
  const launchChanges = () => calls().filter(([, operation]) => operation === 'bootstrap' || operation === 'bootout')
  expect(launchChanges().map(([, , , path]) => basename(path ?? ''))).toEqual([`${label}.witness.plist`])

  expect((await run(['stop'])).code).toBe(0)
  expect(launchChanges().slice(1).map(([, action, target]) => [action, target?.split('/').at(-1)])).toEqual([
    ['bootout', `${label}.authority`],
    ['bootout', `${label}.witness`],
  ])
})

it.skipIf(process.platform === 'win32')('waits for the current Web token, reuses jobs, and stops only the owned jobs', async (test) => {
  const { home, calls, run, socketPaths, listen } = fixture(test)
  expect((await run(['setup', ...localCodex])).code).toBe(0)
  for (const path of Object.values(socketPaths)) {
    const server = createSocketServer((socket) => { socket.end() })
    await listen(server, (ready) => { server.listen(path, ready) })
  }

  const webLog = join(home, 'web/stdout.log')
  const requests: string[] = []
  const web = createHttpServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    if (path === '/?token=current-owner-token') {
      response.writeHead(303, { location: './', 'set-cookie': 'test=ok' }).end()
    } else {
      appendFileSync(webLog, `dsh web: http://127.0.0.1:${port}/?token=current-owner-token\n`)
      response.writeHead(401).end()
    }
  })
  await listen(web, (ready) => { web.listen(0, '127.0.0.1', ready) })
  const address = web.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback TCP address.')
  const port = address.port
  writeFileSync(webLog, `dsh web: http://127.0.0.1:${port}/?token=stale-owner-token\n`, { mode: 0o600 })

  const started = await run(['start'], port)
  expect(started).toMatchObject({ code: 0, stdout: 'Vardock is ready.\n', stderr: '' })
  expect(requests).toEqual(['/?token=stale-owner-token', '/?token=current-owner-token'])
  const mutations = () => calls().filter(([name, action]) => name === 'open' || ['bootstrap', 'bootout'].includes(action ?? ''))
  expect(mutations().map(([name, action, , path]) => name === 'open' ? name : [action, basename(path ?? '')])).toEqual([
    ...roles.map(role => ['bootstrap', `${label}.${role}.plist`]),
    'open',
  ])
  expect(mutations().at(-1)).toEqual(['open', `http://127.0.0.1:${port}/?token=current-owner-token`])
  expect(await run(['start', '--no-open'], port)).toMatchObject({ code: 0, stderr: '' })
  expect(mutations()).toHaveLength(4)

  const authority = join(home, 'authority/profiles/operation-authority/cordis.patch.yml')
  const expired = readFileSync(authority, 'utf8').replace(/"grantExpiresAt": \d+/u, '"grantExpiresAt": 1')
  writeFileSync(authority, expired)
  const diagnosed = await run(['doctor'], port)
  expect(diagnosed.code).toBe(0)
  expect(diagnosed.stdout).toContain('Review current usage limits and work outcomes in the Assistant entrance.')
  expect(diagnosed.stdout).toContain('OK  web (ready)')
  expect(diagnosed.stdout).not.toContain('owner-token')
  expect(mutations()).toHaveLength(4)

  expect(await run(['stop'], port)).toMatchObject({ code: 0, stdout: 'Vardock is stopped.\n', stderr: '' })
  expect(mutations().slice(4).map(([, action, target]) => [action, target?.split('/').at(-1)])).toEqual(
    roles.toReversed().map(role => ['bootout', `${label}.${role}`]),
  )
  expect(readFileSync(authority, 'utf8')).toBe(expired)
})

it.skipIf(process.platform === 'win32')('writes explicitly permitted action IDs', async (test) => {
  const { home, run } = fixture(test)
  vi.stubEnv('NODE_OPTIONS', `--import ${import.meta.resolve('tsx/esm')}`)
  vi.stubEnv('TSX_TSCONFIG_PATH', fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)))
  test.onTestFinished(() => { vi.unstubAllEnvs() })
  const setup = ['setup', '--model-provider', 'openai', '--model', 'fixture-model']
  const prepared = await run([...setup, '--permit-action', 'read-records', '--permit-action', 'create-record'])
  expect(prepared.code, prepared.stderr).toBe(0)
  const { load } = await import('js-yaml')
  const layers = load(readFileSync(join(home, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8')) as { insert: { id: string }[] }[]
  expect(layers.flatMap(layer => layer.insert).find(row => row.id === 'operation-control')).toMatchObject({ config: {
    assistant: { permissions: { brokerActions: ['read-records', 'create-record'], data: { returnResponses: true } } },
    model: { provider: 'openai', model: 'fixture-model' },
  } })
})

it.skipIf(process.platform === 'win32')('requires an explicit Linux runtime and refuses the flag on macOS before changing anything', async (test) => {
  const linux = fixture(test, 'linux')
  for (const runtime of [[], ['--runtime', ''], ['--runtime', 'unsupported']]) {
    const result = await linux.run(['setup', ...localCodex, ...runtime])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Choose --runtime runc, runsc, or kata explicitly')
  }
  expect(linux.calls()).toEqual([])
  expect(existsSync(linux.home)).toBe(false)
  expect((await linux.run(['--help'])).stdout).toContain('--runtime <runc|runsc|kata>')
  const mac = fixture(test)
  expect((await mac.run([...linuxSetup])).stderr).toBe('Use --runtime only with Linux setup.\n')
  expect(mac.calls()).toEqual([])
  expect((await linux.run(['doctor', '--runtime', 'runc'])).stderr).toBe('Use --runtime only with setup.\n')
  const kata = fixture(test, 'linux')
  expect((await kata.run([...linuxSetup.slice(0, -1), 'kata'])).code).toBe(0)
  const layers = JSON.parse(readFileSync(join(kata.home, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8')) as { insert: { id: string; config: { runtime?: string } }[] }[]
  expect(layers.flatMap(layer => layer.insert).find(row => row.id === 'execution-container')?.config.runtime).toBe('io.containerd.kata.v2')
  expect((await kata.run(['doctor'])).stdout).toContain('unverified by this project')
})

it.skipIf(process.platform === 'win32')('refuses unsupported platforms before running commands', async (test) => {
  const { home, run, calls } = fixture(test, 'freebsd')
  expect((await run(['setup', ...localCodex])).stderr).toContain('Vardock supports macOS and Linux only.')
  expect(calls()).toEqual([])
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32')('rejects a unit that fails systemd verification before enabling services', async (test) => {
  const { run, linuxState, calls } = fixture(test, 'linux')
  expect((await run(linuxSetup)).code).toBe(0)
  linuxState({ invalidUnit: true })
  const result = await run(['start'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Check the witness user service file')
  expect(calls().some(call => call.includes('enable'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('requires lingering and prints the command the owner must run', async (test) => {
  const { home, run, linuxState, calls } = fixture(test, 'linux')
  linuxState({ linger: false })
  const result = await run(linuxSetup)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain(`sudo loginctl enable-linger ${process.getuid?.()}`)
  expect(existsSync(home)).toBe(false)
  expect(calls().some(call => call.includes('enable-linger'))).toBe(false)
  expect((await run(['doctor'])).stdout).toContain(`sudo loginctl enable-linger ${process.getuid?.()}`)
})

it.skipIf(process.platform === 'win32')('reports an unavailable user manager before preparing a home', async (test) => {
  const { home, run, linuxState } = fixture(test, 'linux')
  linuxState({ managerUnavailable: true })
  const result = await run(linuxSetup)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Start an operational systemd user manager')
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32')('refuses a nonlocal Docker endpoint', async (test) => {
  const { home, run, linuxState } = fixture(test, 'linux')
  linuxState({ dockerEndpoint: 'tcp://127.0.0.1:2375' })
  const result = await run(linuxSetup)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Select a Docker context with a local unix:// socket')
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32').for([
  ['CgroupVersion', '1'], ['MemoryLimit', false], ['PidsLimit', false], ['CpuCfsQuota', false], ['Runtimes', {}],
] as const)('refuses Docker without the required %s support', async ([field, value], test) => {
  const { home, run, linuxState } = fixture(test, 'linux')
  linuxState({ dockerInfo: {
    CgroupVersion: '2', MemoryLimit: true, PidsLimit: true, CpuCfsQuota: true, Runtimes: { runc: {} },
    [field]: value,
  } })
  const result = await run(linuxSetup)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain(field === 'Runtimes' ? 'Install and register Docker runtime runc' : `Docker must report ${field}=`)
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32')('checks Docker from the user service manager and explains stale group membership', async (test) => {
  const { home, run, linuxState, calls } = fixture(test, 'linux')
  linuxState({ serviceDocker: false })
  const result = await run(linuxSetup)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('The user service manager cannot reach Docker')
  expect(result.stderr).toContain(`sudo systemctl restart user@${process.getuid?.()}.service`)
  expect(existsSync(home)).toBe(false)
  expect(calls().find(([name]) => name === 'systemd-run')).toEqual([
    'systemd-run', '--user', '--wait', '--pipe', '--collect', '--quiet', '--', expect.any(String),
    '--host', 'unix:///var/run/docker.sock', 'info', '--format', '{{json .}}',
  ])
  expect(calls().some(call => call.includes('restart'))).toBe(false)
  expect((await run(['doctor'])).stdout).toContain('cannot reach Docker')
})

it.skipIf(process.platform === 'win32')('refuses units loaded from another home before enabling or disabling anything', async (test) => {
  const { root, home, state, calls, run } = fixture(test, 'linux')
  state({ witness: { home: join(root, 'other-home') }, web: { home } })
  for (const args of [linuxSetup, ['start'], ['stop']]) {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Stop the other deployment from its home first.')
  }
  expect(calls().some(call => call.includes('enable') || call.includes('disable'))).toBe(false)
  expect(existsSync(home)).toBe(false)
})

it.skipIf(process.platform === 'win32')('disables inactive Linux units so they cannot restart after boot', async (test) => {
  const { home, state, calls, run } = fixture(test, 'linux')
  state(Object.fromEntries(roles.map(role => [role, { home, inactive: true }])))
  expect(await run(['stop'])).toMatchObject({ code: 0, stdout: 'Vardock is stopped.\n', stderr: '' })
  expect(calls().filter(call => call[0] === 'systemctl' && call[2] === 'disable')).toEqual(
    roles.toReversed().map(role => ['systemctl', '--user', 'disable', '--now', join(home, `${label}.${role}.service`)]),
  )
})

it.skipIf(process.platform === 'win32')('waits for each Linux service before enabling the next, prints the URL, and disables in reverse order', async (test) => {
  const { home, run, calls, socketPaths, listen } = fixture(test, 'linux')
  expect((await run(linuxSetup)).code).toBe(0)
  for (const path of Object.values(socketPaths)) {
    const server = createSocketServer((socket) => { socket.end() })
    await listen(server, (ready) => { server.listen(path, ready) })
  }
  const web = createHttpServer((_request, response) => {
    response.writeHead(303, { location: './', 'set-cookie': 'test=ok' }).end()
  })
  await listen(web, (ready) => { web.listen(0, '127.0.0.1', ready) })
  const address = web.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback TCP address.')
  const url = `http://127.0.0.1:${address.port}/?token=current-owner-token`
  appendFileSync(join(home, 'web/stdout.log'), `dsh web: ${url}\n`)
  expect(await run(['start'], address.port)).toMatchObject({ code: 0, stdout: `Vardock is ready.\n${url}\n`, stderr: '' })
  const trace = calls()
  const enables = trace.flatMap((call, index) => call[1] === '--user' && call[2] === 'enable' ? [index] : [])
  expect(enables.map(index => trace[index])).toEqual(roles.map(role => [
    'systemctl', '--user', 'enable', '--now', join(home, `${label}.${role}.service`),
  ]))
  for (let index = 0; index < enables.length; index++) {
    if (index === 0) continue
    const preceding = trace.slice(0, enables[index]).findLast(([name]) => name === 'lsof')
    expect(preceding).toContain(String(2147483600 + index - 1))
  }
  expect(await run(['start', '--no-open'], address.port)).toMatchObject({ code: 0, stdout: `Vardock is ready.\n${url}\n` })
  const diagnosed = await run(['doctor'], address.port)
  expect(diagnosed.code).toBe(0)
  expect(diagnosed.stdout).toContain('OK  web (ready)')
  expect(diagnosed.stdout).toContain('OK  Docker and execution image')
  expect(diagnosed.stdout).toContain('not a VM boundary')
  expect(diagnosed.stdout).not.toContain('owner-token')
  expect(await run(['stop'])).toMatchObject({ code: 0, stdout: 'Vardock is stopped.\n', stderr: '' })
  expect(calls().filter(call => call[0] === 'systemctl' && call[2] === 'disable')).toEqual(
    roles.toReversed().map(role => ['systemctl', '--user', 'disable', '--now', join(home, `${label}.${role}.service`)]),
  )
  expect(calls().filter(([name]) => name === 'open')).toEqual([])
})
