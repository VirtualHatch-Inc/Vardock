/** Unix HTTP request and response validation for the operation authority. */
import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContainerId, ExecutionObservation } from '@deepseek-ai/dsh-execution-container'
import { isWorkspaceTransferPath, MAX_WORKSPACE_TRANSFER_BYTES } from '@deepseek-ai/dsh-execution-container/library'
import type { BrokerReceiptId, PreparedBrokerRequest } from '@deepseek-ai/dsh-operation-broker'
import { isBrokerReceiptId } from '@deepseek-ai/dsh-operation-broker/library'
import type { EvidenceEvent } from '@deepseek-ai/dsh-operation-evidence'
import { digestEvidenceEvent } from '@deepseek-ai/dsh-operation-evidence/library'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { OperationId, WorkId } from './ids.ts'
import { modelObservationSchema, modelRequestSchema } from './model-protocol.ts'

export type { OperationId, WorkId } from './ids.ts'

/** Operator-assigned identity bound to the authority socket and database. */
export type WorkPrincipalId = Branded<'OperationPrincipalId'>

/**
 * Brand an operator-assigned principal identity.
 * @param value - A validated authority principal identity.
 * @returns The branded identity.
 */
export const WorkPrincipalId = (value: string): WorkPrincipalId => brandString<WorkPrincipalId>(value)

/** Identity of one durably recorded read-only lookup. */
export type ReconciliationAttemptId = Branded<'ReconciliationAttemptId'>

/** Maximum encoded request bytes on the wire. */
export const MAX_REQUEST_BYTES = 256 * 1024
/** Portable filesystem Unix socket pathname limit. */
export const MAX_SOCKET_PATH_BYTES = 103
/** Maximum encoded response bytes on the wire. */
export const MAX_RESPONSE_BYTES = 1024 * 1024
/** Largest configured workspace file that one operation can transfer. */
export const MAX_FILE_TRANSFER_BYTES = MAX_WORKSPACE_TRANSFER_BYTES
/** Default per-file limit for authorities offering workspace transfers. */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
/** Encoded request and reply cap for the dedicated file endpoints. */
export const MAX_FILE_WIRE_BYTES = 4 * Math.ceil(MAX_FILE_TRANSFER_BYTES / 3) + 8192
/** Maximum number of owner files granted to one work request. */
export const MAX_WORK_INPUTS = 8
/** Leave room for operation metadata around the encoded model stream. */
export const MAX_MODEL_RESPONSE_BYTES = MAX_RESPONSE_BYTES - 4096
/** Maximum number of recent business operations returned per Session. */
export const MAX_BUSINESS_OPERATIONS = 100

/** Validate authority-issued operation identities. */
export const operationIdSchema = z.uuid().transform(value => brandString<OperationId>(value))
/** Validate authority-issued reconciliation attempt identities. */
export const reconciliationAttemptIdSchema = z.uuid().transform(value => brandString<ReconciliationAttemptId>(value))
/** Validate operator-assigned and witness identities. */
export const identitySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u)
/** Validate the identity of the socket principal. */
export const workPrincipalIdSchema = identitySchema.transform(WorkPrincipalId)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const actionSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u)
/** Validate Assistant work identities derived from stable request keys. */
export const workIdSchema = digestSchema.transform(value => brandString<WorkId>(value))
/** Validate operation Session identities. */
export const sessionIdSchema = z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/u).transform(SessionId)
const dataPermissionsSchema = z.strictObject({
  import: z.boolean(), export: z.boolean(), discloseToModel: z.boolean(), discloseToUser: z.boolean(),
  /** Whether business response text may be returned to the work's scripts. Absence withholds it. */
  returnResponses: z.boolean().exactOptional(),
}).readonly()
/** Validate the exact capabilities eligible for use by delegated work. */
export const workPermissionsSchema = z.strictObject({
  exec: z.boolean(),
  brokerActions: z.array(actionSchema).refine(actions => new Set(actions).size === actions.length).readonly(),
  data: dataPermissionsSchema.optional(),
}).refine(({ exec, brokerActions }) => exec || brokerActions.length === 0).readonly()

/** Shell permission and the exact broker actions allowed from its execution. */
export type WorkPermissions = z.infer<typeof workPermissionsSchema>

const fileSizeSchema = z.number().int().min(0).max(MAX_FILE_TRANSFER_BYTES)
/** Validate a file occurrence bound to one owner message and exact content digest. */
export const workInputFileSchema = z.strictObject({
  attachmentId: digestSchema,
  name: z.string().min(1).max(256).refine(value => value.isWellFormed() && !/[\x00-\x1f\x7f]/u.test(value)),
  bytes: fileSizeSchema,
  messageSeq: z.number().int().min(0),
  contentIndex: z.number().int().min(0),
}).readonly()

