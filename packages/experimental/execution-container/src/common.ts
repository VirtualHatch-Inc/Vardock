/** Script admission, CLI collection, and output limits shared by both execution backends. */
import { createHash } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessRuntime, SubprocessStdinMode, SubprocessStdio,
} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import type { ContainerId, ExecutionBroker, ExecutionObservation, WorkspaceTransferRequest, WorkspaceTransferResult } from './service.ts'
import { renderExecutionObservation } from './tool.ts'
import { prepareWorkspaceTransfer } from './workspace-transfer.ts'

/** CLI label identifying the Session workspace owner. */
export const OWNER_LABEL = 'io.deepseek.dsh.execution'
/** CLI label identifying the runtime settings a workspace was created with. */
export const POLICY_LABEL = 'io.deepseek.dsh.execution-policy'
/** Deadline code for an individual script call. */
export const EXEC_TIMEOUT = 'EXEC_TIMEOUT'
/** Numeric unprivileged guest user and group. */
export const EXECUTION_USER = '65532:65532'

/** Operator-configurable execution and resource bounds. */
export interface ExecutionLimits {
  /** Milliseconds for preparation and script execution. Stop has a separate budget. */
  timeoutMs?: number
  /** Milliseconds allowed for an independent stop and subprocess termination grace. */
  stopTimeoutMs?: number
  /** Maximum UTF-8 bytes in a shell script. */
  maxCommandBytes?: number
  /** Maximum UTF-8 bytes in a successful tool result. */
  maxOutputBytes?: number
  /** Guest container memory limit in MiB. */
  memoryMiB?: number
  /** Guest process and thread limit. */
  pidsLimit?: number
}

/** Default and validate the limits common to both execution runtimes. */
export const executionLimits: z<ExecutionLimits> = z.object({
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  stopTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
  maxCommandBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32_768),
  maxOutputBytes: z.number().step(1).min(256).max(Number.MAX_SAFE_INTEGER).default(8_192),
  memoryMiB: z.number().step(1).min(6).max(1_048_576).default(256),
  pidsLimit: z.number().step(1).min(3).max(4_194_304).default(64),
})

/** Operator-configurable Host gateway that carries broker requests from a guest. */
export interface GatewaySettings {
  /** Stable absolute path to the gateway socket in a private Host directory. */
  gatewaySocket?: string
  /** Milliseconds without gateway traffic before a connection closes. */
  gatewayIdleTimeoutMs?: number
  /** Maximum simultaneous guest connections accepted by the Host gateway. */
  gatewayMaxConnections?: number
}

/** Absolute gateway socket path; a backend that always serves the gateway marks it required. */
export const gatewaySocketPath: z<string> = z.string().pattern(/^\/[^:\u0000\r\n]+$/u)

/** Default and validate the gateway settings common to both execution runtimes. `gatewaySocket` is optional here. */
export const gatewaySettings: z<GatewaySettings> = z.object({
  gatewaySocket: gatewaySocketPath,
  gatewayIdleTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  gatewayMaxConnections: z.number().step(1).min(1).max(65_535).default(64),
})

