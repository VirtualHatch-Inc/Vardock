/** Select the configured isolated execution backend for the operation authority. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertRelayPidsLimit, ContainerExecutor, DockerConfig, type ResolvedDockerConfig } from './docker.ts'
import { IsolatedExecution, type IsolatedExecutionLease } from './service.ts'
import { AppleVmConfig, AppleVmExecutor } from './vm.ts'

export type { ImageId } from './docker.ts'
export { IsolatedExecution } from './service.ts'
export type {
  ContainerId, ExecutionBroker, ExecutionObservation, IsolatedExecutionLease, IsolatedExecutionPolicy,
  WorkspaceTransferRequest, WorkspaceTransferResult,
} from './service.ts'
export type { Config }

/** Execution backend and its operator-owned deployment settings. */
type Config =
  | (DockerConfig & {
    /** Run commands with a local Docker daemon. */
    readonly backend: 'docker'
  })
  | (AppleVmConfig & {
    /** Run commands with an Apple container Linux microVM. */
    readonly backend: 'apple-vm'
  })

/** Settings after validation; Docker's `gatewaySocket` stays optional. */
type ResolvedConfig = (ResolvedDockerConfig & { readonly backend: 'docker' }) | Required<AppleVmConfig & { readonly backend: 'apple-vm' }>

/** Validate settings for exactly one execution backend. */
const Config: z<Config> = z.union([
  z.intersect([z.object({ backend: z.const('docker').required() }), DockerConfig]),
  z.intersect([z.object({ backend: z.const('apple-vm').required() }), AppleVmConfig]),
])

/** Run scripts through an operator-selected local Docker or Apple VM backend. */
export default class ConfiguredIsolatedExecution extends IsolatedExecution {
  static readonly inject = ['subprocess']
  static readonly Config = Config

  readonly reservedPaths: readonly string[]
  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = Config(config) as ResolvedConfig
    if (this.config.backend === 'docker') assertRelayPidsLimit(this.config)
    this.reservedPaths = this.config.backend === 'docker'
      ? [this.config.dockerSocket, ...this.config.gatewaySocket === undefined ? [] : [this.config.gatewaySocket]]
      : [this.config.gatewaySocket]
  }

  override open(workspaceNamespace: string): IsolatedExecutionLease {
    const config = this.config
    const runner = config.backend === 'docker'
      ? new ContainerExecutor(this.ctx, config, workspaceNamespace)
      : new AppleVmExecutor(this.ctx, config, workspaceNamespace)
    const settings = Object.entries(config).sort(([left], [right]) => left.localeCompare(right, 'en'))
    return {
      ready: runner.ready.then(imageId => ({
        fingerprint: createHash('sha256').update(JSON.stringify([imageId, settings])).digest('hex'),
        maxCommandBytes: config.maxCommandBytes,
        maxOutputBytes: config.maxOutputBytes,
        supportsBroker: config.backend === 'docker' ? config.gatewaySocket !== undefined : config.allowedTargets.length === 0,
      })),
      run: (session, command, signal, broker) => runner.run(session, command, signal, broker),
      transfer: (session, request, signal) => runner.transfer(session, request, signal),
      dispose: () => runner.dispose(),
    }
  }
}
