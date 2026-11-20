/** Apple silicon host checks, launchd jobs, and Apple Container execution for Vardock. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const domain = `gui/${process.getuid?.()}`
const earlierPrefix = 'io.deepseek.dsh.assistant-dev'

function hostCheck({ run }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64'
    || !(Number.parseInt(run('/usr/bin/sw_vers', ['-productVersion']).stdout ?? '', 10) >= 26)) {
    throw new Error('Use a native Apple silicon terminal and Node.js on macOS 26 or newer.')
  }
}

function containerRunning(container, { run }) {
  const result = run(container, ['system', 'status', '--format', 'json'], { timeout: 15_000 })
  const message = 'Check the Apple container installation with container system status.'
  let state
  try {
    state = JSON.parse(result.stdout)?.status
  } catch (cause) {
    throw new Error(message, { cause })
  }
  if (result.status === 0 && state === 'running') return true
  if (result.status === 1 && ['not running', 'unregistered'].includes(state)) return false
  throw new Error(message)
}

function ensureContainerRunning(container, commands) {
  const { run, requireSuccess } = commands
  if (containerRunning(container, commands)) return
  requireSuccess(run(container, ['system', 'start', '--enable-kernel-install'], { interactive: true }),
    'Run container system start --enable-kernel-install and resolve the reported error.')
  if (!containerRunning(container, commands)) throw new Error('Apple container did not report running. Check container system status.')
}

function imageAvailable(container, image, { run, requireSuccess }) {
  const names = requireSuccess(run(container, ['image', 'list', '--quiet']), 'Check the Apple container image list.')
  return names.split(/\r?\n/u).includes(image)
}

function jobStatus(job, { run, requireSuccess, samePath }) {
  const result = run('/bin/launchctl', ['print', `${domain}/${job.label}`])
  // launchctl's EServiceNotFound is distinct from an inaccessible GUI domain.
  if (result.status === 113) return undefined
  const output = requireSuccess(result, 'Run this command from the logged-in macOS desktop session.')
  const path = output.match(/^\tpath = (.+)$/mu)?.[1]
  const home = output.match(/^\tworking directory = (.+)$/mu)?.[1]
  const dshHome = output.match(/^\t\tDSH_HOME => (.+)$/mu)?.[1]
  if (!samePath(path, job.file) || !samePath(home, job.home) || !samePath(dshHome, job.home)) {
    throw new Error(`Cannot verify that the loaded ${job.name} job belongs to this home. Stop the other deployment from its home first.`)
  }
  return {
    pid: Number(output.match(/^\tpid = ([1-9]\d*)$/mu)?.[1]) || undefined,
    exitCode: output.match(/^\tlast exit code = (-?\d+)$/mu)?.[1],
  }
}

function refuseEarlierLabels(root, jobs, { run }, labelPrefix) {
  const loaded = jobs.some(job => run('/bin/launchctl', ['print', `${domain}/${earlierPrefix}.${job.name}`]).status === 0)
  if (!loaded && !jobs.some(job => existsSync(join(root, `${earlierPrefix}.${job.name}.plist`)))) return
  throw new Error(`A deployment prepared with the earlier launchd labels ${earlierPrefix}.<role> is loaded or in ${root}. Before using this command:
  1. Unload its jobs: launchctl bootout ${domain}/${earlierPrefix}.<role> for web, authority, then witness; skip a job that is not loaded.
  2. In its home, rename each ${earlierPrefix}.<role>.plist to ${labelPrefix}.<role>.plist and run plutil -replace Label -string ${labelPrefix}.<role> on the renamed file.
  3. Start it with pnpm vardock start --home <its home>. Leave its authority profile unchanged.`)
}

function checkJobFile(job, { run, requireSuccess, samePath }) {
  const message = `Check the ${job.name} launch agent file at ${job.file}.`
  let plist
  try {
    plist = JSON.parse(requireSuccess(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', job.file]), message))
  } catch (cause) {
    throw new Error(message, { cause })
  }
  if (plist.Label !== job.label || !samePath(plist.WorkingDirectory, job.home)
    || !samePath(plist.EnvironmentVariables?.DSH_HOME, job.home)
    || !samePath(plist.StandardOutPath, join(job.home, 'stdout.log'))) {
    throw new Error(`Check the label, home and stdout path in ${job.file}.`)
  }
  if (!plist.ProgramArguments?.slice(0, 2).every(path => typeof path === 'string' && existsSync(path))
    || plist.ProgramArguments[2] !== '--profile' || plist.ProgramArguments[3] !== job.profile) {
    throw new Error(`Restore the Node.js and built dsh paths and profile in ${job.file}. Run pnpm run build:artifacts if needed.`)
  }
}

function xmlString(value) {
  return `<string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`
}

function jobFile({ label, home }, argv, environment) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${xmlString(label)}
  <key>ProgramArguments</key>
  <array>${argv.map(xmlString).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key>${xmlString(value)}`).join('')}</dict>
  <key>WorkingDirectory</key>${xmlString(home)}
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><string>077</string>
  <key>StandardOutPath</key>${xmlString(join(home, 'stdout.log'))}
  <key>StandardErrorPath</key>${xmlString(join(home, 'stderr.log'))}
</dict>
</plist>
`
}

/** Platform operations used by profile generation and the lifecycle command. */
export default {
  hostLabel: 'macOS and Node.js',
  engineLabel: 'Apple container and execution image',
  engineCommand: 'container',
  backend: 'apple-vm',
  account: 'macOS',
  logFiles: [],
  jobKind: 'launch agents',
  listenerCommand: '/usr/sbin/lsof',
  hostCheck,
  setupUsage: '',
  runtimeGuarantees: undefined,
  resolveRuntime(runtime) {
    if (runtime !== undefined) throw new Error('Use --runtime only with Linux setup.')
  },
  jobFileName: label => `${label}.plist`,
  jobFile,
  checkJobFile,
  jobStatus,
  refuseEarlierLabels,
  load(job, { run, requireSuccess }, recovery) {
    requireSuccess(run('/bin/launchctl', ['bootstrap', domain, job.file]), `Could not load ${job.name}. ${recovery}`)
  },
  unload(job, { run, requireSuccess }) {
    requireSuccess(run('/bin/launchctl', ['bootout', `${domain}/${job.label}`], { timeout: 15_000 }),
      `Could not unload ${job.name}. Check its launchd status before retrying stop.`)
  },
  stoppedMessage: job => `${job.name} has not stopped. Check its launchd status before retrying stop.`,
  engineCheck(container, commands, { start = false } = {}) {
    if (start) ensureContainerRunning(container, commands)
    else if (!containerRunning(container, commands)) throw new Error('Run container system start --enable-kernel-install.')
  },
  imageAvailable,
  buildImage(container, image, context, { run, requireSuccess }) {
    requireSuccess(run(container, ['build', '-t', image, context], { interactive: true }),
      'The execution image build failed. Check the container build output before retrying setup.')
  },
  executionRow(options, gatewaySocket, image) {
    return {
      backend: 'apple-vm', vmCommand: options.engine, image, gatewaySocket, allowedTargets: [],
      timeoutMs: 300_000, gatewayIdleTimeoutMs: 300_000,
    }
  },
  announce(url, noOpen, { run, requireSuccess }, recovery) {
    if (!noOpen) requireSuccess(run('/usr/bin/open', [url.href]), recovery)
  },
}