/** Content digest and original occurrence of a file from the owner entrance. */
export type WorkInputFile = z.infer<typeof workInputFileSchema>

const workInputsSchema = z.array(workInputFileSchema).max(MAX_WORK_INPUTS).refine(inputs =>
  new Set(inputs.map(({ messageSeq, contentIndex }) => `${messageSeq}/${contentIndex}`)).size === inputs.length &&
  new Set(inputs.map(workInputPath)).size === inputs.length).readonly()

const workDelegationSchema = z.strictObject({
  workId: workIdSchema,
  previousWorkId: workIdSchema.nullable(),
  permissions: workPermissionsSchema.optional(),
  inputs: workInputsSchema.optional(),
}).readonly()

/**
 * A work request and its predecessor. Fresh work states its permissions; a continuation that omits them keeps its
 * predecessor's grant within the current ceiling.
 */
export type WorkDelegation = z.infer<typeof workDelegationSchema>

/** Validate the retained work assignment and granted permissions. */
export const workGrantSchema = z.strictObject({
  workId: workIdSchema,
  principalId: workPrincipalIdSchema,
  sessionId: sessionIdSchema,
  previousWorkId: workIdSchema.nullable(),
  permissions: workPermissionsSchema,
  inputs: workInputsSchema.optional(),
}).readonly()

/** The authority's immutable grant for one work request in its assigned Session. */
export type WorkGrant = z.infer<typeof workGrantSchema>
const proposalFields = {
  requestKey: z.uuid(),
  sessionId: sessionIdSchema,
}
const commandSchema = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0') && value.isWellFormed())
const commandProposalSchema = z.strictObject({
  ...proposalFields,
  command: commandSchema,
})
const modelProposalSchema = z.strictObject({ ...proposalFields, modelRequest: modelRequestSchema })
const handoffKindSchema = z.enum(['delegation', 'delivery'])
const handoffProposalSchema = z.strictObject({
  sessionId: sessionIdSchema,
  requestKey: digestSchema,
  handoff: z.strictObject({
    kind: handoffKindSchema,
    targetSessionId: sessionIdSchema,
    content: z.string().min(1).refine(value => value.isWellFormed() && Buffer.byteLength(value) <= MAX_REQUEST_BYTES),
    delegation: workDelegationSchema.optional(),
  }),
})

/** A Host request to release an exact Session-to-Session payload. */
export type HandoffProposal = z.infer<typeof handoffProposalSchema>

const filePathSchema = z.string().refine(isWorkspaceTransferPath)
const fileContentSchema = z.string().max(4 * Math.ceil(MAX_FILE_TRANSFER_BYTES / 3)).refine((value) => {
  const bytes = Buffer.from(value, 'base64')
  return bytes.length <= MAX_FILE_TRANSFER_BYTES && bytes.toString('base64') === value
})

/**
 * Derive the workspace path for one authorized attachment.
 * @param source - Exact file occurrence granted to this work.
 * @returns Safe workspace-relative path under the input directory.
 */
export function workInputPath(source: WorkInputFile): string {
  const name = source.name.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^[.-]+/u, '').slice(0, 96)
  return `input/${source.attachmentId}/${name || 'file'}`
}

/**
 * Compare canonical Base64 data to its declared size and digest.
 * @param contentBase64 - Validated encoded bytes.
 * @param bytes - Expected decoded size.
 * @param digest - Expected lowercase SHA-256 digest.
 * @returns Whether the bytes match the declaration.
 */
export function fileContentMatches(contentBase64: string, bytes: number, digest: string): boolean {
  const content = Buffer.from(contentBase64, 'base64')
  return content.length === bytes && createHash('sha256').update(content).digest('hex') === digest
}

/** Validate a transfer between the owner and the assigned workspace. */
export const fileProposalSchema = z.strictObject({
  requestKey: digestSchema,
  sessionId: sessionIdSchema,
  file: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('import'), workId: workIdSchema, source: workInputFileSchema, contentBase64: fileContentSchema,
    }),
    z.strictObject({ kind: z.literal('export'), workId: workIdSchema, path: filePathSchema, targetSessionId: sessionIdSchema }),
  ]),
}).refine(({ file }) => file.kind === 'export' || fileContentMatches(file.contentBase64, file.source.bytes, file.source.attachmentId))

/** Exact workspace transfer tied to the active work and a stable request key. */
export type FileProposal = z.infer<typeof fileProposalSchema>

const businessBodySchema = z.string().min(1).refine(value => value.isWellFormed() && Buffer.byteLength(value) <= MAX_REQUEST_BYTES)

/** Validate the fields a guest may submit under its active execution capability. */
export const guestBusinessRequestSchema = z.strictObject({ requestKey: z.uuid(), action: actionSchema, body: businessBodySchema })

