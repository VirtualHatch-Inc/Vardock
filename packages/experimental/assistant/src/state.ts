/** Durable delegation commands and result delivery receipts. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { workGrantSchema, workPermissionsSchema, type OperationId } from '@deepseek-ai/dsh-operation-control/handoff'
import type { WorkId as AuthorityWorkId } from '@deepseek-ai/dsh-operation-control/types'
import { SessionId, type SessionLogOffset } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import { availableInputSchema, inputsInEvent } from './data.ts'
import { workPhases } from './work-phase.ts'

/** Identity of one idempotent work request, including continuations. */
export type WorkId = AuthorityWorkId
/**
 * Brand a validated or locally allocated work identity.
 * @param value - work identity.
 * @returns branded identity.
 */
export const WorkId = (value: string): WorkId => brandString<WorkId>(value)

const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const workArtifactSchema = z.strictObject({
  operationId: z.uuid().transform(value => brandString<OperationId>(value)),
  path: z.string().min(1),
  name: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  digest,
  receiptDigest: digest,
})

/** An immutable artifact and the exact witnessed export that released it. */
export type WorkArtifact = Readonly<z.infer<typeof workArtifactSchema>>

/** Validated durable command; running means dispatch may have produced effects. */
export const workSchema = z.object({
  id: z.string().transform(WorkId),
  key: z.string().min(1),
  sessionId: z.string().transform(SessionId),
  previous: z.string().transform(WorkId).nullable(),
  prompt: z.string().min(1),
  cwd: z.string().nullable(),
  preset: z.string().nullable(),
  permission: z.string(),
  status: z.enum(workPhases),
  result: z.string().nullable(),
  notified: z.boolean(),
  authorization: z.strictObject({
    requestedPermissions: workPermissionsSchema.optional(),
    grant: workGrantSchema,
  }).readonly().optional(),
  inputsReady: z.literal(true).optional(),
  artifacts: z.array(workArtifactSchema).readonly().optional(),
}).strict().refine(({ id, sessionId, previous, authorization }) => {
  if (authorization === undefined) return true
  const { grant } = authorization
  return grant.workId === id && grant.sessionId === sessionId && grant.previousWorkId === previous
})
/** Authoritative command and report stored before dispatch or delivery. */
export type Work = Readonly<z.infer<typeof workSchema>>
/** Worker-reported outcomes. */
export type ReportStatus = 'completed' | 'needs_input' | 'failed'

/** One Host owns this domain; the main identity cannot change across restarts. */
export const assistantDomain = defineDomain({
  name: 'assistant', version: 3, compatibleVersions: [1, 2],
  global: { schema: z.object({ mainSessionId: z.string().transform(SessionId).nullable() }).strict(), initial: { mainSessionId: null } },
  tables: { work: domainTable<WorkId, Work>(workSchema) },
})

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A dispatch or result produced by the durable assistant coordinator. */
    'assistant-work': {
      kind: 'assistant-work'
      workId: WorkId
      direction: 'request' | 'result'
      form: 'notice'
      summary: string
      /** Witnessed artifacts on result notices, in the retained report's download order. */
      artifacts?: readonly { name: string; bytes: number; digest: string }[]
    }
  }
}

/** Result ids admitted to the main inbox; later cancellation does not redeliver them. */
export type Receipts = readonly WorkId[]
/** Host-only receipt fold survives compaction and never duplicates model-visible results. */
export const receiptProjection: ProjectionDefinition<'assistantReceipts', Receipts> = {
  key: 'assistantReceipts', stateVersion: 1,
  stateSchema: z.array(z.string().transform(WorkId)),
  init: () => [],
  apply(state, event) {
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
      : event.type === 'user/message' ? [event.data] : []
    const ids = messages.flatMap(message => message.source.kind === 'assistant-work' && message.source.direction === 'result'
      ? [message.source.workId] : [])
    const added = ids.filter(id => !state.includes(id))
    return added.length === 0 ? state : [...state, ...added]
  },
}

const workExecutionSchema = z.strictObject({
  workId: z.string().transform(WorkId).nullable(),
  calls: z.array(z.string().transform(value => brandString<ToolCallId>(value))).readonly(),
  executed: z.boolean(),
})

/** Execution results observed for the current work request, independent of compacted model history. */
export type WorkExecution = z.infer<typeof workExecutionSchema>

/** Observe nonerror exec results within one work request, without verifying file use or reported values. */
export const workExecutionProjection: ProjectionDefinition<'assistantWorkExecution', WorkExecution> = {
  key: 'assistantWorkExecution', stateVersion: 1, stateSchema: workExecutionSchema,
  init: () => ({ workId: null, calls: [], executed: false }),
  apply(state, event) {
    if (event.type === 'user/message' && event.data.source.kind === 'assistant-work'
      && event.data.source.direction === 'request' && event.data.source.workId !== state.workId) {
      return { workId: event.data.source.workId, calls: [], executed: false }
    }
    if (state.workId === null || state.executed) return state
    if (event.type === 'tool/call' && event.data.name === 'exec') {
      return { ...state, calls: [...state.calls, event.data.callId] }
    }
    if (event.type === 'tool/result' && state.calls.includes(event.data.message.toolCallId)) {
      return { ...state, calls: state.calls.filter(id => id !== event.data.message.toolCallId),
        executed: event.data.message.isError !== true }
    }
    return state
  },
}

const availableInputStateSchema = z.strictObject({
  ownFrom: z.number().int().nonnegative().nullable(),
  inputs: z.array(availableInputSchema).readonly(),
  // Null until the first step identifies its triggering owner request.
  turnInputs: z.array(availableInputSchema).readonly().nullable(),
})

/** Discoverable attachments and the owner attachments that triggered the current entrance turn. */
export type AvailableInputState = Readonly<z.infer<typeof availableInputStateSchema>>

/**
 * Index one message's attachment metadata for discovery without scanning history.
 * @param entrance - configured owner conversation.
 * @returns a Host-only projection scoped to the entrance's own messages.
 */
export function workInputProjection(entrance: SessionId): ProjectionDefinition<'assistantInputs', AvailableInputState> {
  return {
    key: 'assistantInputs', stateVersion: 2,
    stateSchema: availableInputStateSchema,
    init: (header, inheritedEventCount: SessionLogOffset) => ({
      ownFrom: header.id === entrance ? inheritedEventCount : null, inputs: [], turnInputs: [],
    }),
    apply(state, event) {
      if (state.ownFrom === null || event.seq < state.ownFrom) return state
      if (event.type === 'turn/start') return { ...state, turnInputs: null }
      if (event.type === 'turn/end' || (event.type === 'step/end' && state.turnInputs === null)) return { ...state, turnInputs: [] }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user' || 'principal' in event.data.source) return state
      const inputs = inputsInEvent(event)
      return { ...state, inputs: inputs.length === 0 ? state.inputs : inputs, turnInputs: state.turnInputs ?? inputs }
    },
  }
}
