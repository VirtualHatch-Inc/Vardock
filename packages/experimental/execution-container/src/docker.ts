/** Docker-owned Session workspaces, bounded CLI calls, and container quiescence. */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import {
  ExecutionCli, SessionExecutor, executionFailure, executionLimits, gatewaySettings, hash, interruptedExecution, observeStopped,
  EXEC_TIMEOUT, EXECUTION_USER, OWNER_LABEL, POLICY_LABEL, type ExecutionLimits, type GatewaySettings,
} from './common.ts'
import { ExecutionGateway, brokerEnvironment, GUEST_GATEWAY_PORT, MAX_BROKER_REQUEST_BYTES } from './gateway.ts'
import { pumpRelay, RELAY_SCRIPT } from './relay.ts'
import type { ContainerId, ExecutionBroker, ExecutionObservation, WorkspaceTransferRequest, WorkspaceTransferResult } from './service.ts'
import { EXEC_WORKSPACE } from './tool.ts'
import { runWorkspaceTransfer } from './workspace-transfer.ts'

const CONTROL_OUTPUT_BYTES = 4_096
const HEX_ID = /^[a-f0-9]{64}$/u

/** Immutable SHA-256 digest of the preloaded Docker image. */
export type ImageId = Branded<'DockerImageId'>

/** OCI runtimes the Docker backend supports. */
export type DockerRuntime = 'runc' | 'runsc' | 'io.containerd.kata.v2'

/** Trusted deployment configuration for Docker execution. */
export interface DockerConfig extends ExecutionLimits, GatewaySettings {
  /** Path to a local Docker daemon's Unix socket. */
  dockerSocket: string
  /** Preloaded Linux image reference. The image must provide POSIX shell utilities and declare no volumes. */
  image: string
  /** Docker executable name or absolute path. */
  command?: string
  /** OCI runtime registered with the Docker daemon under this name. */
  runtime?: DockerRuntime
  /** Container CPU limit in cores. */
  cpus?: number
}

/** Validate the Docker endpoint, image, and resource limits. */
export const DockerConfig: z<DockerConfig> = z.object({
  dockerSocket: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
  image: z.string().pattern(/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/u).required(),
  command: z.string().pattern(/\S/u).default('docker'),
  runtime: z.union(['runc', 'runsc', 'io.containerd.kata.v2'] as const).default('runc'),
  ...gatewaySettings.dict,
  ...executionLimits.dict,
  cpus: z.number().min(0.01).max(1_024).default(1),
})

function containerId(value: string): ContainerId {
  if (!HEX_ID.test(value)) throw new HarnessError('Docker returned an invalid container identity.', 'EXEC_DOCKER')
  return value as ContainerId
}

/** Validated Docker settings; `gatewaySocket` stays optional because it enables broker requests. */
export type ResolvedDockerConfig = Required<Omit<DockerConfig, 'gatewaySocket'>> & Pick<DockerConfig, 'gatewaySocket'>

/**
 * Smallest `pidsLimit` under which each runtime runs the keeper, the broker relay, and a shell running a Node script
 * that uses fetch and its thread pool: a measured peak of 20 tasks under runc and 45 under runsc, which also counts the
 * sandbox's own Host threads. Kata's operating minimum has not been measured.
 */
const RELAY_PIDS_LIMIT: Readonly<Partial<Record<DockerRuntime, number>>> = { runc: 20, runsc: 48 }

/**
 * Reject a configuration whose process limit leaves the selected runtime unable to start the broker relay.
 * @param config - Validated Docker settings.
 */
export function assertRelayPidsLimit(config: ResolvedDockerConfig): void {
  const minimum = RELAY_PIDS_LIMIT[config.runtime]
  if (config.gatewaySocket !== undefined && minimum !== undefined && config.pidsLimit < minimum) {
    throw new Error(`Docker runtime ${config.runtime} with gatewaySocket requires pidsLimit of at least ${minimum}`)
  }
}

