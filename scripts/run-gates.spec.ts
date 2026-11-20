import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  cliGateOptions,
  collectDescendants,
  defaultConcurrency,
  formatGateResultReason,
  gatesForMode,
  parsePidPpidLines,
  runGate,
  runGates,
  taskkillArgs,
  type Gate,
  type GateResult,
} from './run-gates.ts'

// Graph fixtures take the CLI help allowance each case sets, not the one the
// invoking shell exports.
beforeEach(() => {
  vi.stubEnv('DSH_CLI_HELP_CONCURRENCY', undefined)
})
afterEach(() => vi.unstubAllEnvs())

/** Environment variable naming the file that abort fixtures append their markers to. */
const MARKER_LOG_ENV = 'DSH_TEST_MARKER_LOG'

/** Script prefix that appends one marker string to the fixture's marker file. */
const appendMarker = `require('node:fs').appendFileSync(process.env.${MARKER_LOG_ENV}, `

/**
 * Create the file abort fixtures append markers to, so a test observes them while the gate still runs.
 * @returns the gate environment naming the file and a reader for its current text.
 */
function markerLog(): { env: Record<string, string>; read: () => string } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-run-gates-markers-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'markers.log')
  writeFileSync(path, '')
  return { env: { [MARKER_LOG_ENV]: path }, read: () => readFileSync(path, 'utf8') }
}

/**
 * A process has stopped executing when its /proc entry is gone, or when it
 * lingers as a zombie ('Z') — an un-reaped but dead entry still answers
 * kill(pid, 0), so existence is not a liveness check. Non-Linux falls back to
 * kill(pid, 0), whose ESRCH means the process is gone.
 */
function procStopped(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return /\)\s+Z\s/.test(stat)
    } catch {
      return true
    }
  }
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

/**
 * Wait until the marker file contains `marker` and the grandchild pid the
 * gate recorded, then return that pid.
 * @param read - reader of the fixture's marker file.
 * @param marker - the marker that proves the gate reached the abort point.
 * @param deadline - fail the wait when exceeded.
 * @returns the grandchild pid recorded by the gate script.
 */
async function waitForGrandchildPid(read: () => string, marker: string, deadline: number): Promise<number> {
  let pid: number | undefined
  while ((pid === undefined || !read().includes(marker)) && Date.now() < deadline) {
    const match = read().match(/grandchild:(\d+)/)
    if (match !== null) pid = Number(match[1])
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(pid ?? 0).toBeGreaterThan(0)
  expect(read()).toContain(marker)
  return pid!
}

/**
 * Abort the run and assert it settles marked aborted with the grandchild no
 * longer executing — the abort path must have signalled it from the captured
 * descendant list rather than settling over a live orphan.
 * @param promise - the pending `runGate` promise.
 * @param controller - the signal source to abort.
 * @param pid - the grandchild pid the gate script printed.
 */
async function abortAndExpectTreeStopped(promise: Promise<GateResult>, controller: AbortController, pid: number): Promise<void> {
  controller.abort()
  const result = await promise
  expect(result.aborted).toBe(true)
  const stopDeadline = Date.now() + 8000
  while (!procStopped(pid) && Date.now() < stopDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(procStopped(pid)).toBe(true)
}


function gate(id: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: ['-e', ''],
    ...options,
  }
}

function resultFor(subject: Gate, status: GateResult['status'] = 'passed'): GateResult {
  return {
    gate: subject,
    status,
    durationMs: 10,
    output: [],
    exitCode: status === 'passed' ? 0 : 1,
    signalCode: null,
  }
}

function withPnpmEntrypoint<T>(action: () => T, entrypoint = '/private/pnpm.cjs'): T {
  const previous = process.env.npm_execpath
  process.env.npm_execpath = entrypoint
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
    else process.env.npm_execpath = previous
  }
}

