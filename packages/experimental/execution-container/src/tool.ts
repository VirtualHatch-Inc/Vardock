/** Model schema and terminal presentation for isolated Session execution. */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ExecutionObservation } from './service.ts'

/** The tool's working directory in its container. */
export const EXEC_WORKSPACE = '/workspace'

/**
 * Format captured command output for the terminal tool result.
 * @param observation - observed exit code, output streams, and truncation flags.
 * @returns Exit status and the two output streams with truncation markers.
 */
export function renderExecutionObservation(
  observation: Omit<ExecutionObservation, 'containerId' | 'stopped'>,
): string {
  const { exitCode, stdout, stderr, stdoutTruncated, stderrTruncated } = observation
  return `Exit status: ${exitCode}\n\nstdout${stdoutTruncated ? ' (truncated)' : ''}:\n${stdout}\nstderr${stderrTruncated ? ' (truncated)' : ''}:\n${stderr}`
}

/**
 * Build the isolated execution tool definition.
 * @param run - execution for the calling Session and caller's cancellation signal.
 * @returns A definition ready for tool registration.
 */
export function createExecTool(run: (session: SessionId, command: string, signal: AbortSignal) => Promise<string>): ToolDefinition {
  return defineTool({
    name: 'exec',
    description: 'Run a shell script in this work Session’s isolated /workspace. The supplied Linux work image provides POSIX /bin/sh and Node.js 24 with built-in fetch and standard Linux utilities. Python and curl are not installed. Use POSIX shell syntax; after a heredoc terminator, put the next command on a new line without a leading semicolon. This is an external execution service: /workspace is writable. The model provider’s native filesystem sandbox does not apply to this tool. Files persist across calls and explicit continuations. The workspace has no direct network access or Host files. A configured gateway can allow selected network destinations. When DSH_BROKER_URL is set, submit external operations there with Node.js fetch as POST JSON {requestKey, action, body}, using a UUID requestKey, an operator-configured action, exact JSON text in body, and Authorization: Bearer from DSH_BROKER_TOKEN. Keep that token private. Scripts may run automatically under the operator’s policy. External requests wait for owner approval unless a configured rule admits them. Check the JSON response: status is the observed HTTP status, or toolError says whether a tool call’s result was marked as an error; code indicates a failure; body is the service’s response text when the action returns one and this work may receive it, and bodyOmitted says why it is missing; not-permitted means the request was sent but this work may not receive the response. The response includes an operation ID for inspection. An HTTP response does not verify business completion. When an operation’s outcome is uncertain, for example when its response is missing, report the uncertain outcome with its operation ID and do not submit the same request again. Each call stops its processes before returning. Inspect the workspace before retrying an interrupted command.',
    parameters: {
      command: { type: 'string', required: true, description: 'POSIX shell script to run from /workspace.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: ({ command }) => ({ card: 'terminal', title: command, cwd: EXEC_WORKSPACE }),
    execute({ command }, exec) {
      if (exec.agent === undefined) throw new HarnessError('Isolated execution requires a Session.', 'EXEC_NO_SESSION')
      return run(exec.agent.id, command, exec.signal)
    },
  })
}