const businessSchema = z.strictObject({
  parentId: operationIdSchema,
  action: actionSchema.transform(value => brandString<PreparedBrokerRequest['action']>(value)),
  method: z.literal('POST'),
  endpoint: z.url({ protocol: /^https$/u }),
  tool: z.string().min(1).max(256).exactOptional(),
  reconciliationEndpoint: z.url({ protocol: /^https$/u }).optional(),
  credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).transform(value => brandString<PreparedBrokerRequest['credentialRef']>(value)),
  body: businessBodySchema,
}).transform(({ reconciliationEndpoint, ...business }): PreparedBrokerRequest & { parentId: OperationId } =>
  reconciliationEndpoint === undefined ? business : { ...business, reconciliationEndpoint })
const businessProposalSchema = z.strictObject({ ...proposalFields, business: businessSchema })

/** One business request resolved by the authority and bound to a running shell operation. */
export type BusinessProposal = z.infer<typeof businessProposalSchema>

/** Validate a complete agent proposal before budget admission. */
export const proposalSchema = z.union([
  commandProposalSchema, modelProposalSchema, handoffProposalSchema, businessProposalSchema, fileProposalSchema,
])

/** An agent host's proposal, keyed before sending for safe recovery after transport loss. */
export type OperationProposal = z.infer<typeof proposalSchema>

const reviewBinding = { revision: digestSchema, payloadDigest: digestSchema }
const reviewFields = {
  sessionId: sessionIdSchema, ...reviewBinding,
  workId: workIdSchema.optional(), principalId: workPrincipalIdSchema.optional(),
}
const approvalReviewSchema = z.union([
  z.strictObject({ ...reviewFields, command: commandSchema }),
  z.strictObject({
    ...reviewFields, business: businessSchema,
    presentation: z.strictObject({
      title: z.object({ en: z.string().min(1) }).catchall(z.string().min(1)),
      detail: z.string().min(1).max(MAX_REQUEST_BYTES),
    }).optional(),
    /** Earlier business request to this action whose outcome is unresolved, recorded when this request was reserved. */
    repeats: operationIdSchema.optional(),
  }),
])

/** Exact stored script or resolved business request presented for one human decision. */
export type OperationApprovalReview = z.infer<typeof approvalReviewSchema>

/**
 * Bind a business request to the parent execution, resolved route, and exact JSON text.
 * @param business - Authority-prepared request and parent operation identity.
 * @returns SHA-256 digest used for review, deduplication, and admission.
 */
export function businessPayloadDigest(business: BusinessProposal['business']): string {
  const { parentId, action, method, endpoint, credentialRef, body, reconciliationEndpoint, tool } = business
  const fields = [parentId, action, method, endpoint, credentialRef, body]
  // A tool request always has eight fields, so a status endpoint and a tool name cannot be confused.
  if (tool !== undefined) fields.push(reconciliationEndpoint ?? '', tool)
  else if (reconciliationEndpoint !== undefined) fields.push(reconciliationEndpoint)
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

/** Validate a decision submitted through the privileged approval socket. */
export const approvalDecisionSchema = z.strictObject({
  id: operationIdSchema,
  ...reviewBinding,
  decision: z.enum(['approve', 'deny']),
})

/** One human decision bound to the operation and grant revision shown for review. */
export type OperationApprovalDecision = z.infer<typeof approvalDecisionSchema>

const observationSchema = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<ContainerId>(value)),
  stopped: z.literal(true),
}) satisfies z.ZodType<ExecutionObservation>

const handoffOutcomeSchema = z.strictObject({
  kind: z.literal('released'),
  handoffKind: handoffKindSchema,
  targetSessionId: sessionIdSchema,
  contentDigest: digestSchema,
  work: workGrantSchema.optional(),
})

/** The authority's durable release of the exact handoff payload. */
export type HandoffOutcome = z.infer<typeof handoffOutcomeSchema>

const responseOmittedSchema = z.enum(['too-large', 'not-utf8', 'contains-credential', 'unavailable', 'not-permitted'])
/** Why a returned business response carries no text. */
export type ResponseOmitted = z.infer<typeof responseOmittedSchema>

const businessResponseSchema = z.strictObject({
  kind: z.literal('business-response'),
  /** Final HTTP status of an HTTPS request. */
  statusCode: z.number().int().min(100).max(599).exactOptional(),
  /** Whether the server marked a tool call's result as an error. Present instead of `statusCode` for a tool request. */
  toolError: z.boolean().exactOptional(),
  /** SHA-256 of the UTF-8 response text handed to the requesting script. The text itself is not retained. */
  responseDigest: digestSchema.optional(),
  /** Why a route that returns its response handed over no text; `not-permitted` when the work grant lacks `returnResponses`. */
  responseOmitted: responseOmittedSchema.optional(),
}).refine(outcome => (outcome.statusCode === undefined) !== (outcome.toolError === undefined))
/**
 * Serialize a business response outcome in the witness's JSON format.
 * @param outcome - Observed status or tool error flag and, for a returned response, its digest or the reason it was withheld.
 * @returns The same fields without undefined values.
 */