function withEnv<T>(name: string, value: string | undefined, action: () => T): T {
  const previous = process.env[name]
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
  try {
    return action()
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

// Mutates worker-global state: only use for synchronous, non-concurrent graph inspection.
function withNodeVersion<T>(version: string, action: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!
  Object.defineProperty(process.versions, 'node', { ...original, value: version })
  try { return action() } finally { Object.defineProperty(process.versions, 'node', original) }
}

describe('gate graph validation', () => {
  it.each([
    'node-compat',
    'check-all',
    'hygiene',
    'doc-sync',
    'doc-quick',
    'i18n',
  ] as const)('constructs and executes preflight for a valid non-empty %s graph', async (mode) => {
    const subject = withPnpmEntrypoint(() => gatesForMode(mode))
    const execute = vi.fn(async (item: Gate) => resultFor(item))

    await expect(runGates(subject, subject.length, execute)).resolves.toHaveLength(subject.length)
  })

  it('keeps the public benchmark scripts on the full library build', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(scripts['test:bench']).toBe('npm run build:bench && npm run build:web && npm run test:bench:built')
    expect(scripts['build:bench']).toBe(
      'npm run build:native-system && npm run build:lib && tsdown --config-loader native --config benchmarks/tsdown.config.ts',
    )
    expect(scripts['build:native-system']).toBe('tsx native/system/scripts/build.ts --host-addon-only')
    expect(scripts['test:bench:built']).toBe('tsx scripts/run-bench-suite.ts')
  })

  it('checks all maintained repository references in both documentation aggregates', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const mode of ['doc-sync', 'doc-quick'] as const) {
      const gates = withPnpmEntrypoint(() => gatesForMode(mode))
      expect(gates).toContainEqual(expect.objectContaining({
        id: 'repository-references',
        displayCommand: 'pnpm run verify-repository-references',
      }))
    }
    expect(scripts['verify-repository-references']).toBe('tsx scripts/verify-repository-references.ts')
  })

  it('keeps the public repository link policy in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('public-repository-links')
  })

  it.each([undefined, ''])('allocates one CLI help child inside each aggregate when its allowance is %j', (raw) => {
    vi.stubEnv('DSH_CLI_HELP_CONCURRENCY', raw)
    for (const mode of ['doc-sync', 'check-all'] as const) {
      const gates = withPnpmEntrypoint(() => gatesForMode(mode))
      expect(gates.find(gate => gate.id === 'cli-help')).toMatchObject({ env: { DSH_CLI_HELP_CONCURRENCY: '1' } })
      expect(gates.filter(gate => gate.id !== 'cli-help').every(gate => gate.env?.DSH_CLI_HELP_CONCURRENCY === undefined)).toBe(true)
    }
  })

  it.each(['3', 'invalid'])('passes an explicit CLI help allowance %j to its owner', (raw) => {
    vi.stubEnv('DSH_CLI_HELP_CONCURRENCY', raw)
    const gates = withPnpmEntrypoint(() => gatesForMode('doc-sync'))
    expect(gates.find(gate => gate.id === 'cli-help')).toMatchObject({ env: { DSH_CLI_HELP_CONCURRENCY: raw } })
  })

  it('keeps the concrete terminology policy in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('concrete-terms')
  })

  it('checks retrospective releases alongside the current persistence history', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toEqual(expect.arrayContaining(['persistence-changes', 'persistence-releases']))
  })

  it('requires complete Session format references in both documentation aggregates', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const mode of ['doc-sync', 'doc-quick'] as const) {
      expect(withPnpmEntrypoint(() => gatesForMode(mode))).toContainEqual(expect.objectContaining({
        id: 'persistence-formats',
        displayCommand: 'pnpm run verify-persistence-formats',
      }))
    }
    expect(scripts['verify-persistence-formats']).toBe('tsx scripts/persistence-formats.ts')
  })

  it('keeps package-group subsystem ownership in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('subsystem-pages')
  })

  it('keeps the package README Summary limit in the documentation gate', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids).toContain('package-readme-summaries')
  })

  it('derives the quick documentation aggregate from marked doc-sync leaves', () => {
    const full = withPnpmEntrypoint(() => gatesForMode('doc-sync'))
    const quick = withPnpmEntrypoint(() => gatesForMode('doc-quick'))

    expect(quick).toEqual(full.filter(gate => gate.quick === true))
  })

  it('checks the recorded npm dependency catalog in both documentation aggregates', () => {
    for (const mode of ['doc-sync', 'doc-quick'] as const) {
      expect(withPnpmEntrypoint(() => gatesForMode(mode).find(gate => gate.id === 'dependency-catalog')))
        .toMatchObject({ args: ['/private/pnpm.cjs', 'run', 'verify-dependency-catalog'] })
    }
  })

  it('keeps the hygiene aggregate aligned with the package script checks', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('hygiene').map(subject => subject.id))

    expect(ids).toEqual([
      'rescope-vendor', 'publint', 'constraints', 'expected-filenames', 'default-product-isolation', 'product-use', 'official-bundle-catalog', 'provider-data', 'package-dependencies', 'application-entrypoints',
      'dsh-package-licenses', 'package-meta', 'node-next-types',
      'optional-dependency-imports', 'client-packages', 'installer-locales', 'locale-metadata', 'client-ui-i18n', 'client-route-resolution', 'no-bare-dispatcher',
      'plugin-record-callers', 'no-unknown-casts', 'no-top-level-await', 'plugin-entry-exports',
      'cordis-config', 'runtime-closure',
    ])
  })

  it('includes JSON resource checks in every aggregate that checks resources', () => {
    for (const mode of ['i18n', 'check-all', 'hygiene'] as const) {
      const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(gate => gate.id))
      expect(ids).toEqual(expect.arrayContaining(['installer-locales', 'locale-metadata']))
      if (mode !== 'i18n') expect(ids).not.toContain('locale-dictionaries')
    }
    expect(withPnpmEntrypoint(() => gatesForMode('i18n').map(gate => gate.id)))
      .toEqual(['installer-locales', 'locale-metadata', 'locale-dictionaries'])
  })

  it('caps the hygiene and documentation aggregates at eight workers', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('hygiene').map(subject => subject.id))

    expect(defaultConcurrency('hygiene', ids.length, 16)).toEqual({
      workers: 8,
      source: '12 local default worker(s) of 16 CPU(s), hygiene cap 8',
    })
    expect(defaultConcurrency('doc-sync', 43, 256)).toEqual({
      workers: 8,
      source: '12 local default worker(s) of 256 CPU(s), doc-sync cap 8',
    })
  })

  it('schedules the longest documentation leaves before short checks', () => {
    const ids = withPnpmEntrypoint(() => gatesForMode('doc-sync').map(subject => subject.id))

    expect(ids.slice(0, 11)).toEqual([
      'doc-typecheck', 'docs-site-build', 'doc-graphs', 'cli-help', 'markdown-links', 'type-equivalence',
      'cordis-catalog', 'cordis-inspect-catalog', 'workflow-guest', 'mermaid', 'translation-pairing',
    ])
  })

  it('launches a native pnpm entrypoint directly', () => {
    const entrypoint = String.raw`C:\Program Files\pnpm\pnpm.exe`
    const subject = withPnpmEntrypoint(() => gatesForMode('hygiene')[0], entrypoint)

    expect(subject).toMatchObject({
      command: entrypoint,
      args: ['run', 'rescope-vendor:check'],
    })
  })

  it.each(['check-all', 'hygiene'] as const)('keeps the repository policy checks in %s', (mode) => {
    const ids = withPnpmEntrypoint(() => gatesForMode(mode).map(subject => subject.id))

    expect(ids).toEqual(expect.arrayContaining([
      'dsh-package-licenses',
      'package-meta',
      'no-unknown-casts',
      'package-dependencies',
      'default-product-isolation',
      'client-packages',
      'client-ui-i18n',
      'client-route-resolution',
      'application-entrypoints',
    ]))
  })

  it('reads built artifacts in check-all only after its build', () => {
    const subject = withPnpmEntrypoint(() => gatesForMode('check-all'))

    for (const id of ['snapshot', 'expected-output', 'publint', 'node-next-types', 'doc-typecheck']) {
      expect(subject.find(item => item.id === id)?.needs).toEqual(['build'])
    }
    expect(subject.find(item => item.id === 'snapshot')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'expected-output')?.env).toEqual({ DSH_EXAMPLE_MODE: 'lib' })
    expect(subject.find(item => item.id === 'doc-typecheck')).toMatchObject({
      displayCommand: 'pnpm run doc-typecheck:contracts-ready',
      env: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
    })
  })

  it('keeps standalone doc sync responsible for contract preparation', () => {
    const docTypecheck = withPnpmEntrypoint(() =>
      gatesForMode('doc-sync').find(item => item.id === 'doc-typecheck'))

    expect(docTypecheck?.displayCommand).toBe('pnpm run doc-typecheck')
  })

  it.each([
    ['empty', [], /gate graph has no gates/],
    ['duplicate ids', [gate('same'), gate('same')], /duplicate gate id "same"/],
    ['unknown dependencies', [gate('subject', { needs: ['missing'] })], /depends on unknown gate "missing"/],
    ['cycles', [gate('first', { needs: ['second'] }), gate('second', { needs: ['first'] })], /dependency cycle: first -> second -> first/],
  ] as const)('rejects %s before starting a child', async (_label, invalid, message) => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([...invalid], 1, execute)).rejects.toThrow(message)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an invalid worker count before starting a child', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([gate('subject')], 0, execute)).rejects.toThrow('max concurrency must be a positive integer')
    expect(execute).not.toHaveBeenCalled()
  })

  it('skips dependents after their prerequisite fails', async () => {
    const dependent = gate('dependent', { needs: ['root'] })
    const root = gate('root')
    const execute = vi.fn(async (subject: Gate) => resultFor(subject, 'failed'))

    const results = await runGates([dependent, root], 1, execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(root, undefined)
    expect(results[0]).toMatchObject({ gate: dependent, status: 'skipped', error: 'dependency failed or skipped: root' })
  })
})

