/** Built setup profiles compose operator overlays through the shipped Cordis loader. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const prepare = fileURLToPath(new URL('../../../packages/experimental/assistant/vardock/prepare.mjs', import.meta.url))

it.skipIf(process.platform === 'win32')('merges repeated authority patches, preserves other roles, and rejects setup misconfiguration before writing', (test) => {
  const directory = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'vp-')))
  test.onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const generate = (home: string, authorityPatches: string[] = []) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    `import(${JSON.stringify(prepare)}).then(({ prepare }) => prepare(${JSON.stringify(home)}, '0', `
      + JSON.stringify({ model: { provider: 'openai', model: 'fixture-model' }, engine: '/usr/bin/true', authorityPatches, ...(process.platform === 'linux' ? { dockerSocket: '/var/run/docker.sock', runtime: 'runc' } : {}) }) + '))',
  ], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  const original = join(directory, 'original')
  const baseline = generate(original)
  expect(baseline.stderr).toBe('')
  expect(baseline.status).toBe(0)
  const relative = 'authority/profiles/operation-authority/cordis.patch.yml'
  const layers = JSON.parse(readFileSync(join(original, relative), 'utf8')) as {
    insert: { id: string; config: Record<string, unknown> }[]
  }[]
  const control = layers[0]?.insert.find(row => row.id === 'operation-control')?.config
  const first = join(directory, 'read.yml')
  writeFileSync(first, `- id: operation-broker
  config:
    routes:
      - action: read-records
        endpoint: https://records.example.com/read
        credentialRef: RECORDS_TOKEN
        returnResponse: true
- insert:
    - id: mcp-broker
      name: '@deepseek-ai/dsh-operation-broker/mcp'
      config:
        servers: []
`)
  const second = join(directory, 'permissions.yml')
  writeFileSync(second, JSON.stringify([{ id: 'operation-control', inject: ['operationBroker', 'operationBrokerMcp'], config: {
    ...control, broker: ['operationBroker', 'operationBrokerMcp'], unattendedBrokerActions: [{ action: 'read-records' }],
    assistant: { mainSessionId: 'assistant-main', permissions: { exec: true, brokerActions: ['read-records'] } },
  } }]))
  const patched = join(directory, 'patched')
  const result = generate(patched, [first, second])
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const composed = load(readFileSync(join(patched, relative), 'utf8')) as { insert: EntryOptions[] }[]
  const entries = composed[0]?.insert ?? []
  expect(entries.find(row => row.id === 'operation-broker')).toMatchObject({
    config: { routes: [{ action: 'read-records', returnResponse: true }] },
  })
  expect(entries.find(row => row.id === 'mcp-broker')).toMatchObject({
    name: '@deepseek-ai/dsh-operation-broker/mcp', config: { servers: [] },
  })
  expect(entries.find(row => row.id === 'operation-control')).toMatchObject({
    inject: ['operationBroker', 'operationBrokerMcp'], config: {
      unattendedShell: true, unattendedBrokerActions: [{ action: 'read-records' }],
      assistant: { permissions: { brokerActions: ['read-records'] } },
    },
  })
  for (const role of ['web/profiles/web', 'witness/profiles/operation-witness']) {
    const before = readFileSync(join(original, role, 'cordis.patch.yml'), 'utf8').replaceAll(original, '<home>')
    expect(readFileSync(join(patched, role, 'cordis.patch.yml'), 'utf8').replaceAll(patched, '<home>')).toBe(before)
  }
  for (const [name, content] of [
    ['not-a-list', 'config: {}'], ['missing-row', '- id: absent\n  config: {}'],
    ['invalid-config', '- id: operation-control\n  config: { maxOperations: -1 }'],
    ['invalid-route', '- id: operation-broker\n  config:\n    routes: [{ action: read-records, endpoint: http://example.com/read, credentialRef: RECORDS_TOKEN }]'],
    ['missing-ca', `- id: operation-broker\n  config:\n    routes: [{ action: read-records, endpoint: https://example.com/read, credentialRef: RECORDS_TOKEN, ca: ${join(directory, 'missing.pem')} }]`],
    ['missing-file', undefined],
  ] as const) {
    const patch = join(directory, `${name}.yml`)
    if (content !== undefined) writeFileSync(patch, content)
    const home = join(directory, name)
    expect(generate(home, [patch]).status, name).toBe(1)
    expect(existsSync(home), name).toBe(false)
  }
})

it('loads the built MCP provider as the exported broker service', () => {
  const index = new URL('../../../packages/experimental/operation-broker/lib/index.js', import.meta.url).href
  const mcp = new URL('../../../packages/experimental/operation-broker/lib/mcp.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { strict as assert } from 'node:assert';
`
      + `const { OperationBroker } = await import(${JSON.stringify(index)});
`
      + `const { default: Mcp } = await import(${JSON.stringify(mcp)});
`
      + 'assert(Mcp.prototype instanceof OperationBroker);',
  ], { encoding: 'utf8', timeout: 10_000 })
  expect(result.signal).toBeNull()
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})