export function businessResponseEvidence(
  { kind, statusCode, toolError, responseDigest, responseOmitted }: z.infer<typeof businessResponseSchema>,
) {
  return {
    kind,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(toolError === undefined ? {} : { toolError }),
    ...(responseDigest === undefined ? {} : { responseDigest }),
    ...(responseOmitted === undefined ? {} : { responseOmitted }),
  }
}

const businessNotSentSchema = z.strictObject({ kind: z.literal('business-not-sent'), code: z.string().min(1) })
const unknownOutcomeSchema = z.strictObject({ kind: z.literal('unknown'), code: z.string().min(1) })
const fileOutcomeFields = { workId: workIdSchema, path: filePathSchema, digest: digestSchema, bytes: fileSizeSchema }
const fileImportedOutcomeSchema = z.strictObject({ kind: z.literal('file-imported'), ...fileOutcomeFields, source: workInputFileSchema })
const fileExportedOutcomeSchema = z.strictObject({ kind: z.literal('file-exported'), ...fileOutcomeFields, targetSessionId: sessionIdSchema })
const retainedFileExportSchema = fileExportedOutcomeSchema.extend({ contentBase64: fileContentSchema })
  .refine(({ contentBase64, bytes, digest }) => fileContentMatches(contentBase64, bytes, digest))

/** Witnessed transfer metadata. File bytes have a separate read endpoint. */
export type FileOutcome = z.infer<typeof fileImportedOutcomeSchema | typeof fileExportedOutcomeSchema>

/** Validate retained observations before transport or recovery. */
export const outcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exited'), observation: observationSchema }),
  z.strictObject({ kind: z.literal('model-response'), chunks: modelObservationSchema }),
  businessResponseSchema,
  businessNotSentSchema,
  handoffOutcomeSchema,
  fileImportedOutcomeSchema,
  fileExportedOutcomeSchema,
  unknownOutcomeSchema,
])

/** Decode authority-private outcomes, including a retained export snapshot. */
export const retainedOutcomeSchema = z.union([outcomeSchema, retainedFileExportSchema])

/** Recorded outcomes before projection to the operation status response. */
export type RetainedOperationOutcome = z.infer<typeof retainedOutcomeSchema>

/** Observation or release retained before witness acknowledgment. */
export type OperationOutcome = z.infer<typeof outcomeSchema>

/** Validate a witness receipt. */
export const receiptSchema = z.strictObject({
  id: identitySchema,
  digest: digestSchema,
})

/** Receipt and metadata for one completed workspace transfer. */
export interface FileTransferReceipt {
  readonly operationId: OperationId
  readonly outcome: FileOutcome
  readonly receipt: z.infer<typeof receiptSchema>
}

/** Validate a read of an exported snapshot after its witness acknowledgment. */
export const exportedFileSchema = z.strictObject({
  operationId: operationIdSchema,
  outcome: fileExportedOutcomeSchema,
  receipt: receiptSchema,
  contentBase64: fileContentSchema,
}).refine(({ operationId, outcome, receipt, contentBase64 }) => receipt.id === `${operationId}-outcome` &&
  receipt.digest === fileReceiptDigest(operationId, outcome) && fileContentMatches(contentBase64, outcome.bytes, outcome.digest))

/** Exported file with independently acknowledged metadata and verified snapshot bytes. */
export type ExportedFile = z.infer<typeof exportedFileSchema>

/**
 * Compute the expected independent receipt for a transfer without sending bytes to the witness.
 * @param id - The authority operation identity.
 * @param outcome - Exact transfer metadata.
 * @returns Canonical outcome event digest.
 */
export function fileReceiptDigest(id: OperationId, outcome: FileOutcome): string {
  return digestEvidenceEvent({ id: `${id}-outcome`, operationId: id, kind: 'outcome', body: fileOutcomeMetadata(outcome) })
}

/**
 * Project a file outcome to metadata safe for operation status and evidence.
 * @param outcome - Recorded transfer outcome.
 * @returns Transfer metadata without any snapshot bytes.
 */
export function fileOutcomeMetadata(outcome: FileOutcome | z.infer<typeof retainedFileExportSchema>): FileOutcome {
  if ('contentBase64' in outcome) {
    const { contentBase64: _content, ...metadata } = outcome
    return metadata
  }
  return outcome
}