describe('Node compatibility graph', () => {
  it.each(['24.9.0', '24.19.0', '26.0.0'])('runs all source compatibility smokes serially on Node %s', (version) => {
    const subject = withNodeVersion(version, () =>
      withPnpmEntrypoint(() => gatesForMode('node-compat')))

    expect(subject.filter(item => item.id === 'source-compat-smokes')).toMatchObject([{
      label: 'source compatibility smokes',
      args: [
        '/private/pnpm.cjs',
        'exec',
        'vitest',
        'run',
        'packages/workflow/workflow-ptc/tests/source-runtime.compat.spec.ts',
        'packages/session/session-persistence-jsonl/tests/zstd.compat.spec.ts',
        'apps/cli/tests/source-launch.compat.spec.ts',
        'scripts/vitest-environment.compat.spec.ts',
        'scripts/command-entrypoints.compat.spec.ts',
        'packages/boot/app-boot/tests/profile-resolution.spec.ts',
        'packages/boot/app-boot/tests/profile-resolution-service.spec.ts',
        'packages/boot/app-boot/tests/profile-resolution-worker-bootstrap.spec.ts',
        '--no-file-parallelism',
        '--maxWorkers=1',
      ],
      env: { VITEST_MAX_WORKERS: '1' },
    }])
  })

  it.each(['1', '8'])('keeps source compatibility smokes serial with inherited VITEST_MAX_WORKERS=%s', (workers) => {
    const subject = withEnv('VITEST_MAX_WORKERS', workers, () =>
      withPnpmEntrypoint(() => gatesForMode('node-compat')))

    expect(subject.find(item => item.id === 'source-compat-smokes')?.env).toEqual({ VITEST_MAX_WORKERS: '1' })
  })

  it.each(['24.19.0', '26.0.0'])('keeps Node %s compatibility source-only', (version) => {
    const subject = withNodeVersion(version, () =>
      withPnpmEntrypoint(() => gatesForMode('node-compat')))

    expect(subject.map(item => item.id)).not.toContain('build')
    expect(subject.map(item => item.id)).not.toContain('cli-lazy-search-startup-smoke')
  })

  it.each([undefined, '1'])('builds the complete Node 24.9 artifacts once with skip-typecheck=%s', (skipTypecheck) => {
    const subject = withNodeVersion('24.9.0', () =>
      withEnv('DSH_NODE_COMPAT_SKIP_TYPECHECK', skipTypecheck, () =>
        withPnpmEntrypoint(() => gatesForMode('node-compat'))))

    expect(subject.filter(item => item.displayCommand === 'pnpm run build:artifacts')).toHaveLength(1)
    expect(subject.find(item => item.id === 'build')?.args).toEqual([
      '/private/pnpm.cjs', 'run', 'build:artifacts',
    ])
    expect(subject.map(item => item.id)).not.toContain('build:web')
    expect(subject.find(item => item.id === 'cli-lazy-search-startup-smoke')).toMatchObject({
      needs: ['build'],
      env: { DSH_REQUIRE_BUILT_CLI_SMOKE: '1' },
    })
  })

  it.each(['passed', 'failed'] as const)('runs the Node 24.9 lazy-search smoke only after a passed build (%s)', async (buildStatus) => {
    const subject = withNodeVersion('24.9.0', () =>
      withEnv('DSH_NODE_COMPAT_SKIP_TYPECHECK', '1', () =>
        withPnpmEntrypoint(() => gatesForMode('node-compat'))))
    let buildCompleted = false
    let smokeStarted = false
    const results = await runGates(subject, 2, async (item) => {
      if (item.id === 'build') {
        buildCompleted = true
        return resultFor(item, buildStatus)
      }
      if (item.id === 'cli-lazy-search-startup-smoke') {
        expect(buildCompleted).toBe(true)
        smokeStarted = true
      }
      return resultFor(item)
    })

    expect(smokeStarted).toBe(buildStatus === 'passed')
    expect(results.find(item => item.gate.id === 'cli-lazy-search-startup-smoke')?.status)
      .toBe(buildStatus === 'passed' ? 'passed' : 'skipped')
  })
})

