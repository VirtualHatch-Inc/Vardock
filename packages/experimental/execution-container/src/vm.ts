/** Dedicated Apple Linux microVMs with a single Host gateway socket. */
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import {
  ExecutionCli, SessionExecutor, executionFailure, executionLimits, gatewaySettings, gatewaySocketPath, hash, interruptedExecution,
  observeStopped, EXEC_TIMEOUT, EXECUTION_USER, OWNER_LABEL, POLICY_LABEL, type ExecutionLimits, type GatewaySettings,
} from './common.ts'
import { brokerEnvironment, ExecutionGateway, GUEST_GATEWAY_URL } from './gateway.ts'
import type { ContainerId, ExecutionBroker, ExecutionObservation, WorkspaceTransferRequest, WorkspaceTransferResult } from './service.ts'
import { EXEC_WORKSPACE } from './tool.ts'
import { runWorkspaceTransfer } from './workspace-transfer.ts'

const GATEWAY_LABEL = 'io.deepseek.dsh.execution-gateway'
const CONTROL_OUTPUT_BYTES = 65_536
const GUEST_SOCKET = '/run/dsh-gateway.sock'
const KEEPER = `/usr/bin/socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${GUEST_SOCKET} &
exec /bin/sleep "$1"`
const PROBE_GATEWAY = `
const http = require('node:http')
function probe() {
  http.get({ host: '127.0.0.1', port: 3128, agent: false }, response => {
    response.resume()
    if (response.statusCode !== 405) process.exitCode = 1
  }).on('error', error => {
    if (error.code !== 'ECONNREFUSED') throw error
    setTimeout(probe, 25)
  })
}
probe()
`
const SHA256 = /^sha256:[a-f0-9]{64}$/u

/** Trusted deployment settings for the Apple microVM and its Host gateway. */
export interface AppleVmConfig extends ExecutionLimits, GatewaySettings {
  /** Apple container executable name or absolute path. */
  vmCommand?: string
  /** Preloaded Linux ARM64 execution image reference. */
  image: string
  /** Stable absolute path to the gateway socket in a private Host directory. */
  gatewaySocket: string
  /** Approved CONNECT targets in hostname:port form. */
  allowedTargets?: string[]
  /** Number of guest container CPU cores. */
  cpus?: number
}

/** Validate the Apple container command, gateway socket, and guest limits. */
export const AppleVmConfig: z<AppleVmConfig> = z.object({
  vmCommand: z.string().pattern(/\S/u).default('container'),
  image: z.string().pattern(/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/u).required(),
  ...gatewaySettings.dict,
  gatewaySocket: gatewaySocketPath.required(),
  allowedTargets: z.array(z.string()).default([]),
  ...executionLimits.dict,
  cpus: z.number().step(1).min(1).max(1_024).default(1),
})

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
}

function readSingleRecord(text: string): Record<string, unknown> {
  const entries: unknown = JSON.parse(text)
  const entry = Array.isArray(entries) && entries.length === 1 ? record(entries[0]) : undefined
  if (entry === undefined) throw new Error('Apple container returned an invalid inspection record')
  return entry
}

async function inspect(cli: ExecutionCli, id: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  return readSingleRecord(await cli.control(['inspect', id], 'inspect the Session VM', signal))
}

async function listVmNames(cli: ExecutionCli, signal: AbortSignal): Promise<string[]> {
  const text = await cli.control(['list', '--all', '--quiet'], 'list Session VMs', signal)
  return text.split('\n')
}

/** Runs one script at a time in each Session's dedicated microVM. */
export class AppleVmExecutor extends SessionExecutor {
  private readonly gateway: ExecutionGateway
  private readonly gatewayOwner: string
  private readonly namePrefix: string
  private readonly interrupted = new Set<string>()
  private gatewayClosing: Promise<void> | undefined
  private readonly prepared: Promise<{ cli: ExecutionCli; image: string; policy: string }>