/**
 * Bind a release to its handoff target, kind, and exact UTF-8 payload.
 * @param handoff - The stored handoff payload.
 * @param work - Resolved grant for a delegation. Omit for delivery or a historical release without a grant.
 * @returns The release fact persisted by the authority and attested by the witness.
 */
export function handoffOutcome(handoff: HandoffProposal['handoff'], work?: WorkGrant): HandoffOutcome {
  return {
    kind: 'released',
    handoffKind: handoff.kind,
    targetSessionId: handoff.targetSessionId,
    contentDigest: createHash('sha256').update(handoff.content).digest('hex'),
    ...(work === undefined ? {} : { work }),
  }
}

/**
 * Derive the witness receipt digest for a handoff release.
 * @param id - Authority operation identity.
 * @param outcome - Exact release fact.
 * @returns The expected canonical outcome event digest.
 */
export function handoffReceiptDigest(id: OperationId, outcome: HandoffOutcome): string {
  return digestEvidenceEvent({ id: `${id}-outcome`, operationId: id, kind: 'outcome', body: handoffEvidenceBody(outcome) })
}

/**
 * Encode the release and its immutable grant in the witness's JSON format.
 * @param outcome - Exact release fact.
 * @returns The witness event body.
 */
export function handoffEvidenceBody({ work, ...outcome }: HandoffOutcome): EvidenceEvent['body'] {
  if (work === undefined) return outcome
  const { inputs, permissions, ...assignment } = work
  return {
    ...outcome, work: {
      ...assignment, permissions: workPermissionsEvidence(permissions),
      ...(inputs === undefined ? {} : { inputs: [...inputs] }),
    },
  }
}

/**
 * Serialize a work grant's permissions in the witness's JSON format.
 * @param permissions - The immutable permissions recorded by the authority.
 * @returns The exact shell, broker, and data permissions without undefined values.
 */
export function workPermissionsEvidence({ exec, brokerActions, data }: WorkPermissions) {
  return { exec, brokerActions: [...brokerActions], ...(data === undefined ? {} : { data }) }
}

/** Validate a durable operation phase. */
export const stateSchema = z.enum([
  'pending-approval', 'pending-evidence', 'issued', 'running', 'unknown', 'pending-outcome-evidence', 'settled', 'canceled',
])

/** Validate an authority status response. */
export const statusSchema = z.strictObject({
  id: operationIdSchema,
  state: stateSchema,
  review: approvalReviewSchema.optional(),
  admission: receiptSchema.optional(),
  outcome: outcomeSchema.optional(),
  receipt: receiptSchema.optional(),
}).refine(({ id, state, review, admission, outcome, receipt }) => {
  if ((state === 'pending-approval') !== (review !== undefined)) return false
  if (review !== undefined) {
    const digest = 'command' in review ? createHash('sha256').update(review.command).digest('hex') : businessPayloadDigest(review.business)
    if (review.payloadDigest !== digest || (review.workId === undefined) !== (review.principalId === undefined)) return false
  }
  if (admission !== undefined && admission.id !== `${id}-admission`) return false
  if (receipt !== undefined && receipt.id !== `${id}-${state === 'canceled' ? 'revocation' : 'outcome'}`) return false
  switch (state) {
    case 'pending-approval':
    case 'pending-evidence': return admission === undefined && outcome === undefined && receipt === undefined
    case 'issued':
    case 'running': return admission !== undefined && outcome === undefined && receipt === undefined
    case 'pending-outcome-evidence': return admission !== undefined && outcome?.kind !== 'model-response'
      && outcome?.kind !== 'business-response' && outcome?.kind !== 'business-not-sent'
      && outcome?.kind !== 'released' && outcome?.kind !== 'file-imported' && outcome?.kind !== 'file-exported' && receipt === undefined
    case 'settled':
      if (admission === undefined || outcome === undefined || outcome.kind === 'unknown' || receipt === undefined) return false
      return (outcome.kind !== 'file-imported' && outcome.kind !== 'file-exported') || receipt.digest === fileReceiptDigest(id, outcome)
    case 'unknown': return admission !== undefined && outcome?.kind === 'unknown'
    case 'canceled': return outcome === undefined
  }
})

/** Readable operation state. A settled observation has a separate evidence receipt. */
export type OperationStatus = z.infer<typeof statusSchema>

const brokerReceiptIdSchema = z.custom<BrokerReceiptId>(isBrokerReceiptId)
const resolvedLookup = z.strictObject({
  kind: z.enum(['succeeded', 'failed']), receiptId: brokerReceiptIdSchema,
})
const resolvedOwner = z.strictObject({
  kind: z.enum(['succeeded', 'failed']), source: z.literal('owner'),
})