describe('gate process outcomes', () => {
  it.skipIf(process.platform === 'win32')('reports signal termination independently from exit status', async () => {
    const result = await runGate(gate('terminated', {
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
    }))

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.signalCode).toBe('SIGTERM')
    expect(formatGateResultReason(result)).toBe('signal SIGTERM')
  })
})

describe('fail-fast scheduling', () => {
  it('aborts the aggregate at the first failure', async () => {
    const slow = gate('slow')
    const fast = gate('fast')
    const dependent = gate('dependent', { needs: ['slow'] })
    const execute = vi.fn(async (subject: Gate, signal?: AbortSignal) => {
      if (subject.id === 'fast') {
        return new Promise<GateResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            // The real runGate marks a gate the abort terminated; the drain
            // must then record it skipped rather than keep the failure.
            resolve({ ...resultFor(subject, 'failed'), aborted: true })
          }, { once: true })
        })
      }
      return resultFor(subject, subject.id === 'slow' ? 'failed' : 'passed')
    })

    const results = await runGates([slow, fast, dependent], 2, execute, () => {}, { failFast: true })

    expect(execute.mock.calls.map(([subject]) => subject.id)).toEqual(['slow', 'fast'])
    expect(results.map(result => result.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(results[1]).toMatchObject({
      status: 'skipped',
      error: 'aborted by fail-fast: slow failed',
    })
    expect(results[2]).toMatchObject({
      status: 'skipped',
      error: 'aborted by fail-fast: slow failed',
    })
  })

  it('runs independent gates to completion when fail-fast is disabled', async () => {
    const root = gate('root')
    const sibling = gate('sibling')
    const execute = vi.fn(async (subject: Gate) => (
      resultFor(subject, subject.id === 'root' ? 'failed' : 'passed')
    ))

    const results = await runGates([root, sibling], 2, execute, () => {}, { failFast: false })

    expect(execute).toHaveBeenCalledTimes(2)
    expect(results.map(result => result.status)).toEqual(['failed', 'passed'])
  })

  it('kills the child when the abort signal fires', async () => {
    const controller = new AbortController()
    const promise = runGate(gate('killable', { args: ['-e', 'setInterval(() => {}, 1000)'] }), controller.signal)
    controller.abort()
    const result = await promise

    expect(result.status).toBe('failed')
    expect(result.aborted).toBe(true)
    if (process.platform !== 'win32') expect(result.signalCode).toBe('SIGTERM')
  })

  it.skipIf(process.platform === 'win32')('marks a zero-exit child as aborted when the signal fired', async () => {
    const marker = 'signal-trap-armed'
    const log = markerLog()
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    const cleanup = async (): Promise<void> => {
      controller.abort()
      await promise
    }
    onTestFinished(cleanup)
    try {
      // Readiness belongs after native signal-handler registration.
      const script = [
        "process.on('SIGTERM', () => process.exit(0))",
        `${appendMarker}${JSON.stringify(marker)})`,
        'setInterval(() => {}, 1000)',
      ].join(';')
      const child = gate('traps-signal', { args: ['-e', script], env: log.env })
      promise = runGate(child, controller.signal)
      let exited = false
      void promise.then(() => { exited = true })
      while (!log.read().includes(marker)) {
        if (exited) throw new Error('signal fixture exited before readiness')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      controller.abort()
      const result = await promise

      // The child trapped the signal and exited zero; the drain must not
      // report this gate passed, so the raw outcome carries the abort mark.
      expect(result, formatGateResultReason(result)).toMatchObject({
        status: 'passed', exitCode: 0, signalCode: null, aborted: true,
      })
    } finally {
      await cleanup()
    }
  })

  it.skipIf(process.platform === 'win32')('kills the whole gate process tree when the abort signal fires', async () => {
    const log = markerLog()
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        // Detached, so the grandchild leads its own process group: the gate
        // group signal cannot reach it, and only the descendant enumeration in
        // treeKill does — the shape of a nested run-gates' leaf gates.
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true })",
        `${appendMarker}'grandchild:' + grandchild.pid + '\\n')`,
        'setInterval(() => {}, 1000)',
      ].join(';')
      promise = runGate(gate('tree', { args: ['-e', script], env: log.env }), controller.signal)
      const deadline = Date.now() + 5000
      let pid: number | undefined
      while (pid === undefined && Date.now() < deadline) {
        const match = log.read().match(/grandchild:(\d+)/)
        if (match !== null) pid = Number(match[1])
        else await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(pid ?? 0).toBeGreaterThan(0)
      controller.abort()
      const result = await promise
      expect(result.status).toBe('failed')
      // The descendant enumeration signals the detached grandchild at the same
      // time as the group signal reaches the direct child; the direct child's
      // own death closes the gate pipes, so poll for the grandchild to stop
      // executing rather than asserting on a fixed instant.
      const stopDeadline = Date.now() + 5000
      while (!procStopped(pid!) && Date.now() < stopDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(procStopped(pid!)).toBe(true)
    } finally {
      // A failed wait or assertion must not leave the forever-looping detached
      // grandchild behind on the host: abort the gate and wait for the
      // process tree to settle.
      controller.abort()
      await promise
    }
  })

  it('forwards host interruption signals to the abort path', async () => {
    const slow = gate('slow')
    const sibling = gate('sibling')
    const execute = vi.fn(async (subject: Gate, signal?: AbortSignal) => {
      if (subject.id === 'slow') {
        return new Promise<GateResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            // A child can trap the signal and exit zero; the drain must still
            // record the gate skipped so the interrupted run fails.
            resolve({ ...resultFor(subject, 'passed'), aborted: true })
          }, { once: true })
        })
      }
      return resultFor(subject)
    })

    const promise = runGates([slow, sibling], 1, execute, () => {}, { failFast: true, forwardProcessSignals: true })
    // The first loop iteration starts `slow` synchronously, so its abort
    // listener is registered before the signal is emitted.
    process.emit('SIGTERM')
    const results = await promise

    expect(execute).toHaveBeenCalledOnce()
    expect(results.map(result => result.status)).toEqual(['skipped', 'skipped'])
    expect(results[0]).toMatchObject({
      status: 'skipped',
      error: 'aborted by fail-fast: host interruption',
    })
  })

  it('pairs host signal forwarding with fail-fast at the CLI entrypoint', () => {
    expect(cliGateOptions(true)).toEqual({ failFast: true, forwardProcessSignals: true })
    expect(cliGateOptions(false)).toEqual({ failFast: false, forwardProcessSignals: false })
  })

  it('rejects host signal forwarding without fail-fast', async () => {
    const execute = vi.fn(async (subject: Gate) => resultFor(subject))

    await expect(runGates([gate('subject')], 1, execute, () => {}, { forwardProcessSignals: true }))
      .rejects.toThrow('forwardProcessSignals requires failFast')
    expect(execute).not.toHaveBeenCalled()
  })

  it('leaves an un-aborted child running to completion', async () => {
    const result = await runGate(gate('settles', { args: ['-e', ''] }), new AbortController().signal)

    expect(result.status).toBe('passed')
    expect(result.aborted).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('kills a detached descendant that outlived the child when the abort arrives later', async () => {
    const log = markerLog()
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        // Detached with inherited stdio: the grandchild leads its own process
        // group (the gate group signal misses it) and holds the gate's
        // stdout write end (so `close` stays pending past the child exit).
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' })",
        `${appendMarker}'grandchild:' + grandchild.pid + '\\n')`,
        // Outlive the first descendant-sampler tick with margin so the cache
        // holds the grandchild even on a loaded host, then exit normally
        // before the abort arrives.
        `setTimeout(() => { ${appendMarker}'child-exit\\n'); process.exit(0) }, 8000)`,
      ].join(';')
      promise = runGate(gate('late-abort', { args: ['-e', script], env: log.env }), controller.signal)
      const pid = await waitForGrandchildPid(log.read, 'child-exit', Date.now() + 10000)
      // terminate must not re-enumerate over the sampler cache now that the
      // child is gone; the detached grandchild is killed from the cached list.
      await abortAndExpectTreeStopped(promise, controller, pid)
    } finally {
      // A failed wait or assertion must not leave the forever-looping detached
      // grandchild behind on the host: abort the gate and wait for the
      // process tree to settle.
      controller.abort()
      await promise
    }
  }, 20000)

  it.skipIf(process.platform === 'win32')('keeps a reparented detached descendant tracked across a sampler tick', async () => {
    const log = markerLog()
    const controller = new AbortController()
    let promise: Promise<GateResult> | undefined
    try {
      const script = [
        "const { spawn } = require('node:child_process')",
        // Wrapper spawns a detached grandchild with inherited stdio (its own
        // process group, holding the gate's stdout write end), prints the pid,
        // then exits after 7 seconds — after the first sampler tick, before
        // the second. From then on the grandchild is reparented and
        // unreachable by parent id.
        `const wrapper = spawn(process.execPath, ['-e', "const { spawn } = require('node:child_process'); const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' }); require('node:fs').appendFileSync(process.env.${MARKER_LOG_ENV}, 'grandchild:' + grandchild.pid + '\\\\n'); setTimeout(() => process.exit(0), 7000)"], { stdio: 'inherit' })`,
        `wrapper.on('exit', () => ${appendMarker}'wrapper-exited\\n'))`,
        // Keep the root child alive past the abort with a heartbeat so the
        // test can abort while it is still running.
        "setInterval(() => process.stdout.write('hb\\n'), 1000)",
      ].join(';')
      promise = runGate(gate('sampler-merge', { args: ['-e', script], env: log.env }), controller.signal)
      const pid = await waitForGrandchildPid(log.read, 'wrapper-exited', Date.now() + 15000)
      // Wait past the second sampler tick (t=10) with margin: a replacing tick
      // would drop the reparented grandchild from the cache, after which the
      // abort cannot reach it. The root child keeps running throughout.
      const tickDeadline = Date.now() + 10000
      const wrapperExitedAt = Date.now()
      while (Date.now() - wrapperExitedAt < 5000 && Date.now() < tickDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(Date.now() - wrapperExitedAt).toBeGreaterThanOrEqual(5000)
      await abortAndExpectTreeStopped(promise, controller, pid)
    } finally {
      // A failed wait or assertion must not leave the forever-looping detached
      // grandchild behind on the host: abort the gate and wait for the
      // process tree to settle.
      controller.abort()
      await promise
    }
  }, 30000)
})

