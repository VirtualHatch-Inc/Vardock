/** Service Definition for isolated execution of authority-approved Session scripts. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    isolatedExecution: IsolatedExecution
  }
}

/** Opaque execution container identity used by operation records and evidence. */
export type ContainerId = Branded<'DockerContainerId'>

/** Script outcome confirmed after the container has stopped. */
export interface ExecutionObservation {
  /** Exit status of the script. */
  exitCode: number
  /** Captured standard output within the configured byte limit. */
  stdout: string
  /** Captured standard error within the configured byte limit. */
  stderr: string
  /** Whether standard output was truncated during collection or formatting. */
  stdoutTruncated: boolean
  /** Whether standard error was truncated during collection or formatting. */
  stderrTruncated: boolean
  /** Container that ran the script. */
  containerId: ContainerId
  /** Confirmation that the container has stopped. */
  stopped: true
}

/** Resolved deployment policy used for operation admission and grant revision. */
export interface IsolatedExecutionPolicy {
  /** Stable digest of the backend, immutable image, and execution settings. */
  readonly fingerprint: string
  /** Maximum UTF-8 bytes in an admitted script. */
  readonly maxCommandBytes: number
  /** Maximum UTF-8 bytes in a rendered script result. */
  readonly maxOutputBytes: number
  /** Whether this backend can carry per-execution requests with direct egress disabled. */
  readonly supportsBroker: boolean
}

/** Handle one guest JSON request. The authority validates the payload and settles on cancellation. */
export type ExecutionBroker = (request: unknown, signal: AbortSignal) => Promise<unknown>

/** Copy one file into or out of a stopped Session's workspace. */
export type WorkspaceTransferRequest =
  | { readonly kind: 'import'; readonly path: string; readonly data: Uint8Array; readonly maxBytes: number }
  | { readonly kind: 'export'; readonly path: string; readonly maxBytes: number }

/** Exact byte count and SHA-256 digest of the completed transfer. */
export type WorkspaceTransferResult =
  | { readonly kind: 'imported'; readonly bytes: number; readonly digest: string }
  | { readonly kind: 'exported'; readonly bytes: number; readonly digest: string; readonly data: Uint8Array }

/** Isolated execution for one workspace namespace, owned by its consumer. */
export interface IsolatedExecutionLease {
  /** Resolves after preflight. A failure prevents admission. */
  readonly ready: Promise<IsolatedExecutionPolicy>

  /**
   * Execute a script in a Session's isolated workspace after preflight.
   * @param session - persistent Session identity within this namespace.
   * @param command - exact approved POSIX shell script.
   * @param signal - execution cancellation.
   * @param broker - Optional request handler for this execution only. Requires `supportsBroker`.
   * @returns Bounded output and exit status after confirming that the container stopped.
   * @throws On execution or shutdown failure. The workspace may contain partial changes.
   */
  run(session: SessionId, command: string, signal: AbortSignal, broker?: ExecutionBroker): Promise<ExecutionObservation>

  /**
   * Copy one regular file while holding exclusive access to the workspace. Imports use
   * `input/` and accept an existing destination only if its bytes match. Exports
   * require an existing file. Both reject links and return only after confirming stop.
   * @param session - Persistent Session identity within this namespace.
   * @param request - Direction, relative workspace path, byte limit, and bytes for an import.
   * @param signal - Transfer cancellation, followed by independent cleanup.
   * @returns The byte count and digest, with exact bytes for an export.
   * @throws On unsafe paths, byte limit, conflicts, or unconfirmed transfer or stop.
   */
  transfer?(session: SessionId, request: WorkspaceTransferRequest, signal: AbortSignal): Promise<WorkspaceTransferResult>

  /**
   * Cancel active calls and release resources owned by this lease.
   * @returns Settlement after active calls finish cleanup.
   */
  dispose(): Promise<void>
}

/** Service Definition for providing isolated Session workspaces. */
export abstract class IsolatedExecution extends Service {
  constructor(ctx: Context) {
    super(ctx, 'isolatedExecution')
  }

  /** Local paths reserved for backend infrastructure. */
  abstract readonly reservedPaths: readonly string[]

  /**
   * Prepare a backend for the given namespace. The caller owns the lease and must dispose it even if preflight fails.
   * @param workspaceNamespace - stable operator-owned namespace for persistent workspaces.
   * @returns A lease whose readiness must be confirmed before admitting operations.
   */
  abstract open(workspaceNamespace: string): IsolatedExecutionLease
}