/** Validate normalized lookup or owner observations retained before the witness acknowledges them. */
export const reconciliationObservationSchema = z.union([
  z.strictObject({ kind: z.literal('pending') }),
  resolvedLookup,
  resolvedOwner,
  z.strictObject({ kind: z.literal('unconfirmed'), code: identitySchema }),
])

/** Normalized lookup result, owner determination, or sanitized reason completion remains unresolved. */
export type ReconciliationObservation = z.infer<typeof reconciliationObservationSchema>

/** Validate the owner's determination after checking the external service. */
export const businessResolutionSchema = z.strictObject({ id: operationIdSchema, kind: z.enum(['succeeded', 'failed']) })

/** Owner determination submitted only through the approval socket. */
export type BusinessResolution = z.infer<typeof businessResolutionSchema>

/**
 * Bind a reconciliation observation to its operation and unique attempt.
 * @param id - Original business operation identity.
 * @param attemptId - Unique reconciliation attempt identity.
 * @param observation - Normalized lookup result or owner determination.
 * @returns The event committed by the independent witness.
 */
export function reconciliationObservationEvent(
  id: OperationId, attemptId: ReconciliationAttemptId, observation: ReconciliationObservation,
): EvidenceEvent {
  return { id: `${id}-reconcile-${attemptId}-outcome`, operationId: id, kind: 'outcome', body: { fact: 'business-reconciliation', ...observation } }
}

const businessCompletionSchema = z.union([
  z.strictObject({ kind: z.literal('unconfirmed'), code: identitySchema.optional(), receipt: receiptSchema.optional() }),
  z.strictObject({ kind: z.literal('pending'), receipt: receiptSchema }),
  resolvedLookup.extend({ receipt: receiptSchema }),
  resolvedOwner.extend({ receipt: receiptSchema }),
])

/** Validate a sanitized business operation and its independent dispatch and lookup outcomes. */
export const businessOperationStatusSchema = z.strictObject({
  id: operationIdSchema,
  sessionId: sessionIdSchema,
  action: actionSchema,
  state: stateSchema,
  /**
   * Human decision, or `unattended` for a request an unattended rule admitted without one. Absent while a request awaits
   * a decision and after it was canceled before one.
   */
  approval: z.enum(['approved', 'denied', 'unattended']).optional(),
  outcome: z.discriminatedUnion('kind', [businessResponseSchema, businessNotSentSchema, unknownOutcomeSchema]).optional(),
  receipt: receiptSchema.optional(),
  canReconcile: z.boolean(),
  businessCompletion: businessCompletionSchema,
}).refine(({ id, state, outcome, receipt, businessCompletion }) => {
  if (receipt !== undefined && receipt.id !== `${id}-${state === 'canceled' ? 'revocation' : 'outcome'}`) return false
  if (outcome !== undefined && receipt !== undefined &&
    receipt.digest !== digestEvidenceEvent({
      id: receipt.id, operationId: id, kind: 'outcome', body: outcome.kind === 'business-response' ? businessResponseEvidence(outcome) : outcome,
    })) return false
  const { receipt: lookupReceipt, ...observation } = businessCompletion
  if (lookupReceipt === undefined) return true
  const prefix = `${id}-reconcile-`
  const suffix = '-outcome'
  if (!lookupReceipt.id.startsWith(prefix) || !lookupReceipt.id.endsWith(suffix)) return false
  const attemptId = reconciliationAttemptIdSchema.safeParse(lookupReceipt.id.slice(prefix.length, -suffix.length))
  const parsed = reconciliationObservationSchema.safeParse(observation)
  return attemptId.success && parsed.success &&
    lookupReceipt.digest === digestEvidenceEvent(reconciliationObservationEvent(id, attemptId.data, parsed.data))
})

/** Business operation summary safe for the trusted Session's status consumer. */
export type BusinessOperationStatus = z.infer<typeof businessOperationStatusSchema>

/** Validate a bounded, Session-bound list of business operations. */
export const businessOperationsSchema = z.strictObject({
  sessionId: sessionIdSchema,
  workId: workIdSchema.optional(),
  operations: z.array(businessOperationStatusSchema).max(MAX_BUSINESS_OPERATIONS),
  next: operationIdSchema.optional(),
}).refine(({ sessionId, operations, next }) => operations.every(operation => operation.sessionId === sessionId) &&
  (next === undefined || (operations.length === MAX_BUSINESS_OPERATIONS && operations.at(-1)?.id === next)))

/** The latest business operations for one Session, newest first. */
export type BusinessOperations = z.infer<typeof businessOperationsSchema>

/** Largest number of records in one page of the owner's business record read. */
export const MAX_BUSINESS_RECORDS = 50