/** Owns active calls, the private Docker CLI configuration directory, and the optional broker gateway. */
export class ContainerExecutor extends SessionExecutor {
  // Docker CLI config can implicitly inject proxy credentials into containers.
  private readonly configDir = mkdtempSync(join(tmpdir(), 'dsh-execution-container-'))
  private readonly policy: string
  private readonly gateway: { readonly server: ExecutionGateway; readonly socketPath: string } | undefined
  private readonly prepared: Promise<{ docker: ExecutionCli; imageId: ImageId }>

  /**
   * @param ctx - authority's subprocess provider and logger.
   * @param config - validated deployment configuration.
   * @param home - resolved Harness home that owns these Session identities.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedDockerConfig,
    private readonly home: string,
  ) {
    super(config.maxCommandBytes)
    const { image, runtime, memoryMiB, cpus, pidsLimit, timeoutMs, stopTimeoutMs, gatewaySocket } = config
    this.policy = hash(JSON.stringify(['dsh-isolated-container', image, runtime, memoryMiB, cpus, pidsLimit, timeoutMs, stopTimeoutMs]))
    this.gateway = gatewaySocket === undefined ? undefined : {
      server: new ExecutionGateway({
        socketPath: gatewaySocket,
        allowedTargets: [],
        idleTimeoutMs: config.gatewayIdleTimeoutMs,
        maxConnections: config.gatewayMaxConnections,
      }),
      socketPath: gatewaySocket,
    }
    this.prepared = this.prepare()
  }

  /**
   * Wait for Docker preflight.
   * @returns The validated image digest after confirming the local daemon is accessible.
   */
  get ready(): Promise<ImageId> {
    return this.prepared.then(({ imageId }) => imageId)
  }

  /**
   * Cancel active calls and wait for cleanup before closing the gateway and removing Docker CLI config.
   * @returns Completion of active call settlement and local cleanup.
   */
  async dispose(): Promise<void> {
    await this.settle(this.prepared, 'Container executor disposed')
    await this.gateway?.server.close()
    await rm(this.configDir, { recursive: true, force: true })
  }