  /**
   * @param ctx - operation authority's local subprocess provider and logger.
   * @param config - validated deployment settings.
   * @param workspaceNamespace - stable namespace for the authority's Session workspaces.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Required<AppleVmConfig>,
    private readonly workspaceNamespace: string,
  ) {
    super(config.maxCommandBytes)
    this.gatewayOwner = hash(resolve(config.gatewaySocket))
    this.namePrefix = `dsh-vm-${this.gatewayOwner.slice(0, 12)}-`
    this.gateway = new ExecutionGateway({
      socketPath: config.gatewaySocket,
      allowedTargets: config.allowedTargets,
      idleTimeoutMs: config.gatewayIdleTimeoutMs,
      maxConnections: config.gatewayMaxConnections,
    })
    this.prepared = this.prepare()
  }

  /**
   * Wait for the gateway and local image inspection before admitting commands.
   * @returns The inspected OCI image digest used to verify every Session VM.
   */
  get ready(): Promise<string> {
    return this.prepared.then(({ image }) => image)
  }

  /**
   * Cancel active executions and close the Host gateway after their stop attempts settle.
   * @returns Completion of execution settlement and gateway disposal.
   */
  async dispose(): Promise<void> {
    await this.settle(this.prepared, 'Apple VM executor disposed')
    await this.closeGateway()
  }

  private closeGateway(): Promise<void> {
    return this.gatewayClosing ??= this.gateway.close()
  }

  private async prepare(): Promise<{ cli: ExecutionCli; image: string; policy: string }> {
    using limit = deadline(this.signal, this.config.stopTimeoutMs, 'EXEC_STARTUP_TIMEOUT')
    const { vmCommand, image, memoryMiB, cpus, pidsLimit, timeoutMs, stopTimeoutMs, gatewaySocket } = this.config
    const executable = await this.ctx.subprocess.resolveExecutable(vmCommand, undefined, limit.signal)
    const cli = new ExecutionCli(this.ctx.subprocess, {
      argv: [executable],
      cwd: '/',
      envPrefix: 'CONTAINER_',
      stopTimeoutMs,
      controlBytes: CONTROL_OUTPUT_BYTES,
      setupHint: 'Check Apple container and the preloaded execution image.',
      failureCode: 'EXEC_VM',
    })
    const inspection = readSingleRecord(await cli.control(['image', 'inspect', image], 'inspect the preloaded execution image', limit.signal))
    const digest = record(record(inspection.configuration)?.descriptor)?.digest
    const variants: unknown = inspection.variants
    if (typeof digest !== 'string' || !SHA256.test(digest) || !Array.isArray(variants) || !variants.some((variant: unknown) => {
      const platform = record(record(variant)?.platform)
      return platform?.os === 'linux' && platform.architecture === 'arm64'
    })) {
      throw new HarnessError('Choose a preloaded Linux ARM64 execution image.', 'EXEC_IMAGE')
    }
    await this.gateway.ready(() => this.recover(cli, limit.signal))
    const policy = hash(JSON.stringify(['dsh-apple-vm', digest, gatewaySocket, memoryMiB, cpus, pidsLimit, timeoutMs, stopTimeoutMs]))
    return { cli, image: digest, policy }
  }

  private async recover(cli: ExecutionCli, signal: AbortSignal): Promise<void> {
    const names = await listVmNames(cli, signal)
    for (const id of names) {
      if (!id.startsWith(this.namePrefix) || !/^[a-f0-9]{32}$/u.test(id.slice(this.namePrefix.length))) continue
      const inspection = await inspect(cli, id, signal)
      const labels = record(record(inspection.configuration)?.labels)
      if (inspection.id !== id || labels?.[GATEWAY_LABEL] !== this.gatewayOwner) {
        throw new HarnessError('Apple container has a conflicting Session VM. Ask the operator to inspect its ownership and settings.', 'EXEC_CONTAINER_CONFLICT')
      }
      if (record(inspection.status)?.state !== 'stopped') {
        await this.stop(cli, id)
        this.interrupted.add(id)
      }
    }
  }