/** Validate one page of business records across every Session, newest first, with the exact request the owner would review. */
export const businessRecordsSchema = z.strictObject({
  records: z.array(businessOperationStatusSchema.safeExtend({
    method: z.literal('POST'),
    endpoint: z.url({ protocol: /^https$/u }),
    tool: z.string().min(1).max(256).exactOptional(),
    body: businessBodySchema,
    workId: workIdSchema.exactOptional(),
  })).max(MAX_BUSINESS_RECORDS),
  /** Cursor for older records; absent on the last page. */
  next: operationIdSchema.exactOptional(),
}).refine(({ records, next }) => next === undefined || records.at(-1)?.id === next)

/** The owner's view of recorded business requests, newest first in reservation order. */
export type BusinessRecords = z.infer<typeof businessRecordsSchema>

/** Validate the broker actions the Assistant grant permits, with each provider's usage text. */
export const businessActionsSchema = z.strictObject({
  actions: z.array(z.strictObject({ action: actionSchema, description: z.string().min(1).max(2000).optional() })),
})

/** Permitted broker actions in ascending action ID order. */
export type BusinessActions = z.infer<typeof businessActionsSchema>

const fieldNameSchema = z.string().min(1).max(256)

const unattendedRuleWithMatchSchema = z.strictObject({
  match: z.record(fieldNameSchema, z.union([z.string().max(4096), z.number(), z.boolean()])),
  allow: z.array(fieldNameSchema).max(64),
})
const unattendedRuleWithoutMatchSchema = z.strictObject({
  match: z.undefined().exactOptional(), allow: z.array(fieldNameSchema).max(64).exactOptional(),
})
const unattendedRuleSchema = z.union([unattendedRuleWithMatchSchema, unattendedRuleWithoutMatchSchema])

/**
 * One broker action whose matching requests the authority admits without a human decision.
 * Without `match` and `allow` it covers every request of the action.
 */
export type UnattendedAction = UnattendedRule & {
  /** Broker action ID. */
  readonly action: string
}

/** One unattended rule of an action whose action is implied by where the rule is listed. */
export type UnattendedRule = {
  /** Top-level body fields and their required values. */
  readonly match: Readonly<Record<string, string | number | boolean>>
  /** Other permitted top-level field names; their values are not checked. Empty permits no other fields. */
  readonly allow: string[]
} | {
  /** No required field values. */
  readonly match?: undefined
  /** Permitted top-level field names. Omit to accept every body of the action. */
  readonly allow?: string[]
}

/** Validate the complete list of unattended rules of one action. */
export const unattendedRulesSchema = z.array(unattendedRuleSchema).max(64)

/** Validate the profile's unattended rules, each naming its action; an owner's first edit copies each action's list. */
export const unattendedActionsSchema = z.array(z.union([
  unattendedRuleWithMatchSchema.extend({ action: actionSchema }),
  unattendedRuleWithoutMatchSchema.extend({ action: actionSchema }),
], { error: (issue) => {
  const rule = issue.input as { action?: string; match?: unknown; allow?: unknown } | undefined
  if (rule?.match !== undefined && rule.allow === undefined) {
    return `Unattended rule for action "${rule.action}" must add allow (use allow: [] to permit no other fields).`
  }
  return undefined
} })).max(1024)
  .refine(rules => rules.every(({ action }) => rules.filter(rule => rule.action === action).length <= 64),
    'An action has more than 64 unattended rules.')

/** Validate the owner's list of permitted broker actions and whether each has a stored credential. */
export const brokerConnectionsSchema = z.strictObject({
  /** Whether shell proposals are admitted without a human decision. */
  unattendedShell: z.boolean(),
  connections: z.array(z.strictObject({
    action: actionSchema,
    description: z.string().min(1).max(2000).optional(),
    credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    configured: z.boolean(),
    /** Whether the response text is handed to the requesting work environment. */
    returnsResponse: z.boolean(),
    /** Rules that send a matching request without a human decision. Empty when every request waits for one. */
    unattended: z.array(unattendedRuleSchema),
    /**
     * Whether the owner saved rules for this action under a route that differs from its current one. Those rules then do
     * not apply, `unattended` is empty, and they apply again when the route is again the one they were saved under.
     */
    routeChangedSinceRulesSaved: z.boolean(),
  })),
  /** Grant revision to send with a change to an action's unattended rules. */
  revision: digestSchema,
  /** The permitted model route and its API key state. Absent when the authority profile names no key for it. */
  model: z.strictObject({
    provider: z.string().min(1),
    model: z.string().min(1),
    credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    configured: z.boolean(),
  }).optional(),
})

/** Permitted broker actions in ascending action ID order and the model route, with credential state. Never carries a credential value. */
export type BrokerConnections = z.infer<typeof brokerConnectionsSchema>

const credentialValue = z.string().min(1).max(4096).nullable()