  private async prepare(): Promise<{ docker: ExecutionCli; imageId: ImageId }> {
    using limit = deadline(this.signal, this.config.stopTimeoutMs, 'EXEC_STARTUP_TIMEOUT')
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.command, undefined, limit.signal)
    const docker = new ExecutionCli(this.ctx.subprocess, {
      argv: [executable, '--config', this.configDir, '--host', `unix://${this.config.dockerSocket}`],
      cwd: this.configDir,
      envPrefix: 'DOCKER_',
      stopTimeoutMs: this.config.stopTimeoutMs,
      controlBytes: CONTROL_OUTPUT_BYTES,
      setupHint: 'Check the configured Docker daemon and image.',
      failureCode: 'EXEC_DOCKER',
    })
    const inspection = await docker.control([
      'image', 'inspect', '--format',
      '{{.Id}} {{.Os}}{{with index .Config "Volumes"}} {{len .}}{{else}} 0{{end}}', this.config.image,
    ], 'inspect the preloaded execution image', limit.signal)
    const [imageId, platform, volumes] = inspection.split(' ')
    if (imageId === undefined || !/^sha256:[a-f0-9]{64}$/u.test(imageId) || platform !== 'linux' || volumes !== '0') {
      throw new HarnessError('Choose a preloaded Linux execution image with no declared Docker volumes.', 'EXEC_IMAGE')
    }
    // No container reaches the socket directly, so no orphaned container needs stopping before it listens.
    await this.gateway?.server.ready()
    return { docker, imageId: imageId as ImageId }
  }

  protected async execute(
    session: SessionId, command: string, signal: AbortSignal, broker?: ExecutionBroker,
  ): Promise<ExecutionObservation> {
    const gateway = this.gateway
    if (broker !== undefined && gateway === undefined) {
      throw new HarnessError('Docker execution needs a gateway socket for business requests.', 'EXEC_BROKER_UNAVAILABLE')
    }
    return this.withContainer(session, signal, 'execute the script', async (docker, id, lifetime) => {
      const script = (forwarded?: ReturnType<typeof brokerEnvironment>) => docker.run([
        'container', 'exec', '--interactive', ...forwarded?.args ?? [], id, '/bin/sh', '-s',
      ], lifetime, this.config.maxOutputBytes, { data: command }, forwarded?.env)
      const result = broker === undefined || gateway === undefined
        ? await this.runInContainer(docker, id, lifetime, () => script())
        : await this.runWithBroker(docker, id, lifetime, gateway, broker, script)
      return observeStopped(result, id, this.config.maxOutputBytes)
    })
  }

  /**
   * Run a script with a per-call broker credential and a relay that carries its requests to the gateway.
   * The credential is withdrawn before the container stops; the drain and the relay's end are awaited after the stop.
   */
  private async runWithBroker<T>(
    docker: ExecutionCli, id: ContainerId, signal: AbortSignal, gateway: NonNullable<ContainerExecutor['gateway']>,
    broker: ExecutionBroker, run: (forwarded: ReturnType<typeof brokerEnvironment>) => Promise<T>,
  ): Promise<T> {
    const registration = gateway.server.registerBroker(broker, signal)
    let draining: Promise<void> | undefined
    let relay: { handle: SubprocessHandle; done: Promise<void> } | undefined
    try {
      return await this.runInContainer(docker, id, signal, async () => {
        try {
          relay = await this.startRelay(docker, id, signal, gateway.socketPath)
          return await run(brokerEnvironment(registration.token))
        } finally {
          draining = registration.dispose()
        }
      })
    } finally {
      draining ??= registration.dispose()
      // After the stop, or when the stop is unconfirmed, the relay command must not outlive the call.
      relay?.handle.terminate()
      await draining
      // A provider failure of the relay command was already observed as a readiness failure.
      await Promise.allSettled([relay?.handle.done, relay?.done])
    }
  }

  private async startRelay(
    docker: ExecutionCli, id: ContainerId, signal: AbortSignal, socketPath: string,
  ): Promise<{ handle: SubprocessHandle; done: Promise<void> }> {
    const handle = docker.spawn([
      'container', 'exec', '--interactive', id, '/usr/local/bin/node', '-e', RELAY_SCRIPT, '--',
      String(GUEST_GATEWAY_PORT), String(MAX_BROKER_REQUEST_BYTES), String(this.config.gatewayMaxConnections),
    ], signal, { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: CONTROL_OUTPUT_BYTES } })
    const { stdin, stdout } = handle
    if (stdin === undefined || stdout === undefined) throw new Error('Execution CLI requires piped relay streams')
    const pump = pumpRelay({ input: stdout, output: stdin, stop: () => { handle.terminate() } }, {
      socketPath, maxConnections: this.config.gatewayMaxConnections,
    }, (error) => {
      this.ctx.logger.warn(`execution-container: Stopped the broker relay of container ${id}. Its later business requests fail.`, error)
    })
    const relay = { handle, done: pump.done }
    const stop = (): void => { handle.terminate() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      await pump.ready
      return relay
    } catch (cause) {
      // The relay ended, the pump stopped it, or the execution deadline did.
      await Promise.allSettled([handle.done, pump.done])
      throw new Error(`The broker relay did not start: ${handle.collected.stderr?.readFrom(0).text ?? ''}`, { cause })
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  protected copyFile(session: SessionId, request: WorkspaceTransferRequest, signal: AbortSignal): Promise<WorkspaceTransferResult> {
    return this.withContainer(session, signal, 'transfer the workspace file', (docker, id, lifetime) =>
      this.runInContainer(docker, id, lifetime, () =>
        runWorkspaceTransfer(docker, ['container', 'exec', '--interactive', id], request, lifetime)))
  }

  private async withContainer<T>(
    session: SessionId, signal: AbortSignal, operation: string,
    run: (docker: ExecutionCli, id: ContainerId, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    using limit = deadline(signal, this.config.timeoutMs, EXEC_TIMEOUT)
    try {
      const { docker, imageId } = await this.prepared
      const id = await this.findOrCreate(docker, imageId, session, limit.signal)
      return await run(docker, id, limit.signal)
    } catch (cause) {
      throw executionFailure(cause, signal, limit.signal, 'Docker', 'EXEC_DOCKER', operation)
    }
  }

  private async findOrCreate(docker: ExecutionCli, imageId: ImageId, session: SessionId, signal: AbortSignal): Promise<ContainerId> {
    const owner = hash(JSON.stringify([this.home, session]))
    const name = `dsh-exec-${owner.slice(0, 32)}`
    const listed = await docker.control([
      'container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}',
    ], 'locate the Session container', signal)
    if (!listed) return this.create(docker, imageId, name, owner, signal)

    const id = containerId(listed)
    const inspection = await docker.control([
      'container', 'inspect', '--format',
      `{{with index .Config "Labels"}}{{index . "${OWNER_LABEL}"}} {{index . "${POLICY_LABEL}"}}{{else}}- -{{end}} {{.Image}} {{.State.Status}}`, id,
    ], 'inspect the Session container', signal)
    const [recordedOwner, policy, recordedImage, status] = inspection.split(' ')
    if (recordedOwner !== owner || policy !== this.policy || recordedImage !== imageId) {
      throw new HarnessError('Docker has a conflicting Session container. Ask the operator to inspect its ownership and settings.', 'EXEC_CONTAINER_CONFLICT')
    }
    if (status !== 'created' && status !== 'exited') {
      await this.stop(docker, id)
      throw interruptedExecution()
    }
    return id
  }

  private async create(docker: ExecutionCli, imageId: ImageId, name: string, owner: string, signal: AbortSignal): Promise<ContainerId> {
    const { memoryMiB, cpus, pidsLimit, timeoutMs, stopTimeoutMs } = this.config
    const memory = `${memoryMiB}m`
    // The keeper terminates the container if the authority exits abruptly.
    const keeperSeconds = String(Math.ceil((timeoutMs + stopTimeoutMs) / 1_000))
    const created = await docker.control([
      'container', 'create', '--pull', 'never', '--name', name,
      '--label', `${OWNER_LABEL}=${owner}`, '--label', `${POLICY_LABEL}=${this.policy}`,
      '--runtime', this.config.runtime, '--network', 'none', '--dns', '127.0.0.1', '--dns-search', '.', '--ipc', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--no-healthcheck', '--restart', 'no',
      '--log-driver', 'none', '--user', EXECUTION_USER, '--workdir', EXEC_WORKSPACE,
      '--env', `HOME=${EXEC_WORKSPACE}`, '--env', `TMPDIR=${EXEC_WORKSPACE}`,
      '--memory', memory, '--memory-swap', memory, '--cpus', String(cpus), '--pids-limit', String(pidsLimit),
      '--mount', `type=volume,destination=${EXEC_WORKSPACE},volume-nocopy`,
      '--entrypoint', '/bin/sleep', imageId, keeperSeconds,
    ], 'create the isolated Session container', signal)
    return containerId(created)
  }

  private async runInContainer<T>(docker: ExecutionCli, id: ContainerId, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    try {
      await docker.control(['container', 'start', id], 'start the isolated Session container', signal)
      // The anonymous volume starts root-owned. Only this fixed setup command uses root.
      await docker.control([
        'container', 'exec', '--user', '0:0', id, '/bin/chmod', '1777', EXEC_WORKSPACE,
      ], 'prepare the isolated workspace', signal)
      return await run()
    } finally {
      // Docker exec can return while guest descendants still exist.
      await this.stop(docker, id)
    }
  }

  private async stop(docker: ExecutionCli, id: ContainerId): Promise<void> {
    using limit = deadline(undefined, this.config.stopTimeoutMs, 'EXEC_STOP_TIMEOUT')
    try {
      await docker.control(['container', 'stop', '--timeout', '0', id], 'stop the isolated Session container', limit.signal)
    } catch (cause) {
      const message = 'Could not confirm the Session container stopped. Ask the operator to check Docker before continuing.'
      this.ctx.logger.warn(`execution-container: ${message} Container ${id}.`, cause)
      throw new HarnessError(message, 'EXEC_STOP_UNKNOWN', { cause })
    }
  }
}
