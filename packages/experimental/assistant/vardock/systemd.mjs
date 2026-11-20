/** Linux user services and explicitly selected Docker execution for Vardock. */
import { join } from 'node:path'

/** Isolation and limitations of the operator's selected runtime. */
const runtimeGuarantees = {
  runc: 'runc is an ordinary container sharing the host kernel, not a VM boundary.',
  runsc: 'runsc uses the gVisor user-space kernel, and the process limit does not bound processes inside the work environment.',
  'io.containerd.kata.v2': 'Kata provides a VM boundary in kind and needs KVM; unverified by this project.',
}

function resolveRuntime(runtime) {
  const resolved = runtime === 'kata' ? 'io.containerd.kata.v2' : runtime
  if (!Object.hasOwn(runtimeGuarantees, resolved)) {
    throw new Error('Choose --runtime runc, runsc, or kata explicitly for Linux setup.')
  }
  return resolved
}

function hostCheck({ run, requireSuccess }, prerequisites) {
  if (!prerequisites) return
  const manager = run('systemctl', ['--user', 'is-system-running'])
  if (!((manager.status === 0 && manager.stdout.trim() === 'running')
    || (manager.status === 1 && manager.stdout.trim() === 'degraded'))) {
    throw new Error('Start an operational systemd user manager; check systemctl --user is-system-running.')
  }
  const uid = String(process.getuid())
  const linger = requireSuccess(run('loginctl', ['show-user', uid, '-p', 'Linger']),
    'Check the user account with loginctl show-user.')
  if (linger.trim() !== 'Linger=yes') {
    throw new Error(`Enable lingering before setup: sudo loginctl enable-linger ${uid}`)
  }
}

function unitWord(value, command = false) {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
  return `"${command ? escaped.replaceAll('$', () => '$$') : escaped}"`
}

// WorkingDirectory and append paths expand specifiers but do not unquote command words.
function unitPath(value) {
  return value.replaceAll('%', '%%')
}