  protected async execute(
    session: SessionId, command: string, signal: AbortSignal, broker?: ExecutionBroker,
  ): Promise<ExecutionObservation> {
    return this.withVm(session, signal, 'execute the script', async (cli, id, lifetime) => {
      const result = await this.runInVm(cli, id, lifetime, async (brokerEnv) => {
        await cli.control([
          'exec', id, '/usr/local/bin/node', '-e', PROBE_GATEWAY,
        ], 'reach the Host gateway from the Session VM', lifetime)
        return cli.run([
          'exec', '--interactive',
          ...brokerEnv?.args ?? [],
          id, '/bin/sh', '-s',
        ], lifetime, this.config.maxOutputBytes, { data: command }, brokerEnv?.env)
      }, broker)
      return observeStopped(result, hash(id) as ContainerId, this.config.maxOutputBytes)
    })
  }

  protected copyFile(session: SessionId, request: WorkspaceTransferRequest, signal: AbortSignal): Promise<WorkspaceTransferResult> {
    return this.withVm(session, signal, 'transfer the workspace file', (cli, id, lifetime) =>
      this.runInVm(cli, id, lifetime, () => runWorkspaceTransfer(cli, ['exec', '--interactive', id], request, lifetime)))
  }

  private async withVm<T>(
    session: SessionId, signal: AbortSignal, operation: string,
    run: (cli: ExecutionCli, id: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    using limit = deadline(signal, this.config.timeoutMs, EXEC_TIMEOUT)
    try {
      const { cli, image, policy } = await this.prepared
      limit.signal.throwIfAborted()
      const owner = hash(JSON.stringify([this.workspaceNamespace, session]))
      const id = `${this.namePrefix}${owner.slice(0, 32)}`
      if (this.interrupted.delete(id)) throw interruptedExecution()
      await this.findOrCreate(cli, id, owner, image, policy, limit.signal)
      return await run(cli, id, limit.signal)
    } catch (cause) {
      if (cause instanceof HarnessError && cause.code === 'EXEC_STOP_UNKNOWN') {
        this.abort(cause)
        try {
          await this.closeGateway()
        } catch (closeError) {
          this.ctx.logger.warn('Could not close the Session VM gateway after an unconfirmed shutdown.', closeError)
        }
      }
      throw executionFailure(cause, signal, limit.signal, 'Apple container', 'EXEC_VM', operation)
    }
  }

  private async findOrCreate(
    cli: ExecutionCli,
    id: string,
    owner: string,
    image: string,
    policy: string,
    signal: AbortSignal,
  ): Promise<void> {
    const names = await listVmNames(cli, signal)
    if (!names.includes(id)) {
      await this.create(cli, id, owner, policy, signal)
    }

    const inspection = await inspect(cli, id, signal)
    const configuration = record(inspection.configuration)
    const labels = record(configuration?.labels)
    const digest = record(record(configuration?.image)?.descriptor)?.digest
    const networks: unknown = configuration?.networks
    const mounts: unknown = configuration?.mounts
    const state = record(inspection.status)?.state
    if (inspection.id !== id || labels?.[OWNER_LABEL] !== owner
      || labels[POLICY_LABEL] !== policy || labels[GATEWAY_LABEL] !== this.gatewayOwner
      || digest !== image || !Array.isArray(networks) || networks.length !== 0 || !this.ownsMounts(mounts)) {
      throw new HarnessError('Apple container has a conflicting Session VM. Ask the operator to inspect its ownership and settings.', 'EXEC_CONTAINER_CONFLICT')
    }
    if (state !== 'stopped') {
      await this.stop(cli, id)
      throw interruptedExecution()
    }
  }

  private ownsMounts(mounts: unknown): boolean {
    if (!Array.isArray(mounts) || mounts.length !== 2) return false
    const workspace = record(mounts[0])
    const gateway = record(mounts[1])
    return workspace?.destination === EXEC_WORKSPACE && record(record(workspace.type)?.volume)?.format === 'ext4'
      && gateway?.destination === GUEST_SOCKET && gateway.source === resolve(this.config.gatewaySocket)
      && record(gateway.type)?.virtiofs !== undefined
  }

  private async create(cli: ExecutionCli, id: string, owner: string, policy: string, signal: AbortSignal): Promise<void> {
    const { image, gatewaySocket, memoryMiB, cpus, pidsLimit, timeoutMs, stopTimeoutMs } = this.config
    await this.requireGatewaySocket()
    const keeperSeconds = String(Math.ceil((timeoutMs + stopTimeoutMs) / 1_000))
    await cli.control([
      'create', '--name', id, '--platform', 'linux/arm64',
      '--label', `${OWNER_LABEL}=${owner}`, '--label', `${POLICY_LABEL}=${policy}`, '--label', `${GATEWAY_LABEL}=${this.gatewayOwner}`,
      '--network', 'none', '--no-dns', '--read-only', '--cap-drop', 'ALL',
      '--user', EXECUTION_USER, '--workdir', EXEC_WORKSPACE,
      '--memory', `${memoryMiB}MiB`, '--cpus', String(cpus), '--ulimit', `nproc=${pidsLimit}:${pidsLimit}`,
      '--volume', EXEC_WORKSPACE, '--volume', `${gatewaySocket}:${GUEST_SOCKET}`,
      '--env', `HOME=${EXEC_WORKSPACE}`, '--env', `TMPDIR=${EXEC_WORKSPACE}`,
      '--env', `http_proxy=${GUEST_GATEWAY_URL}`, '--env', `https_proxy=${GUEST_GATEWAY_URL}`,
      '--env', `HTTP_PROXY=${GUEST_GATEWAY_URL}`, '--env', `HTTPS_PROXY=${GUEST_GATEWAY_URL}`,
      '--env', 'NODE_USE_ENV_PROXY=1',
      '--entrypoint', '/bin/sh', image, '-c', KEEPER, 'dsh-vm-keeper', keeperSeconds,
    ], 'create the isolated Session VM', signal)
  }

  private async requireGatewaySocket(): Promise<void> {
    const { gatewaySocket } = this.config
    if (!(await lstat(gatewaySocket)).isSocket()) {
      throw new HarnessError('The Host gateway path must be a Unix socket. Check the execution configuration.', 'EXEC_VM_GATEWAY')
    }
  }

  private async runInVm<T>(
    cli: ExecutionCli, id: string, signal: AbortSignal,
    run: (brokerEnv?: ReturnType<typeof brokerEnvironment>) => Promise<T>, broker?: ExecutionBroker,
  ): Promise<T> {
    await this.requireGatewaySocket()
    const registration = broker === undefined ? undefined : this.gateway.registerBroker(broker, signal)
    const brokerEnv = registration === undefined ? undefined : brokerEnvironment(registration.token)
    try {
      await cli.control(['start', id], 'start the isolated Session VM', signal)
      await cli.control([
        'exec', '--user', '0:0', id, '/bin/chmod', '1777', EXEC_WORKSPACE,
      ], 'prepare the isolated workspace', signal)
      return await run(brokerEnv)
    } finally {
      const draining = registration?.dispose()
      try {
        await this.stop(cli, id)
      } finally {
        if (draining !== undefined) await draining
      }
    }
  }

  private async stop(cli: ExecutionCli, id: string): Promise<void> {
    using limit = deadline(undefined, this.config.stopTimeoutMs, 'EXEC_STOP_TIMEOUT')
    try {
      // The keeper may already have expired by the time the authority asks to stop.
      await cli.run(['stop', '--time', '0', id], limit.signal, CONTROL_OUTPUT_BYTES)
      const inspection = await inspect(cli, id, limit.signal)
      if (inspection.id !== id || record(inspection.status)?.state !== 'stopped') {
        throw new Error('Apple container did not report the VM stopped')
      }
    } catch (cause) {
      const message = 'Could not confirm the Session VM stopped. Ask the operator to check Apple container before continuing.'
      this.ctx.logger.warn(`execution-container: ${message} VM ${id}.`, cause)
      throw new HarnessError(message, 'EXEC_STOP_UNKNOWN', { cause })
    }
  }
}
