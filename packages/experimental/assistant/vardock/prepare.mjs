/** Write private, same-account development profiles and job definitions. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import launchd from './launchd.mjs'
import systemd from './systemd.mjs'

/** Operations for the current deployment platform. */
export const platform = { darwin: launchd, linux: systemd }[process.platform]
if (platform === undefined) throw new Error('Vardock supports macOS and Linux only.')

const assistant = dirname(import.meta.dirname)
/** Checkout whose built dsh launcher and packages back the generated profiles. */
export const repo = resolve(assistant, '../../..')
/** Image tag shared by the setup command and the generated authority profile. */
export const image = 'dsh-execution:local'
/** Reverse-DNS prefix of the job labels, under the publisher's GitHub organisation. */
export const labelPrefix = 'io.github.virtualhatch-inc.vardock'
/** Model route that selects the Local Codex adapter instead of an API provider through pi-ai. */
export const localCodex = 'codex-local'

/**
 * Locate a command on the operator's PATH.
 * @param {string} name - Command name.
 * @returns {string} Resolved executable path.
 */
export function executable(name) {
  try {
    return realpathSync(execFileSync('/usr/bin/which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd())
  } catch (cause) {
    throw new Error(`Install ${name} and put it on PATH before running this setup.`, { cause })
  }
}

/**
 * Derive the job and profile paths in startup order.
 * @param {string} root - Absolute deployment directory.
 * @returns {object[]} Job definitions and their on-disk locations.
 */
export function jobsFor(root) {
  return [['witness', 'operation-witness'], ['authority', 'operation-authority'], ['web', 'web']].map(([name, profile]) => {
    const label = `${labelPrefix}.${name}`
    const home = join(root, name)
    return { name, profile, label, home, file: join(root, platform.jobFileName(label)), profilePath: join(home, 'profiles', profile) }
  })
}

/**
 * Derive the generated Unix socket paths, rejecting paths the Unix sockets cannot use.
 * @param {string} root - Absolute deployment directory.
 * @returns {{operation: string, evidence: string, approval: string, gateway: string}} Socket paths.
 */
export function socketsFor(root) {
  const sockets = {
    operation: join(root, 'authority', 'operation.sock'),
    evidence: join(root, 'witness', 'evidence.sock'),
    approval: join(root, 'authority', 'approval.sock'),
    gateway: join(root, 'authority', 'gateway.sock'),
  }
  if (Object.values(sockets).some(path => Buffer.byteLength(path) > 103 || /[:\u0000-\u001f]/u.test(path))) {
    throw new Error('Choose a shorter setup directory with no colons or control characters for the Unix sockets.')
  }
  return sockets
}

/**
 * Create a fresh private deployment, removing an incomplete tree if generation fails.
 * @param {string} root - Absolute directory to create exclusively.
 * @param {string} port - Validated Web port, with zero for an OS-assigned port.
 * @param {{model: {provider: string, model: string}, engine?: string, dockerSocket?: string, runtime?: string, codex?: string, reviewScripts?: boolean, authorityPatches?: string[], permitActions?: string[]}} options - Model route and model ID,
 * where route `codex-local` selects Local Codex and any other route an API provider through pi-ai, and already resolved
 * setup executables. Linux requires dockerSocket and runtime. `permitActions` writes the Assistant's broker action IDs; the authority validates them at start.
 * Set `reviewScripts` to ask before every script; `authorityPatches` are applied in order.
 * @returns Completion after patch composition and fresh profile generation.
 */
export async function prepare(root, port, options) {
  const { operation: operationSocket, evidence: evidenceSocket, approval: approvalSocket, gateway: gatewaySocket } = socketsFor(root)
  const node = realpathSync(process.execPath)
  const cli = join(repo, 'apps/cli/lib/bin.js')
  if (statSync(cli, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error('Run pnpm run build:artifacts from the checkout before preparing the jobs.')
  }
  const engine = options.engine ?? executable(platform.engineCommand)
  const executionConfig = platform.executionRow({ ...options, engine }, gatewaySocket, image)
  const path = [dirname(node), ...(platform.backend === 'docker' ? [dirname(engine)] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
  const { provider, model } = options.model
  const codex = provider === localCodex
  const evidence = '@deepseek-ai/dsh-operation-evidence'
  const control = '@deepseek-ai/dsh-operation-control'
  const execution = '@deepseek-ai/dsh-execution-container'
  const broker = '@deepseek-ai/dsh-operation-broker'
  const credentials = '@deepseek-ai/dsh-credentials-local'
  const llm = '@deepseek-ai/dsh-llm'
  // An API route reads its key from the authority's credential store under the provider's conventional name.
  const modelKey = `${provider.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}_API_KEY`
  const adapter = codex
    ? {
        id: 'llm-codex', name: '@deepseek-ai/dsh-llm-codex', directory: 'packages/experimental/llm-codex',
        config: { command: options.codex ?? executable('codex') },
      }
    : {
        id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', directory: 'packages/llm/llm-pi-ai',
        config: { providers: { [provider]: { apiKeyEnv: modelKey } } },
      }
  const subprocess = '@deepseek-ai/dsh-subprocess-local'
  const roles = {
    witness: {
      bundles: [],
      plugins: { [evidence]: join(repo, 'packages/experimental/operation-evidence') },
      patch: [{ insert: [{ id: 'operation-evidence', name: evidence, config: {
        socketPath: evidenceSocket, databasePath: join(root, 'witness', 'evidence.sqlite'), socketMode: '0600',
      } }] }],
    },
    authority: {
      bundles: [],
      plugins: {
        [subprocess]: join(repo, 'packages/subprocess/subprocess-local'),
        [control]: join(repo, 'packages/experimental/operation-control'),
        [execution]: join(repo, 'packages/experimental/execution-container'),
        [broker]: join(repo, 'packages/experimental/operation-broker'),
        [credentials]: join(repo, 'packages/credentials/credentials-local'),
        [llm]: join(repo, 'packages/llm/llm'),
        [adapter.name]: join(repo, adapter.directory),
      },
      patch: [{ insert: [
        { id: 'subprocess', name: subprocess },
        { id: 'llm', name: llm },
        { id: adapter.id, name: adapter.name, config: adapter.config },
        { id: 'execution-container', name: execution, config: executionConfig },
        { id: 'credentials', name: credentials },
        { id: 'operation-broker', name: broker, config: { routes: [] } },
        { id: 'operation-control', name: control, inject: ['operationBroker'], config: {
          broker: ['operationBroker'], unattendedShell: options.reviewScripts !== true,
          principalId: 'owner', scopeId: 'offline-shell',
          socketPath: operationSocket, evidenceSocketPath: evidenceSocket, approvalSocketPath: approvalSocket,
          databasePath: join(root, 'authority', 'operation.sqlite'),
          grantExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000, maxOperations: 1_000, maxFileBytes: 8 * 1024 * 1024,
          model: { provider, model, ...(codex ? {} : { credentialRef: modelKey }) },
          assistant: { mainSessionId: 'assistant-main', permissions: {
            exec: true, brokerActions: [], data: { import: true, export: true, discloseToModel: true, discloseToUser: true, returnResponses: true },
          } },
        } },
      ] }],
      env: { HOME: homedir() },
    },
    web: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      plugins: {
        [control]: join(repo, 'packages/experimental/operation-control'),
        '@deepseek-ai/dsh-assistant': assistant,
      },
      patch: [
        { insert: [{ id: 'operation-control-model-agent', name: `${control}/model-agent`, config: { socketPath: operationSocket, provider, model } }] },
        { id: 'agent-default-model', config: { provider, model } },
        { id: 'ui-settings-models', config: { credentialOnboarding: false } },
        ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm'].map(id => ({ id, disabled: true })),
      ],
      args: ['--patch', join(assistant, 'cordis.patch.yml'), '--host', '127.0.0.1', '--port', port, '--no-open'],
      env: { DSH_OPERATION_SOCKET: operationSocket, DSH_APPROVAL_SOCKET: approvalSocket },
    },
  }

  if (options.authorityPatches?.length || options.permitActions?.length) {
    const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
    const { applyEntryPatches, entryListSchema } = await import('@deepseek-ai/cordis-plugin-include')
    const { dump } = await import('js-yaml')
    const patches = (options.authorityPatches ?? []).flatMap(file => loadOverlayPatches('vardock setup', resolve(file)))
    const rows = applyEntryPatches([], [...roles.authority.patch, ...patches], (format, ...args) => {
      throw new Error(`vardock setup: ${format} ${args.join(' ')}`)
    })
    if (options.permitActions?.length) {
      rows.find(row => row.id === 'operation-control').config.assistant.permissions.brokerActions = options.permitActions
    }
    roles.authority.patchText = dump([{ insert: rows }], { schema: entryListSchema, noRefs: true, lineWidth: -1 })
  }

  try {
    mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Choose a new setup directory. ${root} already exists.`, { cause: error })
    throw error
  }
  try {
    const fileOptions = { flag: 'wx', mode: 0o600 }
    for (const { name, home, profile: profileName, profilePath: profile, label, file } of jobsFor(root)) {
      const role = roles[name]
      mkdirSync(home, { mode: 0o700 })
      mkdirSync(join(profile, 'node_modules/@deepseek-ai'), { recursive: true, mode: 0o700 })
      const dependencies = Object.fromEntries(Object.entries(role.plugins).map(([name, dir]) => [name, `file:${dir}`]))
      for (const [name, dir] of Object.entries(role.plugins)) symlinkSync(dir, join(profile, 'node_modules', name), 'dir')
      writeFileSync(join(profile, 'package.json'), JSON.stringify({
        name: `dsh-profile-${profileName}`, private: true, dsh: { profile: { bundles: role.bundles } }, dependencies,
      }, null, 2) + '\n', fileOptions)
      writeFileSync(join(profile, 'cordis.patch.yml'), role.patchText ?? JSON.stringify(role.patch, null, 2) + '\n', fileOptions)

      const argv = [node, cli, '--profile', profileName, ...(role.args ?? [])]
      const environment = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', PATH: path, ...role.env }
      for (const name of platform.logFiles) writeFileSync(join(home, name), '', fileOptions)
      writeFileSync(file, platform.jobFile({ name, label, home }, argv, environment), fileOptions)
    }
  } catch (error) {
    rmSync(root, { recursive: true })
    throw error
  }
}
