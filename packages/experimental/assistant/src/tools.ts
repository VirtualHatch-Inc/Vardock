/** Model tools use the same durable coordinator as Host callers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolActivationContext } from '@deepseek-ai/dsh-tools'
import type { AssistantRuntime } from './index.ts'
import { WorkId, type Work } from './state.ts'

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('Assistant tools require an Agent')
  return agent
}

const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function workSummary({ authorization, artifacts, inputsReady: _inputsReady, ...work }: Work) {
  return {
    ...work,
    principalId: authorization?.grant.principalId ?? null,
    permissions: authorization?.grant.permissions ?? null,
    ...(artifacts === undefined ? {} : { artifacts: artifacts.map(({ name, bytes, digest }) => ({ name, bytes, digest })) }),
  }
}

/**
 * Register delegation tools with Session-specific admission.
 * @param ctx - registration owner.
 * @param runtime - durable work operations and main Session identity.
 */
export function registerTools(
  ctx: Context,
  runtime: Pick<AssistantRuntime, 'mainSessionId' | 'delegate' | 'assertMain' | 'retry' | 'list' | 'listInputs' | 'stop' | 'report' | 'disclosableWork'>,
): void {
  const summary = async (work: Work, signal: AbortSignal) => workSummary(await runtime.disclosableWork(work, signal))
  const main = { when: ({ agent }: ToolActivationContext) => agent.id === runtime.mainSessionId }
  ctx.tools.register(defineTool({
    name: 'list_work_inputs',
    description: 'List attachments in the most recent owner message that included files or images. Use their seq and index to select inputs for new work.',
    output: textOutput,
    parameters: {},
    execute(_args, exec) {
      return Promise.resolve(JSON.stringify(runtime.listInputs(requireAgent(exec.agent))))
    },
  }), main)
  ctx.tools.register(defineTool({
    name: 'delegate_work',
    description: 'Delegate independent work to a background Session and return immediately. Results return to this conversation. Use previous_work_id to explicitly continue a finished or interrupted worker after inspecting its results. Do not automatically repeat uncertain external operations.',
    output: textOutput,
    parameters: {
      request_key: { type: 'string', required: true, description: 'Use a new key for every continuation or changed instruction, permission, or input. Reuse a key only to retrieve the same request with every argument unchanged; that does not run it again.' },
      prompt: { type: 'string', required: true, description: 'Self-contained instruction and relevant context for the worker. Selected attachments are imported under input/ in its isolated workspace; the worker receives their paths. Do not give Host paths as worker paths.' },
      previous_work_id: { type: 'string', description: 'Previous terminal work request whose Session and files should continue with the current prompt. This creates a distinct work request; its earlier operations remain history.' },
      inputs: {
        type: 'array',
        description: 'For fresh work, required when the owner request that triggered this entrance turn has attachments. Select their seq and index from list_work_inputs; pass [] when this work needs no files. Omission is allowed without attachments. A continuation inherits its existing files.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            seq: { type: 'integer', required: true, description: 'Sequence of the owner message.' },
            index: { type: 'integer', required: true, description: 'Zero-based attachment position in the message content.' },
          },
        },
      },
      permissions: {
        type: 'object', additionalProperties: false,
        description: 'Permissions the worker needs, and no more. Required for new work. With previous_work_id, omit to keep the previous permissions or pass a narrower set. To add a missing permission, start fresh work without previous_work_id.',
        properties: {
          exec: { type: 'boolean', required: true, description: 'Enable for running any script, reading or processing workspace files, calculating results from files, writing reports, or calling external actions. File import/export permissions do not enable execution.' },
          brokerActions: { type: 'array', items: { type: 'string' }, required: true, description: 'Exact names from list_business_actions of the external actions the worker may request from a command. Use an empty list when exec is false.' },
          data: {
            type: 'object', additionalProperties: false, description: 'File and service-response permissions for this work. Omit to grant none.',
            properties: {
              import: { type: 'boolean', required: true, description: 'Enable to copy selected owner attachments into the workspace; reading them also needs exec and both disclosure permissions.' },
              export: { type: 'boolean', required: true, description: 'Enable to return workspace files as owner downloads; creating them also needs exec and both disclosure permissions.' },
              discloseToModel: { type: 'boolean', required: true, description: 'Whether imported or exported file data may reach a model through work results.' },
              discloseToUser: { type: 'boolean', required: true, description: 'Whether imported or exported file data may reach the owner through work history or downloads.' },
              returnResponses: { type: 'boolean', required: true, description: 'Whether the worker’s commands may receive the response text of an external action, which then reaches the worker model. Without it, the worker sees only the status.' },
            },
          },
        },
      },
    },
    async execute(args, exec) {
      const previous = args.previous_work_id === undefined ? null : WorkId(args.previous_work_id)
      const work = await runtime.delegate(
        requireAgent(exec.agent), args.request_key, args.prompt, previous, exec.signal, args.permissions, args.inputs,
      )
      return JSON.stringify(await summary(work, exec.signal))
    },
  }), main)
  ctx.tools.register(defineTool({
    name: 'list_work', description: 'List work states, worker Session ids, granted permissions, and saved results. Also retry pending queue and result delivery after a repaired Host error. A running state is not proof of completion; unknown requires inspection before continuation.',
    output: textOutput,
    parameters: {},
    async execute(_args, exec) {
      runtime.assertMain(requireAgent(exec.agent))
      runtime.retry()
      return JSON.stringify(await Promise.all(runtime.list().map(work => summary(work, exec.signal))))
    },
  }), main)
  ctx.tools.register(defineTool({
    name: 'stop_work', description: 'Stop queued or running work. Effects already performed are not undone.',
    output: textOutput,
    parameters: { work_id: { type: 'string', required: true, description: 'Request id returned by delegate_work.' } },
    async execute(args, exec) {
      return JSON.stringify(await summary(await runtime.stop(requireAgent(exec.agent), WorkId(args.work_id)), exec.signal))
    },
  }), main)
  ctx.tools.register(defineTool({
    name: 'report_work', description: 'Persist this worker request outcome and end its turn. Imported-file work cannot be reported complete unless a nonerror exec result was observed in this work; that does not verify file use or reported values. Base computed values and file contents on execution output, never a filename or path. If a needed permission or tool is missing, use failed, name it, and give no invented result. Use needs_input for a question or required decision. Include evidence and any partial effects. The main assistant receives this report.',
    output: textOutput,
    parameters: {
      status: { type: 'string', enum: ['completed', 'needs_input', 'failed'], required: true, description: 'Explicit outcome.' },
      result: { type: 'string', required: true, description: 'Result with evidence, or a precise question or failure.' },
      artifacts: {
        type: 'array', items: { type: 'string' },
        description: 'Paths relative to the worker workspace of the files the owner asked to receive. Each file uses one execution slot; put evidence in result instead of attaching it.',
      },
    },
    async execute(args, exec) {
      const report = await runtime.report(requireAgent(exec.agent), args.status, args.result, args.artifacts, exec.signal)
      exec.concludeTurn()
      return JSON.stringify({ work_id: report.id, status: report.status })
    },
  }), { when: ({ agent }) => runtime.list().some(work => work.sessionId === agent.id && work.status === 'running') })
}