/** Validate an owner's replacement or removal of the credential for one permitted broker action or for the model route. */
export const brokerConnectionUpdateSchema = z.union([
  z.strictObject({ action: actionSchema, value: credentialValue }),
  z.strictObject({ model: z.literal(true), value: credentialValue }),
  z.strictObject({ action: actionSchema, unattended: unattendedRulesSchema, revision: digestSchema }),
])

/**
 * One owner change to a connection: the bearer token of a permitted broker action or of the model route, where `null`
 * removes the stored token, or the complete list of an action's unattended rules with the grant revision last read.
 */
export type BrokerConnectionUpdate = z.infer<typeof brokerConnectionUpdateSchema>

/** The token change of a {@link BrokerConnectionUpdate}. */
export type BrokerCredentialChange = Extract<BrokerConnectionUpdate, { value: unknown }>

/** Largest number of operations in one receipt lookup. */
export const MAX_RECEIPT_LOOKUP = 50

/** Validate a lookup of the receipts the authority holds for some operations. */
export const operationReceiptsRequestSchema = z.strictObject({ ids: z.array(operationIdSchema).min(1).max(MAX_RECEIPT_LOOKUP) })

/** Validate the receipts the authority holds for the operations it has; an operation it lacks is absent. */
export const operationReceiptsSchema = z.strictObject({
  receipts: z.array(z.strictObject({
    id: operationIdSchema,
    admission: receiptSchema.exactOptional(),
    outcome: receiptSchema.exactOptional(),
    revocation: receiptSchema.exactOptional(),
  })).max(MAX_RECEIPT_LOOKUP),
})

/** Witness receipts the authority holds for each requested operation it has. */
export type OperationReceipts = z.infer<typeof operationReceiptsSchema>

const countSchema = z.int().nonnegative()
const grantLimits = { expiresAt: z.int().positive(), maxOperations: z.int().positive() }
const grantBudget = {
  principalId: workPrincipalIdSchema,
  scopeId: identitySchema,
  ...grantLimits,
  expired: z.boolean(),
  reserved: countSchema,
  remaining: countSchema,
}

function matchesGrantBudget({ maxOperations, reserved, remaining }: z.infer<z.ZodObject<typeof grantBudget>>): boolean {
  return remaining === Math.max(0, maxOperations - reserved)
}

/** Validate a limit update against the revision last read by the owner. */
export const operationGrantUpdateSchema = z.strictObject({
  revision: digestSchema, ...grantLimits, expiresAt: grantLimits.expiresAt.max(8_640_000_000_000_000),
})

/** The grant revision and the two limit values submitted by the owner. */
export type OperationGrantUpdate = z.infer<typeof operationGrantUpdateSchema>

/** Validate the budget returned by the privileged approval socket. */
export const operationGrantBudgetSchema = z.strictObject({
  revision: digestSchema,
  /** Witness receipt of the record of the configuration the authority started with. */
  configuration: receiptSchema,
  ...grantBudget,
}).refine(matchesGrantBudget)

/** Current grant limits, edit revision, configuration record, and lifetime reservations. */
export type OperationGrantBudget = z.infer<typeof operationGrantBudgetSchema>

/** Validate the grant budget and Session's retained operation counts. */
export const operationOverviewSchema = z.strictObject({
  sessionId: sessionIdSchema,
  workId: workIdSchema.optional(),
  ...grantBudget,
  pendingApprovals: countSchema,
  running: countSchema,
  unknown: countSchema,
  businessCompletion: z.strictObject({
    pending: countSchema, unconfirmed: countSchema, succeeded: countSchema, failed: countSchema,
  }),
  lastFailure: z.strictObject({ id: operationIdSchema, code: identitySchema }).optional(),
  /**
   * Whether data the Session may retain from imported owner files, such as a work report, may currently reach a
   * model and the owner: false while the current ceiling or a work grant forbids either disclosure.
   */
  disclosesImportedData: z.boolean(),
}).refine(matchesGrantBudget)

/** The shared grant budget and retained status for one Session or work assignment. */
export type OperationOverview = z.infer<typeof operationOverviewSchema>

/** Validate a parent execution's pending-review notification or an elapsed wait. */
export const reviewWaitSchema = z.strictObject({ review: statusSchema.optional() })

/** Validate an authority error response. */
export const failureSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  operationId: operationIdSchema.optional(),
})

/** Recovery guidance when admission is waiting for a witness and no operation was issued. */
export const WITNESS_WAITING_MESSAGE = "The witness service is not confirming records. This operation did not run or send anything. Check Vardock's services with pnpm vardock doctor. Vardock recovers automatically when the witness returns."

/** Expected request failure or loss of transport to the authority. */
export class OperationControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operationId?: OperationId,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OperationControlError'
  }
}