/**
 * Hash an execution identity or policy.
 * @param value - Text to hash as UTF-8.
 * @returns Lowercase SHA-256 hex digest.
 */
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Collect bounded stdout and stderr from the selected local runtime's CLI. */
export class ExecutionCli {
  /**
   * @param subprocess - Host subprocess provider.
   * @param settings - Executable and fixed flags, process limits, and setup diagnostics.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly settings: {
      argv: readonly string[]
      cwd: string
      envPrefix: 'DOCKER_' | 'CONTAINER_'
      stopTimeoutMs: number
      controlBytes: number
      setupHint: string
      failureCode: 'EXEC_DOCKER' | 'EXEC_VM'
    },
  ) {}

  /**
   * Run one CLI command with bounded stream collection.
   * @param args - CLI arguments after the configured executable and fixed flags.
   * @param signal - Cancellation for the CLI process.
   * @param maxBytes - Collection limit for each stream.
   * @param stdin - Input disposition. Omit to close stdin.
   * @param forwarded - Variables the CLI forwards to its guest by name; the runtime's own variables cannot be set.
   * @returns CLI exit facts and collected output.
   */
  async run(
    args: readonly string[],
    signal: AbortSignal,
    maxBytes: number,
    stdin: SubprocessStdinMode = 'ignore',
    forwarded: Readonly<Record<`DSH_${string}`, string>> = {},
  ): Promise<CliResult> {
    signal.throwIfAborted()
    const handle = this.spawn(args, signal, { stdin, stdout: { maxBytes }, stderr: { maxBytes } }, forwarded)
    const outcome = await handle.done
    signal.throwIfAborted()
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined) throw new Error('Execution CLI requires collected output')
    return { ...outcome, stdout, stderr }
  }

  /**
   * Start one CLI command with caller-owned stdio.
   * @param args - CLI arguments after the configured executable and fixed flags.
   * @param signal - Cancellation that terminates the CLI process.
   * @param stdio - Stream dispositions; piped streams belong to the caller.
   * @param forwarded - Variables the CLI forwards to its guest by name; the runtime's own variables cannot be set.
   * @returns The live CLI process.
   */
  spawn(
    args: readonly string[], signal: AbortSignal, stdio: SubprocessStdio, forwarded: Readonly<Record<`DSH_${string}`, string>> = {},
  ): SubprocessHandle {
    const { argv, cwd, envPrefix, stopTimeoutMs } = this.settings
    const env = {
      ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith(envPrefix)).map(key => [key, undefined])),
      ...forwarded,
    }
    return this.subprocess.spawn({ argv: [...argv, ...args], cwd, env, graceMs: stopTimeoutMs, signal, stdio })
  }

  /**
   * Run a management command that requires a complete, successful response.
   * @param args - Arguments for a runtime management command.
   * @param operation - Description of the requested operation for error reports.
   * @param signal - Cancellation for the CLI process.
   * @returns Trimmed output after a successful exit with complete stdout.
   */
  async control(args: readonly string[], operation: string, signal: AbortSignal): Promise<string> {
    const { controlBytes, setupHint, failureCode } = this.settings
    try {
      const result = await this.run(args, signal, controlBytes)
      if (result.exitCode !== 0 || result.stdout.lossy) throw new Error(result.stderr.text)
      return result.stdout.text.trim()
    } catch (cause) {
      signal.throwIfAborted()
      throw new HarnessError(`Could not ${operation}. ${setupHint}`, failureCode, { cause })
    }
  }
}

/** Exit facts and byte-limited output for one CLI invocation. */
export interface CliResult extends SubprocessOutcome {
  stdout: SubprocessOutputRead
  stderr: SubprocessOutputRead
}

/** Base of each backend executor: admits its script and file transfer calls, one call at a time per Session. */
export abstract class SessionExecutor {
  private readonly active = new Map<SessionId, Promise<unknown>>()
  private readonly lifetime = new AbortController()

  /** @param maxCommandBytes - Maximum UTF-8 script size. */
  constructor(private readonly maxCommandBytes: number) {}

  /**
   * Execute an admitted script and clean up its Session's guest.
   * @param session - Session that owns the workspace.
   * @param command - Admitted shell script.
   * @param signal - Caller and executor cancellation signal.
   * @param broker - Optional guest request handler for this call.
   * @returns Backend observation after execution and cleanup.
   */
  protected abstract execute(
    session: SessionId, command: string, signal: AbortSignal, broker?: ExecutionBroker,
  ): Promise<ExecutionObservation>

  /**
   * Transfer an admitted file and stop the Session's guest.
   * @param session - Session that owns the workspace.
   * @param request - Snapshotted import or export.
   * @param signal - Caller and executor cancellation signal.
   * @returns The transfer observation after cleanup.
   */
  protected abstract copyFile(
    session: SessionId, request: WorkspaceTransferRequest, signal: AbortSignal,
  ): Promise<WorkspaceTransferResult>

  /** Cancellation signal for backend startup and active execution. */
  protected get signal(): AbortSignal {
    return this.lifetime.signal
  }

  /**
   * Admit a script while reserving exclusive access to its Session.
   * @param session - Session that owns the workspace.
   * @param command - Shell script to admit.
   * @param signal - Caller cancellation signal.
   * @param broker - Optional guest request handler for this call.
   * @returns Backend observation after execution and cleanup.
   */
  readonly run = (
    session: SessionId,
    command: string,
    signal: AbortSignal,
    broker?: ExecutionBroker,
  ): Promise<ExecutionObservation> => {
    if (!command.trim() || command.includes('\0') || Buffer.byteLength(command) > this.maxCommandBytes) {
      throw new HarnessError('Provide a non-empty shell script within the configured byte limit.', 'EXEC_SCRIPT')
    }
    return this.exclusive(session, signal, lifetime => this.execute(session, command, lifetime, broker))
  }

