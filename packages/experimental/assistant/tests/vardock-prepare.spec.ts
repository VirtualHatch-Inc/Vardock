/** Setup creates launchable job definitions and private role profiles. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const script = fileURLToPath(new URL('../vardock/prepare.mjs', import.meta.url))

it.skipIf(process.platform !== 'darwin')('prepares private role profiles and preserves existing data on retry', (test) => {
  const temporary = realpathSync(mkdtempSync('/tmp/dsh-macos-'))
  test.onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })

  const commands = join(temporary, 'bin')
  const node = realpathSync(process.execPath)
  const vmCommand = join(temporary, 'container-bin')
  mkdirSync(commands)
  writeFileSync(vmCommand, '', { mode: 0o700 })
  symlinkSync(vmCommand, join(commands, 'container'))
  symlinkSync(node, join(commands, 'codex'))
  const existingHome = join(temporary, 'existing-home')
  mkdirSync(existingHome)
  writeFileSync(join(existingHome, 'saved-state'), 'existing')
  const root = join(temporary, 'Assistant & <demo>')
  const checkout = join(temporary, 'checkout & <fixture>')
  const prepare = join(checkout, 'packages/experimental/assistant/vardock/prepare.mjs')
  mkdirSync(dirname(prepare), { recursive: true })
  copyFileSync(script, prepare)
  for (const name of ['launchd.mjs', 'systemd.mjs']) copyFileSync(new URL(`../vardock/${name}`, import.meta.url), join(dirname(prepare), name))
  const env = { ...process.env, PATH: commands, DSH_HOME: existingHome, OPENAI_API_KEY: 'test-value' }
  const generate = (target: string, port = '0') => spawnSync(node, [
    '--input-type=module', '-e', "const { prepare } = await import(process.argv[1]); await prepare(process.argv[2], process.argv[3], { model: { provider: 'codex-local', model: 'default' } })",
    prepare, target, port,
  ], { env, encoding: 'utf8' })
  expect(generate(join(temporary, 'invalid:path')).stderr).toContain('no colons')
  expect(generate(root).stderr).toContain('pnpm run build:artifacts')
  const cli = join(checkout, 'apps/cli/lib/bin.js')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, '')
  const created = generate(root)
  expect(created.stderr).toBe('')
  expect(created.status).toBe(0)
  expect(statSync(root).mode & 0o777).toBe(0o700)

  const prefix = 'io.github.virtualhatch-inc.vardock'
  for (const role of ['witness', 'authority', 'web']) {
    const plist = join(root, `${prefix}.${role}.plist`)
    execFileSync('/usr/bin/plutil', ['-lint', plist])
    const extract = (key: string) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trimEnd()
    expect(extract('WorkingDirectory')).toBe(join(root, role))
    expect(extract('EnvironmentVariables.DSH_HOME')).toBe(join(root, role))
    expect(extract('ProgramArguments.0')).toBe(node)
    expect(extract('ProgramArguments.1')).toBe(cli)
    if (role === 'web') {
      expect(extract('ProgramArguments.5')).toBe(join(checkout, 'packages/experimental/assistant/cordis.patch.yml'))
      expect(extract('ProgramArguments.9')).toBe('0')
      expect(extract('EnvironmentVariables.DSH_APPROVAL_SOCKET')).toBe(join(root, 'authority', 'approval.sock'))
    }
    expect(readFileSync(plist, 'utf8')).not.toContain('test-value')
  }
  const operation = join(root, 'authority', 'operation.sock')
  const authorityProfile = join(root, 'authority/profiles/operation-authority')
  const authority = join(authorityProfile, 'cordis.patch.yml')
  const authorityPatch = readFileSync(authority, 'utf8')
  const authorityLayers = JSON.parse(authorityPatch) as { insert: EntryOptions[] }[]
  const authorityRows = authorityLayers.flatMap(layer => layer.insert)
  const execution = '@deepseek-ai/dsh-execution-container'
  const executionDir = join(checkout, 'packages/experimental/execution-container')
  expect(authorityRows.find(row => row.id === 'llm-codex')?.config).toMatchObject({ command: node })
  expect(authorityRows.find(row => row.id === 'operation-control')).toMatchObject({
    inject: ['operationBroker'], config: {
      broker: ['operationBroker'], unattendedShell: true, principalId: 'owner', socketPath: operation, approvalSocketPath: join(root, 'authority', 'approval.sock'),
      maxOperations: 1_000, maxFileBytes: 8 * 1024 * 1024,
      assistant: { mainSessionId: 'assistant-main', permissions: {
        exec: true, brokerActions: [],
        data: { import: true, export: true, discloseToModel: true, discloseToUser: true, returnResponses: true },
      } },
    },
  })
  expect(authorityRows.find(row => row.id === 'execution-container')?.config).toEqual({
    backend: 'apple-vm', vmCommand, image: 'dsh-execution:local', gatewaySocket: join(root, 'authority/gateway.sock'), allowedTargets: [],
    timeoutMs: 300_000, gatewayIdleTimeoutMs: 300_000,
  })
  expect(authorityRows.find(row => row.id === 'operation-control')?.config).not.toHaveProperty('execution')
  expect(JSON.parse(readFileSync(join(authorityProfile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { [execution]: `file:${executionDir}` } })
  expect(readlinkSync(join(authorityProfile, 'node_modules', execution))).toBe(executionDir)
  const web = join(root, 'web/profiles/web')
  expect(JSON.parse(readFileSync(join(web, 'cordis.patch.yml'), 'utf8'))).toContainEqual({ insert: [{
    id: 'operation-control-model-agent', name: '@deepseek-ai/dsh-operation-control/model-agent',
    config: { socketPath: operation, provider: 'codex-local', model: 'default' },
  }] })
  expect(readlinkSync(join(web, 'node_modules/@deepseek-ai/dsh-assistant'))).toMatch(/\/packages\/experimental\/assistant$/u)

  const repeated = generate(root)
  expect(repeated.status).toBe(1)
  expect(repeated.stderr).toContain('already exists')
  expect(readFileSync(authority, 'utf8')).toBe(authorityPatch)
  expect(readFileSync(join(existingHome, 'saved-state'), 'utf8')).toBe('existing')

  const fixedPort = join(temporary, 'fixed-port')
  expect(generate(fixedPort, '12345').status).toBe(0)
  const fixedPlist = join(fixedPort, `${prefix}.web.plist`)
  expect(execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.9', 'raw', '-o', '-', fixedPlist], { encoding: 'utf8' }).trimEnd()).toBe('12345')

  // An API route needs no Codex executable: its adapter reads a key that the owner stores in the authority.
  const api = join(temporary, 'api-provider')
  const call = `import(${JSON.stringify(prepare)}).then(({ prepare }) => prepare(${JSON.stringify(api)}, '0', `
    + `{ engine: ${JSON.stringify(vmCommand)}, model: { provider: 'openai', model: 'fixture-model' } }))`
  const prepared = spawnSync(node, ['--input-type=module', '-e', call], { env: { ...env, PATH: '' }, encoding: 'utf8' })
  expect(prepared.stderr).toBe('')
  expect(JSON.parse(readFileSync(join(api, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8'))).toMatchObject([{ insert: [
    { id: 'subprocess' }, { id: 'llm' },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } } },
    { id: 'execution-container' }, { id: 'credentials' }, { id: 'operation-broker' },
    { id: 'operation-control', config: { model: { provider: 'openai', model: 'fixture-model', credentialRef: 'OPENAI_API_KEY' } } },
  ] }])
  expect(JSON.parse(readFileSync(join(api, 'web/profiles/web/cordis.patch.yml'), 'utf8'))).toContainEqual({
    id: 'agent-default-model', config: { provider: 'openai', model: 'fixture-model' },
  })
})

it.skipIf(process.platform === 'win32')('composes the generated Web profile with only the Assistant preset and no direct execution tool', (test) => {
  const fixtureRoot = realpathSync(mkdtempSync('/tmp/vardock-web-'))
  test.onTestFinished(() => { rmSync(fixtureRoot, { recursive: true, force: true }) })
  const checkout = join(fixtureRoot, 'checkout')
  const directory = join(checkout, 'packages/experimental/assistant/vardock')
  mkdirSync(directory, { recursive: true })
  for (const name of ['prepare.mjs', 'launchd.mjs', 'systemd.mjs']) {
    copyFileSync(new URL(`../vardock/${name}`, import.meta.url), join(directory, name))
  }
  mkdirSync(join(checkout, 'apps/cli/lib'), { recursive: true })
  writeFileSync(join(checkout, 'apps/cli/lib/bin.js'), '')
  const home = join(fixtureRoot, 'home')
  const options = { engine: '/opt/docker/bin/docker', dockerSocket: '/var/run/docker.sock', runtime: 'runsc', model: { provider: 'openai', model: 'fixture-model' } }
  expect(spawnSync(realpathSync(process.execPath), ['--input-type=module', '-e',
    "Object.defineProperty(process, 'platform', { value: 'linux' }); const { prepare } = await import(process.argv[1]);"
      + " const [home, options] = JSON.parse(process.argv[2]); await prepare(home, '3080', options)",
    join(directory, 'prepare.mjs'), JSON.stringify([home, options]),
  ], { env: { PATH: '' }, encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' })

  // Layers apply as bundle, profile, then command-line patches.
  const repo = fileURLToPath(new URL('../../../../', import.meta.url))
  const profile = join(home, 'web/profiles/web')
  const manifest = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { dsh: { profile: { bundles: string[] }; bundle: { patch: string | string[] } } }
  const bundleFiles = manifest(join(profile, 'package.json')).dsh.profile.bundles.flatMap((name) => {
    const bundle = join(repo, 'apps/cli/node_modules', name)
    return [manifest(join(bundle, 'package.json')).dsh.bundle.patch].flat().map(patch => join(bundle, patch))
  })
  const unit = readFileSync(join(home, 'io.github.virtualhatch-inc.vardock.web.service'), 'utf8')
  const overlays = [...unit.matchAll(/"--patch" "([^"]+)"/gu)].map(([, path]) => join(repo, relative(checkout, path!)))
  expect(overlays).toEqual([join(repo, 'packages/experimental/assistant/cordis.patch.yml')])
  const layers = [...bundleFiles, join(profile, 'cordis.patch.yml'), ...overlays]
    .flatMap(path => load(readFileSync(path, 'utf8'), { schema: entryListSchema }) as PatchOptions[])
  const rows = applyEntryPatches([], layers, (format: string, ...args: unknown[]) => { throw new Error(`${format} ${args.join(' ')}`) })
  const flatten = (entries: EntryOptions[]): EntryOptions[] => entries.flatMap(entry => [entry,
    ...entry.group === true && Array.isArray(entry.config) ? flatten(entry.config as EntryOptions[]) : []])
  const enabled = flatten(rows).filter(row => row.disabled !== true)
  const disabled = new Map(flatten(rows).map(row => [row.id, row.disabled]))

  for (const id of [
    'office-kit', 'skill-office', 'ui-account-notifications',
    'ui-settings-subagent', 'ui-settings-web-search', 'ui-settings-shell', 'entry-customization',
    'ui-permission', 'ui-model-selection', 'ui-skill', 'ui-reference', 'ui-plan', 'ui-goal',
    'ui-subagent', 'ui-agent-team', 'ui-jobs', 'ui-sidebar-terminal', 'terminal-controller',
    'ui-sidebar-browser', 'ui-sidebar-files', 'ui-sidebar-documentpreview', 'ui-open-in-app', 'open-in-app',
    'workspace-changes', 'ui-deliverables', 'deliverable-file-references', 'ui-workflow-run', 'ui-settings-models', 'ui-settings-account',
    'ui-settings-session-log', 'session-log-deepseek',
    'mcp-manager', 'deepseek-account', 'session-telemetry-otel', 'cordis-inspect-providers', 'directory-picker',
  ]) expect(disabled.get(id), id).toBe(true)
  expect(disabled.get('ui-agent-preset')).not.toBe(true)
  expect(rows.find(row => row.id === 'plugin-manager')?.config).toEqual({ management: 'fixed', fallbackRegistries: [] })
  expect(rows.find(row => row.id === 'ui-plugin-manager')?.config).toEqual({ registryProbeEnabled: false })
  expect(rows.find(row => row.id === 'speech-to-text-sensevoice')?.config).toMatchObject({ modelOrigins: ['https://huggingface.co'] })
  expect(rows.find(row => row.id === 'agent-preset-registry')?.config).toEqual({ default: 'standard' })

  const presets = enabled.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
  expect(presets.map(row => (row.config as { id: string }).id)).toEqual(['standard'])
  expect(presets[0]?.config).toMatchObject({ plugins: [
    { id: 'time-context', config: { refreshIntervalMs: 0 } }, { id: 'compaction' },
  ] })
  const presetRows = presets.flatMap(row => flatten((row.config as { plugins: EntryOptions[] }).plugins))
    .filter(row => row.disabled !== true)
  const directExecution = /^@deepseek-ai\/dsh-(?:tool-(?:bash|pwsh|fs|executor-ptc|terminal|plugin-)|plugin-manager\/tools$)/u
  expect([...enabled, ...presetRows].filter(row => directExecution.test(row.name ?? '')).map(row => row.id)).toEqual([])
})

it.skipIf(process.platform === 'win32')('writes private Linux units, pre-creates private logs, and selects the Docker execution row', (test) => {
  const fixtureRoot = realpathSync(mkdtempSync('/tmp/vardock-unit-'))
  test.onTestFinished(() => { rmSync(fixtureRoot, { recursive: true, force: true }) })
  const checkout = join(fixtureRoot, 'checkout')
  const directory = join(checkout, 'packages/experimental/assistant/vardock')
  mkdirSync(directory, { recursive: true })
  for (const name of ['prepare.mjs', 'launchd.mjs', 'systemd.mjs']) {
    copyFileSync(new URL(`../vardock/${name}`, import.meta.url), join(directory, name))
  }
  const cli = join(checkout, 'apps/cli/lib/bin.js')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, '')
  const entry = join(directory, 'prepare.mjs')
  const node = realpathSync(process.execPath)
  const root = join(fixtureRoot, 'home')
  const options = { engine: '/opt/docker/bin/docker', dockerSocket: '/var/run/docker.sock', runtime: 'runsc', model: { provider: 'openai', model: 'fixture-model' } }
  const generate = (home: string) => spawnSync(node, ['--input-type=module', '-e',
    "Object.defineProperty(process, 'platform', { value: 'linux' }); const { prepare } = await import(process.argv[1]);"
      + " const [home, options] = JSON.parse(process.argv[2]); await prepare(home, '3080', options)",
    entry, JSON.stringify([home, options]),
  ], { env: { PATH: '', OPENAI_API_KEY: 'private-environment-value' }, encoding: 'utf8' })
  expect(generate(root)).toMatchObject({ status: 0, signal: null, stderr: '' })
  const prefix = 'io.github.virtualhatch-inc.vardock'
  for (const role of ['witness', 'authority', 'web']) {
    const unit = join(root, `${prefix}.${role}.service`)
    expect(statSync(unit).mode & 0o777).toBe(0o600)
    for (const name of ['stdout.log', 'stderr.log']) {
      const path = join(root, role, name)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readFileSync(path, 'utf8')).toBe('')
    }
    expect(readFileSync(unit, 'utf8')).not.toContain('private-environment-value')
  }
  const unit = readFileSync(join(root, `${prefix}.web.service`), 'utf8')
  expect(unit).toContain(`After=${prefix}.authority.service`)
  expect(unit).toContain('UMask=0077')
  expect(unit).toContain('Restart=always')
  expect(unit).toContain(`StandardOutput=append:${root}/web/stdout.log`)
  expect(unit).toContain(`Environment="DSH_APPROVAL_SOCKET=${root}/authority/approval.sock"`)
  expect(unit).toContain(`"${node}" "${cli}" "--profile" "web"`)
  const witness = readFileSync(join(root, `${prefix}.witness.service`), 'utf8')
  expect(witness).not.toContain('After=')
  expect(readFileSync(join(root, `${prefix}.authority.service`), 'utf8')).toContain(`After=${prefix}.witness.service`)
  const layers = JSON.parse(readFileSync(join(root, 'authority/profiles/operation-authority/cordis.patch.yml'), 'utf8')) as { insert: EntryOptions[] }[]
  const rows = layers.flatMap(layer => layer.insert)
  expect(rows.find(row => row.id === 'execution-container')?.config).toEqual({
    backend: 'docker', dockerSocket: '/var/run/docker.sock', gatewaySocket: join(root, 'authority/gateway.sock'),
    image: 'dsh-execution:local', runtime: 'runsc', timeoutMs: 300_000, gatewayIdleTimeoutMs: 300_000,
  })
  expect(rows.find(row => row.id === 'operation-control')?.config).toMatchObject({ unattendedShell: true })
  const repeated = generate(root)
  expect(repeated.status).toBe(1)
  expect(repeated.stderr).toContain('already exists')
})

it.skipIf(process.platform === 'win32')('quotes Linux command words independently of environment assignments and rejects controls', () => {
  const systemd = fileURLToPath(new URL('../vardock/systemd.mjs', import.meta.url))
  const expression = [
    'const { default: systemd } = await import(process.argv[1]);',
    'const [argument, environment] = JSON.parse(process.argv[2]);',
    "console.log(JSON.stringify({ unit: systemd.jobFile({ name: 'witness', label: 'vardock.witness', home: '/tmp/home' },",
    '[argument], { EXAMPLE: environment }) }))',
  ].join(' ')
  const generate = (argument: string, environment = argument) => spawnSync(process.execPath, [
    '--input-type=module', '-e', expression, systemd, JSON.stringify([argument, environment]),
  ], { encoding: 'utf8' })
  const result = generate('/tmp/a space "quote" \\ % $value ${EXAMPLE}')
  expect(result).toMatchObject({ status: 0, signal: null, stderr: '' })
  const output = JSON.parse(result.stdout) as { unit: string }
  expect(output.unit).toContain('ExecStart="/tmp/a space \\"quote\\" \\\\ %% $$value $${EXAMPLE}"')
  expect(output.unit).toContain('Environment="EXAMPLE=/tmp/a space \\"quote\\" \\\\ %% $value ${EXAMPLE}"')
  for (const control of ['\n', '\u0000']) {
    expect(generate(`/tmp/a${control}b`).stderr).toContain('Remove control characters')
    expect(generate('/tmp/a', `a${control}b`).stderr).toContain('Remove control characters')
  }
})