describe('process-table parsing', () => {
  it('excludes the root when a parent link returns to it', () => {
    expect(collectDescendants(100, [[200, 100], [100, 200], [300, 200]]))
      .toEqual([200, 300])
  })

  it('visits duplicate and cyclic descendant links only once', () => {
    expect(collectDescendants(100, [
      [200, 100], [200, 100], [300, 100], [200, 200], [400, 200], [200, 400], [500, 300], [900, 800],
    ])).toEqual([200, 300, 400, 500])
  })

  it('returns no descendants for an isolated or self-parented root', () => {
    expect(collectDescendants(100, [])).toEqual([])
    expect(collectDescendants(100, [[100, 100]])).toEqual([])
  })

  it('walks a wide child set without spreading it into call arguments', () => {
    const children = Array.from({ length: 150_000 }, (_, i): [number, number] => [i + 3, 2])
    const descendants = collectDescendants(1, [[2, 1], ...children])
    expect(descendants).toHaveLength(children.length + 1)
    expect(descendants[0]).toBe(2)
    expect(descendants.at(-1)).toBe(150_002)
  })

  it('parses `pid ppid` rows from a POSIX ps dump', () => {
    expect(parsePidPpidLines('  123   1\n456 123\n  789 456\n')).toEqual([[123, 1], [456, 123], [789, 456]])
  })

  it('parses Windows PowerShell Get-CimInstance output of the same shape', () => {
    expect(parsePidPpidLines(' 123 1\r\n456 123\r\n')).toEqual([[123, 1], [456, 123]])
  })

  it('drops blank and malformed lines', () => {
    expect(parsePidPpidLines('  123   1\n\ncommand not found\n999 abc\n')).toEqual([[123, 1]])
  })
})

describe('Windows tree termination', () => {
  it('targets the root first and each captured descendant after it', () => {
    expect(taskkillArgs(100, [201, 302, 403])).toEqual([
      ['/PID', '100', '/T', '/F'],
      ['/PID', '201', '/T', '/F'],
      ['/PID', '302', '/T', '/F'],
      ['/PID', '403', '/T', '/F'],
    ])
  })

  it('terminates the root alone when no descendant was captured', () => {
    expect(taskkillArgs(100, [])).toEqual([['/PID', '100', '/T', '/F']])
  })
})
