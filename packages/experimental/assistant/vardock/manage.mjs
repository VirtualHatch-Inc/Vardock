/** Prepare and operate the private deployment of the existing dsh profiles. */
import { spawnSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { get } from 'node:http'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { executable, image, jobsFor, labelPrefix, localCodex, prepare, repo, socketsFor, platform } from './prepare.mjs'

const routes = `  LLM API provider  a pi-ai provider route that takes an API key, such as openai, anthropic, deepseek, or xai, and its model ID
  Local Codex       --model-provider ${localCodex} --model default, after codex login`
const usage = `Usage: pnpm vardock <setup|start|stop|doctor|verify> [--home <directory>]
  setup --model-provider <route> --model <id> [--port <0-65535>]${platform.setupUsage} [--review-scripts] [--authority-patch <file>] [--permit-action <action-id>]
                           Build dsh and prepare a new private home; --review-scripts asks before every script
  --authority-patch <file> Merge a Cordis patch into the authority profile (repeatable)
  --permit-action <action-id> Write an Assistant broker permission (repeatable); unprovided actions fail authority startup
  start [--no-open]        Start the jobs and open Vardock
  stop                     Unload the jobs
  doctor                   Check setup and running jobs
  verify                   Compare the witness's events with the authority's records
Model routes:
${routes}
Default home: ~/.vardock
`
const actions = ['setup', 'start', 'stop', 'doctor', 'verify']
const checkoutRequire = createRequire(join(repo, 'package.json'))
const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
const uid = process.getuid?.()
const commands = { run, requireSuccess, samePath }

function run(command, args, { interactive = false, env = environment, timeout = 5_000 } = {}) {
  return spawnSync(command, args, {
    cwd: repo, env, encoding: 'utf8',
    ...(interactive ? { stdio: 'inherit' } : { timeout, stdio: ['ignore', 'pipe', 'pipe'] }),
  })
}

function requireSuccess(result, message) {
  if (result.status !== 0) throw new Error(message)
  return result.stdout
}

function hostCheck(prerequisites = false) {
  platform.hostCheck(commands, prerequisites)
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) throw new Error('Install Node.js 24.9 or newer.')
}

function checkWorkspace() {
  const { packageManager } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const version = packageManager.slice('pnpm@'.length)
  const pnpm = executable('pnpm')
  if (run(pnpm, ['--version']).stdout?.trim() !== version) throw new Error(`Use pnpm ${version} for this checkout.`)
  if (!existsSync(join(repo, 'node_modules', '.bin', 'tsx'))) throw new Error('Run pnpm install from the checkout.')
  return pnpm
}

function checkCodex() {
  const codex = executable('codex')
  const env = { ...environment, HOME: homedir() }
  delete env.CODEX_HOME
  requireSuccess(run(codex, ['login', 'status'], { env }), `Run codex login for this ${platform.account} account.`)
  return codex
}

function actionFor(action, root) {
  const home = "'" + root.replaceAll("'", "'\\''") + "'"
  return `pnpm vardock ${action} --home ${home}`
}

function samePath(actual, expected) {
  return actual === expected || (actual !== undefined && existsSync(actual) && existsSync(expected)
    && realpathSync(actual) === realpathSync(expected))
}

function privatePath(path, directory = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat !== undefined && stat.uid === uid && (stat.mode & 0o077) === 0
    && (directory ? stat.isDirectory() : stat.isFile())
}

function preparedJob(job) {
  const files = [job.file, join(job.profilePath, 'package.json'), join(job.profilePath, 'cordis.patch.yml')]
  if (!privatePath(job.home, true) || files.some(path => !privatePath(path))) {
    throw new Error(`The ${job.name} job or profile is missing or lacks private permissions in ${job.home}.`)
  }
  platform.checkJobFile(job, commands)
}

function authoritySettings(jobs) {
  const authority = jobs.find(job => job.name === 'authority')
  const path = join(authority.profilePath, 'cordis.patch.yml')
  try {
    const layers = checkoutRequire('js-yaml').load(readFileSync(path, 'utf8'))
    const rows = layers.flatMap(layer => layer.insert ?? [layer])
    return rows.findLast(row => row.id === 'execution-container')?.config
  } catch (cause) {
    throw new Error(`Check the authority profile at ${path} and run pnpm install if dependencies are missing.`, { cause })
  }
}

