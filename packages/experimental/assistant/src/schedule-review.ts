/** Owner decision on each scheduled task change the entrance requests. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ScheduleId, type ScheduleCatalogEntry, type ScheduleService } from '@deepseek-ai/dsh-schedule'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { approvalValue } from './approval-value.ts'

/** Schedule tools whose calls create, change, or delete a task. */
export const SCHEDULE_CHANGE_TOOLS: readonly string[] = ['schedule_create', 'schedule_edit']

function recurrence(task: ScheduleCatalogEntry): string {
  return task.kind === 'rrule' ? approvalValue(task.rrule) : `${task.kind}, next at ${task.scheduledAt}`
}

/**
 * Ask the owner to decide on the exact task content of one entrance call.
 * @param approval - Approval service that presents the question in the entrance.
 * @param schedule - Schedule service that supplies the stored task of an edit.
 * @param agent - Entrance Agent that issued the call.
 * @param execution - Frozen call whose arguments the tool receives unchanged.
 * @returns `allow` only after `allowed-once`; otherwise a denial the model reads as the tool error.
 */
export async function reviewScheduleChange(
  approval: ApprovalService, schedule: ScheduleService, agent: Agent, execution: ToolExecution,
): Promise<PreToolDecision> {
  const args: Record<string, unknown> = typeof execution.arguments === 'object' && execution.arguments !== null
    ? { ...execution.arguments } : {}
  let question: { en: string; zh: string }
  let detail: string
  if (execution.name === 'schedule_create') {
    question = { en: `Create the scheduled task ${approvalValue(args.title)}?`, zh: `创建定时任务 ${approvalValue(args.title)}？` }
    detail = `Title: ${approvalValue(args.title)}\nRecurrence: ${approvalValue(args.rrule)}\nPrompt: ${approvalValue(args.prompt)}`
  } else {
    const id = String(args.id)
    const task = await schedule.view({ id: ScheduleId(id), targetSessionId: agent.id })
    if (!('kind' in task)) {
      return { kind: 'deny', reason: `Scheduled task ${id} was not found.` }
    }
    // The tool checks this revision when it writes, so the approved change applies only to the task shown on the card.
    if (task.updatedAt === undefined || args.expectedUpdatedAt !== task.updatedAt) {
      return { kind: 'deny', reason: 'Changing a scheduled task requires expectedUpdatedAt equal to the updatedAt that schedule_view returns now.' }
    }
    const current = `Task: ${approvalValue(task.title)} (${task.id}, ${task.status})\nRecurrence: ${recurrence(task)}\nPrompt: ${approvalValue(task.prompt)}`
    if (args.action === 'delete') {
      question = { en: `Delete the scheduled task ${approvalValue(task.title)}?`, zh: `删除定时任务 ${approvalValue(task.title)}？` }
      detail = current
    } else {
      question = { en: `Change the scheduled task ${approvalValue(task.title)}?`, zh: `修改定时任务 ${approvalValue(task.title)}？` }
      const changes = [
        ...(args.title === undefined ? [] : [`Title: ${approvalValue(args.title)}`]),
        ...(args.rrule === undefined ? [] : [`Recurrence: ${approvalValue(args.rrule)}`]),
        ...(args.target === undefined ? [] : [`Target: ${approvalValue(args.target)}`]),
        ...(args.active === undefined ? [] : [args.active === true ? 'Status: resume' : 'Status: pause']),
        ...(args.prompt === undefined ? [] : [`Prompt: ${approvalValue(args.prompt)}`]),
      ]
      detail = `Changes:\n${changes.join('\n')}\n\nCurrent:\n${current}`
    }
  }
  const outcome = await approval.request({
    agent, toolName: execution.name, callId: execution.callId, signal: execution.signal,
    reason: `${question.en}\n${detail}`, displayReason: question, detail,
  })
  if (outcome === 'allowed-once') return { kind: 'allow' }
  return { kind: 'deny', reason: outcome === 'rejected'
    ? 'The owner declined this scheduled task change. Nothing changed.'
    : 'The owner did not decide on this scheduled task change. Nothing changed.' }
}