function jobFile(job, argv, environment) {
  if ([job.home, ...argv, ...Object.values(environment)].some(value => /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
    throw new Error('Remove control characters from service paths, arguments, and environment values.')
  }
  const previous = { authority: 'witness', web: 'authority' }[job.name]
  const prefix = job.label.slice(0, -job.name.length)
  return `[Unit]
Description=Vardock ${job.name}
${previous === undefined ? '' : `After=${prefix}${previous}.service\n`}
[Service]
ExecStart=${argv.map(value => unitWord(value, true)).join(' ')}
${Object.entries(environment).map(([name, value]) => `Environment=${unitWord(`${name}=${value}`)}`).join('\n')}
WorkingDirectory=${unitPath(job.home)}
UMask=0077
Restart=always
RestartSec=30
StandardOutput=append:${unitPath(join(job.home, 'stdout.log'))}
StandardError=append:${unitPath(join(job.home, 'stderr.log'))}

[Install]
WantedBy=default.target
`
}

function checkJobFile(job, { run, requireSuccess }) {
  requireSuccess(run('systemd-analyze', ['--user', 'verify', job.file]),
    `Check the ${job.name} user service file at ${job.file}.`)
}

function jobStatus(job, { run, requireSuccess, samePath }) {
  const result = run('systemctl', ['--user', 'show', '-p',
    'LoadState,MainPID,ExecMainStatus,FragmentPath,WorkingDirectory,Environment', `${job.label}.service`])
  const output = requireSuccess(result, 'Check access to the systemd user manager with systemctl --user status.')
  const fields = Object.fromEntries(output.trimEnd().split('\n').map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  if (fields.LoadState === 'not-found') return undefined
  if (!samePath(fields.FragmentPath, job.file) || !samePath(fields.WorkingDirectory, job.home)) {
    throw new Error(`Cannot verify that the loaded ${job.name} job belongs to this home. Stop the other deployment from its home first.`)
  }
  const pid = /^[1-9]\d*$/u.test(fields.MainPID) ? Number(fields.MainPID) : undefined
  return { pid, exitCode: fields.ExecMainStatus, stopped: pid === undefined }
}

function engineCheck(docker, commands, { settings } = {}) {
  const { run, requireSuccess } = commands
  let socket = settings?.dockerSocket
  if (socket === undefined) {
    const contextMessage = 'Select a Docker context with a local unix:// socket; check docker context inspect.'
    let context
    try {
      context = JSON.parse(requireSuccess(run(docker, ['context', 'inspect']), contextMessage))
    } catch (cause) {
      throw new Error(contextMessage, { cause })
    }
    const endpoint = context?.[0]?.Endpoints?.docker?.Host
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///')) throw new Error(contextMessage)
    socket = endpoint.slice('unix://'.length)
  }
  const args = ['--host', `unix://${socket}`, 'info', '--format', '{{json .}}']
  // The user manager retains its groups until restarted after docker-group changes.
  const result = run('systemd-run', ['--user', '--wait', '--pipe', '--collect', '--quiet', '--', docker, ...args])
  const message = `The user service manager cannot reach Docker at ${socket}. After adding this user to the docker group, restart the user service manager with sudo systemctl restart user@${process.getuid()}.service, reconnect, then retry. This stops your user services.`
  let info
  try {
    info = JSON.parse(requireSuccess(result, message))
  } catch (cause) {
    throw new Error(message, { cause })
  }
  for (const [name, expected] of [['CgroupVersion', '2'], ['MemoryLimit', true], ['PidsLimit', true], ['CpuCfsQuota', true]]) {
    if (info?.[name] !== expected) throw new Error(`Docker must report ${name}=${expected}; check docker info and enable the required cgroup v2 controller.`)
  }
  if (settings !== undefined && !Object.hasOwn(info.Runtimes ?? {}, settings.runtime)) {
    throw new Error(`Install and register Docker runtime ${settings.runtime}; check docker info.`)
  }
  return socket
}

/** Platform operations used by profile generation and the lifecycle command. */
export default {
  hostLabel: 'Linux, Node.js and user services',
  engineLabel: 'Docker and execution image',
  engineCommand: 'docker',
  backend: 'docker',
  account: 'Linux',
  logFiles: ['stdout.log', 'stderr.log'],
  jobKind: 'user services',
  listenerCommand: 'lsof',
  setupUsage: ' --runtime <runc|runsc|kata>',
  hostCheck,
  resolveRuntime,
  runtimeGuarantees,
  jobFileName: label => `${label}.service`,
  jobFile,
  checkJobFile,
  jobStatus,
  refuseEarlierLabels() {},
  load(job, { run, requireSuccess }, recovery) {
    requireSuccess(run('systemctl', ['--user', 'enable', '--now', job.file]), `Could not load ${job.name}. ${recovery}`)
  },
  unload(job, { run, requireSuccess }) {
    // systemd applies the unit's TimeoutStopSec while this command waits for shutdown.
    requireSuccess(run('systemctl', ['--user', 'disable', '--now', job.file], { timeout: 0 }),
      `Could not unload ${job.name}. Check its systemd user status before retrying stop.`)
  },
  stoppedMessage: job => `${job.name} has not stopped. Check its systemd user status before retrying stop.`,
  engineCheck,
  imageAvailable(docker, image, { run, requireSuccess }, socket) {
    const output = requireSuccess(run(docker, ['--host', `unix://${socket}`, 'image', 'list', '--format', '{{.Repository}}:{{.Tag}}']),
      'Check the Docker image list.')
    return output.split(/\r?\n/u).includes(image)
  },
  buildImage(docker, image, context, { run, requireSuccess }, socket) {
    requireSuccess(run(docker, ['--host', `unix://${socket}`, 'build', '-t', image, context], { interactive: true }),
      'The execution image build failed. Check the Docker build output before retrying setup.')
  },
  executionRow(options, gatewaySocket, image) {
    return {
      backend: 'docker', dockerSocket: options.dockerSocket, gatewaySocket, image, runtime: options.runtime,
      timeoutMs: 300_000, gatewayIdleTimeoutMs: 300_000,
    }
  },
  announce(url) {
    console.log(url.href)
  },
}