function socketOpen(path) {
  return new Promise(done => {
    const socket = createConnection(path)
    const finish = ready => { socket.destroy(); done(ready) }
    socket.setTimeout(1_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function authenticated(url) {
  return new Promise(done => {
    const request = get(url, { agent: false, signal: AbortSignal.timeout(1_000) }, response => {
      const ready = response.statusCode === 303 && response.headers.location === './'
        && response.headers['set-cookie']?.length > 0
      response.destroy()
      done(ready)
    })
    request.once('error', () => done(false))
  })
}

function loggedWebUrl(home) {
  let fd
  try {
    fd = openSync(join(home, 'stdout.log'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return undefined
    const output = readFileSync(fd, 'utf8')
    const line = [...output.matchAll(/^dsh web: (http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/\?token=[\w-]+)$/gmu)].at(-1)?.[1]
    if (line === undefined) return undefined
    return URL.parse(line) ?? undefined
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read the private Web log in ${home}.`, { cause: error })
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

async function ready(job, pid, sockets) {
  if (pid === undefined) return false
  if (job.name === 'web') {
    const url = loggedWebUrl(job.home)
    if (url === undefined) return false
    const port = url.port || '80'
    const listeners = run(platform.listenerCommand, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'])
    // Verify the listener before sending the owner token, even when a port was reused.
    if (listeners.status !== 0 || !listeners.stdout.split('\n').includes(`n${url.hostname}:${port}`)
      || listeners.stdout.match(/^p\d+$/gmu)?.join() !== `p${pid}`) return false
    return await authenticated(url) ? url : false
  }
  const listeners = run(platform.listenerCommand, ['-nP', '-a', '-p', String(pid), '-U', '-Fn'])
  if (listeners.status !== 0) return false
  // Linux lsof appends the socket type to Unix socket names.
  const paths = listeners.stdout.split('\n').filter(line => line.startsWith('n')).map(line => process.platform === 'linux' ? line.slice(1).replace(/ type=\w+$/u, '') : line.slice(1))
  const expected = job.name === 'witness' ? [sockets.evidence] : [sockets.operation, sockets.approval]
  if (!expected.every(path => paths.some(listener => samePath(listener, path)))) return false
  return (await Promise.all(expected.map(socketOpen))).every(Boolean)
}

async function waitFor(check, message) {
  const deadline = performance.now() + 20_000
  do {
    const result = await check()
    if (result) return result
    await delay(200)
  } while (performance.now() < deadline)
  throw new Error(message)
}

function processGone(pid) {
  if (pid === undefined) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}

async function start(root, jobs, sockets, noOpen) {
  if (!privatePath(root, true)) throw new Error(`Use ${actionFor('setup', root)} for a new private home.`)
  for (const job of jobs) preparedJob(job)
  const settings = authoritySettings(jobs)
  if (settings?.backend === platform.backend) platform.engineCheck(executable(platform.engineCommand), commands, { start: true, settings })
  let url
  for (const job of jobs) {
    const recovery = `Read ${join(job.home, 'stderr.log')} for the startup error. Check ${join(job.profilePath, 'cordis.patch.yml')}, then run ${actionFor('stop', root)} before retrying.`
    const existing = platform.jobStatus(job, commands)
    if (existing === undefined || existing.stopped) {
      platform.load(job, commands, recovery)
    }
    const result = await waitFor(async () => {
      const status = platform.jobStatus(job, commands)
      if (status?.pid === undefined && status?.exitCode !== undefined && status.exitCode !== '0') {
        throw new Error(`${job.name} exited with code ${status.exitCode}. ${recovery}`)
      }
      return ready(job, status?.pid, sockets)
    }, `${job.name} did not become ready. ${recovery}`)
    if (job.name === 'web') url = result
  }
  console.log('Vardock is ready.')
  platform.announce(url, noOpen, commands,
    `Vardock is running but the browser could not open. Rerun ${actionFor('start', root)} to try again.`)
}

async function stop(jobs) {
  for (const job of jobs.toReversed()) {
    const status = platform.jobStatus(job, commands)
    if (status === undefined) continue
    platform.unload(job, commands)
    await waitFor(() => {
      const current = platform.jobStatus(job, commands)
      return (current === undefined || current.stopped) && processGone(status.pid)
    }, platform.stoppedMessage(job))
  }
  console.log('Vardock is stopped.')
}

async function doctor(root, jobs, sockets) {
  let healthy = true
  async function check(label, inspect) {
    try {
      const detail = await inspect()
      console.log(`OK  ${label}${detail === undefined ? '' : ` (${detail})`}`)
    } catch (error) {
      healthy = false
      console.log(`Fix ${label}. ${error.message}`)
    }
  }

  await check(platform.hostLabel, () => hostCheck(true))
  await check('pnpm and checkout dependencies', () => { checkWorkspace() })
  // Only a Local Codex deployment has the Codex adapter in its authority profile.
  const authority = jobs.find(job => job.name === 'authority')
  if (existsSync(join(authority.profilePath, 'node_modules/@deepseek-ai/dsh-llm-codex'))) {
    await check('Codex login', () => { checkCodex() })
  }
  const prepared = privatePath(root, true)
  await check('private Vardock home', () => {
    if (!prepared) throw new Error(`Use ${actionFor('setup', root)} with a new directory.`)
    for (const job of jobs) preparedJob(job)
    return root
  })
  let settings
  if (prepared) await check('authority profile', () => { settings = authoritySettings(jobs) })
  if (platform.runtimeGuarantees !== undefined && settings !== undefined) {
    await check('execution runtime', () => {
      const guarantee = platform.runtimeGuarantees[settings.runtime]
      if (!Object.hasOwn(platform.runtimeGuarantees, settings.runtime)) throw new Error('Restore runtime runc, runsc, or io.containerd.kata.v2 in the authority profile.')
      return `${settings.runtime}: ${guarantee}`
    })
  }
  if (settings?.backend === platform.backend || !prepared) {
    await check(platform.engineLabel, () => {
      const engine = executable(platform.engineCommand)
      const socket = platform.engineCheck(engine, commands, { settings })
      if (!platform.imageAvailable(engine, image, commands, socket)) throw new Error('Build the execution image using the checkout Dockerfile.')
    })
  }
  for (const job of jobs) {
    await check(job.name, async () => {
      const status = platform.jobStatus(job, commands)
      if (status === undefined) throw new Error(`Job is stopped. Use ${actionFor('start', root)} after setup.`)
      if (!(await ready(job, status.pid, sockets))) {
        const exit = status.exitCode === undefined ? '' : ` Last exit code ${status.exitCode}.`
        throw new Error(`Job is loaded but unready.${exit} Read ${join(job.home, 'stderr.log')} for the startup error. Check ${join(job.profilePath, 'cordis.patch.yml')}, then run ${actionFor('stop', root)} before retrying.`)
      }
      return 'ready'
    })
  }
  console.log('Review current usage limits and work outcomes in the Assistant entrance.')
  return healthy
}

async function verify(sockets) {
  const load = name => import(pathToFileURL(join(repo, 'packages', 'experimental', name, 'lib', 'library.js')).href)
  const [{ OperationControlClient, verifyRecords }, { EvidenceClient }] = await Promise.all([load('operation-control'), load('operation-evidence')])
  const { events, compared, other, problems } = await verifyRecords(
    new OperationControlClient({ socketPath: sockets.approval }), new EvidenceClient({ socketPath: sockets.evidence }),
  )
  console.log(`Read ${events} witness events and compared ${compared} records, including the current configuration record, with the authority's receipts. ${other} other settings and lookup events have no receipt and were not compared.`)
  const meanings = {
    'operation-missing': 'the authority has no record of this operation',
    'receipt-missing': 'the authority has the operation but not this receipt; this also happens when the authority stopped '
      + 'between the witness acknowledgment and its own commit',
    'digest-mismatch': "the authority's receipt names different content",
    'event-missing': 'the witness has no event for the configuration record the authority holds a receipt for',
  }
  for (const { eventId, problem } of problems) console.log(`Mismatch ${eventId}: ${problem} (${meanings[problem]})`)
  console.log(problems.length === 0 ? 'OK  Every compared event matches.' : `Found ${problems.length} mismatches. This command does not determine which cause applies.`)
  return problems.length === 0
}

async function main(args) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      home: { type: 'string' }, port: { type: 'string' }, 'model-provider': { type: 'string' }, model: { type: 'string' }, runtime: { type: 'string' },
      'authority-patch': { type: 'string', multiple: true }, 'permit-action': { type: 'string', multiple: true }, 'review-scripts': { type: 'boolean' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || args.length === 0) {
    console.log(usage.trimEnd())
    return
  }
  const [action] = positionals
  if (positionals.length !== 1 || !actions.includes(action)) throw new Error('Choose setup, start, stop, doctor, or verify. See pnpm vardock --help.')
  if (values.port !== undefined && (action !== 'setup' || !/^\d{1,5}$/u.test(values.port) || Number(values.port) > 65_535)) {
    throw new Error('Use --port with setup and a port from 0 through 65535.')
  }
  if (values['authority-patch'] !== undefined && action !== 'setup') throw new Error('Use --authority-patch only with setup.')
  if (values['permit-action'] !== undefined && action !== 'setup') throw new Error('Use --permit-action only with setup.')
  if (values['review-scripts'] && action !== 'setup') throw new Error('Use --review-scripts only with setup.')
  if (values['no-open'] && action !== 'start') throw new Error('Use --no-open with start.')
  const modelRoute = values['model-provider'] === undefined || values.model === undefined
    ? undefined : { provider: values['model-provider'], model: values.model }
  if (action !== 'setup' && (values['model-provider'] !== undefined || values.model !== undefined)) {
    throw new Error('Use --model-provider and --model only with setup.')
  }
  if (values.runtime !== undefined && action !== 'setup') throw new Error('Use --runtime only with setup.')
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    platform.hostCheck(commands)
  }
  if (action === 'setup' && modelRoute === undefined) {
    throw new Error(`Choose the model route with --model-provider <route> --model <id>:\n${routes}`)
  }
  const runtime = action === 'setup' ? platform.resolveRuntime(values.runtime) : undefined
  if (values.home === '') throw new Error('Provide a directory after --home.')
  // Doctor reports host failures as Fix lines; other actions refuse before jobsFor/socketsFor.
  if (action !== 'doctor') {
    hostCheck(action === 'setup')
  }
  const requested = resolve(values.home ?? join(homedir(), '.vardock'))
  const parent = dirname(requested)
  const root = existsSync(parent) ? join(realpathSync(parent), basename(requested)) : requested
  const jobs = jobsFor(root)
  const sockets = socketsFor(root)
  platform.refuseEarlierLabels(root, jobs, commands, labelPrefix)

  if (action === 'doctor') {
    if (!(await doctor(root, jobs, sockets))) process.exitCode = 1
    return
  }
  if (action === 'verify') {
    if (!(await verify(sockets))) process.exitCode = 1
    return
  }
  // Check every fixed label before doing anything that could affect a deployment.
  for (const job of jobs) platform.jobStatus(job, commands)
  switch (action) {
    case 'setup': {
      if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
        throw new Error(`${root} already exists. Use ${actionFor('doctor', root)} to check it or choose a new home.`)
      }
      if (!existsSync(parent)) throw new Error('Choose a setup directory whose parent already exists.')
      const pnpm = checkWorkspace()
      const engine = executable(platform.engineCommand)
      const codex = modelRoute.provider === localCodex ? checkCodex() : undefined
      requireSuccess(run(pnpm, ['run', 'build:artifacts'], { interactive: true }), 'The dsh build failed. Check the build output before retrying setup.')
      const dockerSocket = platform.engineCheck(engine, commands, { start: true, settings: { runtime } })
      if (!platform.imageAvailable(engine, image, commands, dockerSocket)) {
        const context = join(repo, 'packages', 'experimental', 'execution-container')
        platform.buildImage(engine, image, context, commands, dockerSocket)
        if (!platform.imageAvailable(engine, image, commands, dockerSocket)) {
          throw new Error(`The execution image is missing after its build. Check ${platform.engineCommand} image list.`)
        }
      }
      await prepare(root, values.port ?? '0', { model: modelRoute, engine, codex, dockerSocket, runtime, reviewScripts: values['review-scripts'], authorityPatches: values['authority-patch'], permitActions: values['permit-action'] })
      console.log(`Prepared Vardock in ${root}. Run ${actionFor('start', root)}.${codex === undefined ? ' Then save the model API key under Plugins, Connections.' : ''}`)
      break
    }
    case 'start':
      await start(root, jobs, sockets, values['no-open'])
      break
    case 'stop':
      await stop(jobs)
      break
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Vardock command failed.')
  process.exitCode = 1
}