  /**
   * Snapshot a transfer request and reserve the Session through confirmed stop.
   * @param session - Session that owns the workspace.
   * @param request - One import or export.
   * @param signal - Caller cancellation signal.
   * @returns The transfer observation after cleanup.
   */
  readonly transfer = (session: SessionId, request: WorkspaceTransferRequest, signal: AbortSignal): Promise<WorkspaceTransferResult> => {
    const prepared = prepareWorkspaceTransfer(request)
    return this.exclusive(session, signal, lifetime => this.copyFile(session, prepared, lifetime))
  }

  private exclusive<T>(session: SessionId, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.has(session)) throw new HarnessError('This Session already has an active execution.', 'EXEC_BUSY')
    const pending = execute(AbortSignal.any([signal, this.signal]))
      .finally(() => { this.active.delete(session) })
    this.active.set(session, pending)
    return pending
  }

  /**
   * Cancel active calls.
   * @param reason - Failure or shutdown that triggered cancellation.
   */
  protected abort(reason: Error): void {
    this.lifetime.abort(reason)
  }

  /**
   * Cancel active calls and wait for their cleanup.
   * @param preparation - Backend startup that must finish before disposing its resources.
   * @param reason - Shutdown diagnostic for active calls.
   * @returns Completion of startup and active call settlement.
   */
  protected async settle(preparation: Promise<unknown>, reason: string): Promise<void> {
    this.abort(new Error(reason))
    await Promise.allSettled([preparation, ...this.active.values()])
  }
}

/**
 * Normalize a backend failure for the operation caller.
 * @param cause - Failure observed during an admitted call.
 * @param signal - Signal for the caller and backend lifetime.
 * @param limit - Signal for the script deadline.
 * @param backend - Operator-facing runtime name.
 * @param code - Runtime failure code.
 * @param operation - Activity named in an unexpected failure diagnostic.
 * @returns The original typed error or a failure with its cause.
 */
export function executionFailure(
  cause: unknown,
  signal: AbortSignal,
  limit: AbortSignal,
  backend: 'Docker' | 'Apple container',
  code: 'EXEC_DOCKER' | 'EXEC_VM',
  operation: string,
): HarnessError {
  if (cause instanceof HarnessError) return cause
  if (timeoutOf(limit, EXEC_TIMEOUT) !== undefined) {
    return new HarnessError('Execution timed out. Inspect the workspace for partial changes before trying again.', EXEC_TIMEOUT, { cause })
  }
  if (signal.aborted) {
    return new HarnessError('Execution was cancelled. Inspect the workspace for partial changes before trying again.', 'EXEC_CANCELLED', { cause })
  }
  return new HarnessError(`Could not ${operation}. Check ${backend} and inspect the workspace for partial changes.`, code, { cause })
}

/**
 * Report a recovered interruption to the script caller.
 * @returns The failure for a prior script found interrupted and confirmed stopped.
 */
export function interruptedExecution(): HarnessError {
  return new HarnessError('A previous execution was interrupted. Its processes have stopped. Inspect the workspace before trying again.', 'EXEC_PREVIOUS_UNKNOWN')
}

function limitText(value: string, bytes: number): string {
  const encoded = Buffer.from(value)
  if (encoded.length <= bytes) return value
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded.subarray(0, bytes), { stream: true })
}

/**
 * Call after the backend confirms the workspace stopped.
 * @param result - CLI exit facts and collected output.
 * @param containerId - Opaque workspace identity for evidence.
 * @param maxOutputBytes - Complete rendered tool result budget.
 * @returns The stopped workspace observation with bounded output.
 */
export function observeStopped(result: CliResult, containerId: ContainerId, maxOutputBytes: number): ExecutionObservation {
  if (result.exitCode === null) {
    throw new HarnessError('Execution ended without an exit status. Inspect the workspace for partial changes.', 'EXEC_UNKNOWN')
  }
  const framing = renderExecutionObservation({
    exitCode: result.exitCode, stdout: '', stderr: '', stdoutTruncated: true, stderrTruncated: true,
  })
  const available = maxOutputBytes - Buffer.byteLength(framing)
  const stdout = limitText(result.stdout.text, Math.floor(available / 2))
  const stderr = limitText(result.stderr.text, Math.ceil(available / 2))
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    stdoutTruncated: result.stdout.lossy || stdout !== result.stdout.text,
    stderrTruncated: result.stderr.lossy || stderr !== result.stderr.text,
    containerId,
    stopped: true,
  }
}
