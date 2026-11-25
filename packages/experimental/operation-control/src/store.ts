/** Private durable authorization state and exclusive ownership of its SQLite database. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { EvidenceEvent, EvidenceReceipt } from '@deepseek-ai/dsh-operation-evidence'
import { digestEvidenceEvent } from '@deepseek-ai/dsh-operation-evidence/library'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import {
  businessPayloadDigest, businessResponseEvidence, DEFAULT_MAX_FILE_BYTES, fileReceiptDigest,
  handoffOutcome, handoffReceiptDigest, identitySchema, MAX_BUSINESS_OPERATIONS, MAX_BUSINESS_RECORDS,
  operationGrantUpdateSchema, operationIdSchema, OperationControlError, proposalSchema, receiptSchema,
  reconciliationAttemptIdSchema, reconciliationObservationEvent, reconciliationObservationSchema, retainedOutcomeSchema,
  stateSchema, unattendedRulesSchema, workIdSchema, workPrincipalIdSchema,
  workInputPath, type BusinessProposal, type HandoffProposal, type OperationGrantBudget,
  type OperationGrantUpdate, type OperationId, type OperationProposal, type OperationReceipts, type UnattendedRule,
  type ReconciliationObservation, type WorkGrant, type WorkId, type WorkPermissions, type WorkPrincipalId,
} from './protocol.ts'

const SCHEMA_VERSION = 13
const SESSION_FILTER = `json_extract(record, '$.proposal.sessionId') = ?
  AND (? IS NULL OR json_extract(record, '$.workId') = ?)`
const BUSINESS = 'json_type(record, \'$.proposal.business\') = \'object\''
const BUSINESS_SESSION_FILTER = `${BUSINESS} AND ${SESSION_FILTER}`
const OPERATION_STATE = 'json_extract(record, \'$.state\')'
const SETTLED_WORK = `${OPERATION_STATE} = 'settled' AND json_type(record, '$.outcome.work') = 'object'`
const WORK_SESSION = 'json_extract(record, \'$.outcome.work.sessionId\')'
const WORK_ID = 'json_extract(record, \'$.outcome.work.workId\')'
const DELEGATION_SESSION = 'json_extract(record, \'$.proposal.handoff.targetSessionId\')'
const DELEGATION_WORK_ID = 'json_extract(record, \'$.proposal.handoff.delegation.workId\')'
const PENDING_DELEGATION = `json_type(record, '$.proposal.handoff.delegation') = 'object'
  AND ${OPERATION_STATE} IN ('pending-evidence', 'issued', 'running', 'pending-outcome-evidence')`
const POSSIBLE_IMPORT = `json_extract(record, '$.proposal.file.kind') = 'import'
  AND ${OPERATION_STATE} IN ('running', 'pending-outcome-evidence', 'settled', 'unknown')`

/** The static grant compiled by the trusted authority at launch. */
export interface Grant {
  readonly principalId: WorkPrincipalId
  readonly scopeId: string
  readonly expiresAt: number
  readonly maxOperations: number
  /** Digest of the configuration, including settings the configuration record omits, such as socket paths. */
  readonly fingerprint: string
  /** What the configuration permits, witnessed at each start whose fingerprint the store has not recorded. */
  readonly configuration: EvidenceEvent['body']
  readonly maxFileBytes?: number
  readonly assistant?: {
    readonly mainSessionId: SessionId
    readonly permissions: WorkPermissions
  }
}

const recordSchema = z.strictObject({
  id: operationIdSchema,
  proposal: proposalSchema,
  principalId: workPrincipalIdSchema,
  scopeId: identitySchema,
  workId: workIdSchema.optional(),
  revision: z.string().length(64),
  limitsRevision: z.string().length(64).optional(),
  rulesRevision: z.string().length(64).optional(),
  fingerprint: z.string().length(64),
  expiresAt: z.number().int(),
  payloadDigest: z.string().length(64),
  state: stateSchema,
  /** Human decision, or `unattended` for a business request reserved under an unattended rule. */
  approval: z.enum(['approved', 'denied', 'unattended']).optional(),
  /** Earlier business request to this action whose outcome is unresolved, which made this one wait for a human decision. */
  repeats: operationIdSchema.optional(),
  admission: receiptSchema.optional(),
  outcome: retainedOutcomeSchema.optional(),
  receipt: receiptSchema.optional(),
  revoked: receiptSchema.optional(),
})

/** Immutable operation payload plus its durable lifecycle state. */
export type Operation = z.infer<typeof recordSchema>

const ownerLimitsSchema = z.strictObject({ update: operationGrantUpdateSchema, receipt: receiptSchema })

/** The witnessed configuration record of the current revision; `previousRevision` is null for a new store. */
const configurationRecordSchema = z.strictObject({ previousRevision: z.string().length(64).nullable(), receipt: receiptSchema })

const ownerRulesSchema = z.strictObject({
  revision: z.string().length(64),
  actions: z.array(z.strictObject({ action: z.string(), routeDigest: z.string().length(64), rules: unattendedRulesSchema })),
  receipt: receiptSchema,
})

/** One action's saved unattended rules and the route they were saved under. */
export interface OwnerActionRules {
  readonly action: string
  /** The action's broker `routeDigest` when the owner saved these rules; they apply only while it is unchanged. */
  readonly routeDigest: string
  /** The owner's rules for this action; an empty list sends no request without a decision. */
  readonly rules: readonly UnattendedRule[]
}

/** Witnessed owner rules and the grant revision the edit replaced. */
export interface OwnerRules {
  readonly revision: string
  /** Each action with saved rules, in ascending action ID order. */
  readonly actions: readonly OwnerActionRules[]
  readonly receipt: EvidenceReceipt
}

const reconciliationSchema = z.strictObject({
  id: reconciliationAttemptIdSchema,
  revision: z.string().length(64),
  expiresAt: z.number().int(),
  intent: receiptSchema.optional(),
  observation: reconciliationObservationSchema.optional(),
  receipt: receiptSchema.optional(),
})

/** Lookup intent or owner determination, with the observation and its receipt separate from dispatch. */
export type ReconciliationAttempt = z.infer<typeof reconciliationSchema>

/**
 * Bind one lookup to the witnessed dispatch and currently authorized grant.
 * @param operation - Original business operation.
 * @param attempt - Durable lookup reservation.
 * @returns The intent the witness must acknowledge before lookup.
 */
export function reconciliationIntentEvent(operation: Operation, attempt: ReconciliationAttempt): EvidenceEvent {
  const { proposal, receipt } = operation
  const endpoint = 'business' in proposal ? proposal.business.reconciliationEndpoint : undefined
  if (receipt === undefined || endpoint === undefined) throw new Error('Business reconciliation lacks its original dispatch receipt or lookup target')
  return {
    id: `${operation.id}-reconcile-${attempt.id}-admission`, operationId: operation.id, kind: 'admission',
    body: {
      fact: 'business-reconciliation',
      principalId: operation.principalId,
      scopeId: operation.scopeId,
      sessionId: operation.proposal.sessionId,
      ...(operation.workId === undefined ? {} : { workId: operation.workId }),
      payloadDigest: operation.payloadDigest,
      dispatchDigest: receipt.digest,
      targetDigest: digest(endpoint),
      revision: attempt.revision,
      expiresAt: attempt.expiresAt,
    },
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function payloadDigest(proposal: OperationProposal): string {
  if ('command' in proposal) return digest(proposal.command)
  if ('modelRequest' in proposal) return digest(JSON.stringify(proposal.modelRequest))
  if ('business' in proposal) return businessPayloadDigest(proposal.business)
  if ('file' in proposal) {
    const { file } = proposal
    return digest(JSON.stringify(file.kind === 'import'
      ? ['file-import', file.workId, file.source]
      : ['file-export', file.workId, file.path, file.targetSessionId]))
  }
  const { kind, targetSessionId, content, delegation } = proposal.handoff
  return digest(JSON.stringify(['handoff', kind, targetSessionId, content, ...(delegation === undefined ? [] : [delegation])]))
}

function permissionSubset(requested: WorkPermissions, allowed: WorkPermissions): boolean {
  const { data } = requested
  const ceiling = allowed.data
  return (!requested.exec || allowed.exec) && requested.brokerActions.every(action => allowed.brokerActions.includes(action)) &&
    (data === undefined || ((!data.import || ceiling?.import === true) &&
      (!data.export || ceiling?.export === true) &&
      (!data.discloseToModel || ceiling?.discloseToModel === true) &&
      (!data.discloseToUser || ceiling?.discloseToUser === true) &&
      (data.returnResponses !== true || ceiling?.returnResponses === true)))
}

function canDisclose({ data }: WorkPermissions): boolean {
  return data?.discloseToModel === true && data.discloseToUser
}

function intersectData(parent: WorkPermissions['data'], root: WorkPermissions['data']): WorkPermissions['data'] {
  if (parent === undefined || root === undefined) return undefined
  return {
    import: parent.import && root.import, export: parent.export && root.export,
    discloseToModel: parent.discloseToModel && root.discloseToModel,
    discloseToUser: parent.discloseToUser && root.discloseToUser,
    returnResponses: parent.returnResponses === true && root.returnResponses === true,
  }
}

function proposalKind(proposal: OperationProposal): 'command' | 'model' | 'handoff' | 'business' | 'file' {
  if ('command' in proposal) return 'command'
  if ('modelRequest' in proposal) return 'model'
  if ('business' in proposal) return 'business'
  if ('file' in proposal) return 'file'
  return 'handoff'
}

async function createPrivateFile(path: string): Promise<void> {
  const uid = process.getuid?.()
  const directory = await lstat(dirname(path))
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== uid) {
    throw new Error('The operation database needs an authority-owned private directory')
  }
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const info = await lstat(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== uid) {
    throw new Error('The operation database must be an owner-only regular file')
  }
}

/** Holds the database's process-exclusive lock through its last observation write. */
export class OperationStore {
  private failed: OperationControlError | undefined
  private revision = ''
  private configuration: z.infer<typeof configurationRecordSchema> | undefined
  /** The revision this start establishes, until the witness confirms its configuration record. */
  private unrecorded: { readonly previousRevision: string | null; readonly revision: string } | undefined
  private ownerLimits: z.infer<typeof ownerLimitsSchema> | undefined
  private ownerRules: OwnerRules | undefined

  private constructor(private readonly db: DatabaseSync, private readonly grant: Grant) {}

  private get limits(): Pick<Grant, 'expiresAt' | 'maxOperations'> {
    return this.ownerLimits?.update ?? this.grant
  }

  /**
   * The owner's last witnessed unattended rules. Undefined until the owner's first edit, while the profile's rules apply.
   * Each action's rules apply only while its broker route digest equals the saved one.
   */
  get unattendedRules(): OwnerRules | undefined {
    return this.ownerRules
  }

  private get grantRevision(): string {
    const limits = this.ownerLimits?.receipt.digest
    const rules = this.ownerRules?.receipt.digest
    if (rules !== undefined) return digest(JSON.stringify([this.revision, limits ?? null, rules]))
    return limits === undefined ? this.revision : digest(JSON.stringify([this.revision, limits]))
  }

  private get ownerEventOperationId(): string {
    const { principalId, scopeId } = this.grant
    return `grant-${digest(JSON.stringify([principalId, scopeId]))}`
  }

  /**
   * Acquire exclusive ownership and mark every unresolved prior execution unknown.
   * @param path - owner-controlled local database path.
   * @param grant - effective policy for this authority process.
   * @returns the open store.
   */
  static async open(path: string, grant: Grant): Promise<OperationStore> {
    await createPrivateFile(path)
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA locking_mode = EXCLUSIVE')
      const store = new OperationStore(db, grant)
      store.transaction(() => { store.initialize() })
      return store
    } catch (error: unknown) {
      db.close()
      throw error
    }
  }

  /**
   * Durably reserve one slot across all Sessions or recover an identical prior proposal.
   * @param proposal - schema-validated and exact operation payload.
   * @param check - grant admission checks for a new reservation.
   * @param requiresApproval - whether a new reservation waits for a human decision before admission. A business
   *   request that does not is recorded as admitted by an unattended rule, unless it repeats an earlier business request
   *   under this grant with the same action whose outcome is unresolved; such a request waits for a
   *   decision and records the earlier one in `repeats`.
   * @returns the reserved operation.
   */
  reserve(proposal: OperationProposal, check: () => void, requiresApproval: boolean): Operation {
    return this.transaction(() => {
      const proposedDigest = payloadDigest(proposal)
      const row = this.db.prepare('SELECT record FROM operations WHERE request_key = ?').get(proposal.requestKey)
      if (row !== undefined) {
        const existing = this.decode(row)
        if (existing.proposal.sessionId !== proposal.sessionId
          || proposalKind(existing.proposal) !== proposalKind(proposal)
          || existing.payloadDigest !== proposedDigest) {
          throw new OperationControlError('key-conflict', 'The request key is already bound to a different operation.', existing.id)
        }
        return existing
      }
      check()
      const { expiresAt, maxOperations } = this.limits
      this.checkCurrent(this.revision, expiresAt)
      const work = this.authorize(proposal)
      if ('handoff' in proposal) {
        const delegation = this.resolveDelegation(proposal)
        if (delegation !== undefined) this.checkPendingDelegation(delegation)
      }
      if (this.reservationCount() >= maxOperations) {
        throw new OperationControlError('budget-exhausted', 'The operation grant has reached its budget.')
      }
      const repeats = 'business' in proposal ? this.unresolvedRepeat(proposal.business) : undefined
      const reviewed = requiresApproval || repeats !== undefined
      const operation: Operation = {
        id: operationIdSchema.parse(randomUUID()),
        proposal,
        principalId: this.grant.principalId,
        scopeId: this.grant.scopeId,
        ...(work === undefined ? {} : { workId: work.workId }),
        revision: this.revision,
        ...(this.ownerLimits === undefined ? {} : { limitsRevision: this.ownerLimits.receipt.digest }),
        ...(this.ownerRules === undefined ? {} : { rulesRevision: this.ownerRules.receipt.digest }),
        fingerprint: this.grant.fingerprint,
        expiresAt,
        payloadDigest: proposedDigest,
        state: reviewed ? 'pending-approval' : 'pending-evidence',
        ...'business' in proposal && !reviewed ? { approval: 'unattended' } : {},
        ...repeats === undefined ? {} : { repeats },
      }
      this.db.prepare('INSERT INTO operations (id, request_key, record) VALUES (?, ?, ?)').run(
        operation.id, proposal.requestKey, JSON.stringify(operation),
      )
      return operation
    })
  }

  /**
   * Read the current operation from the locked database.
   * @param id - authority-generated operation ID.
   * @returns the current operation.
   */
  get(id: OperationId): Operation {
    return this.access(() => {
      const row = this.db.prepare('SELECT record FROM operations WHERE id = ?').get(id)
      if (row === undefined) throw new OperationControlError('not-found', 'The operation does not exist.', id)
      return this.decode(row)
    })
  }

  /**
   * Read the witness receipts held for some operations without changing any record.
   * @param ids - authority-generated operation IDs.
   * @returns The receipts of each operation the database has, in request order.
   */
  receipts(ids: readonly OperationId[]): OperationReceipts['receipts'] {
    return this.access(() => ids.flatMap((id) => {
      const row = this.db.prepare('SELECT record FROM operations WHERE id = ?').get(id)
      if (row === undefined) return []
      const { admission, receipt, revoked } = this.decode(row)
      return [{
        id,
        ...admission === undefined ? {} : { admission },
        ...receipt === undefined ? {} : { outcome: receipt },
        ...revoked === undefined ? {} : { revocation: revoked },
      }]
    }))
  }

  /**
   * Read the current grant and its lifetime reservation count, including canceled and unknown records.
   * @returns Budget and expiry metadata without requiring the grant to be current.
   */
  budget(): Omit<OperationGrantBudget, 'revision' | 'configuration'> {
    return this.access(() => {
      const { principalId, scopeId } = this.grant
      const { expiresAt, maxOperations } = this.limits
      const reserved = this.reservationCount()
      return { principalId, scopeId, expiresAt, expired: Date.now() >= expiresAt, maxOperations, reserved,
        remaining: Math.max(0, maxOperations - reserved) }
    })
  }

  /**
   * Read the effective limits and owner edit revision, including after expiry.
   * @returns The current budget and revision required to update it.
   */
  grantSettings(): OperationGrantBudget {
    if (this.configuration === undefined) throw new Error('The authority configuration has no witness receipt yet')
    return { ...this.budget(), revision: this.grantRevision, configuration: this.configuration.receipt }
  }

  /**
   * The event that records this start's configuration, until {@link commitConfiguration} adopts its revision.
   * The same stored state and configuration always yield the same event, so a retry after a lost reply repeats it.
   * @returns The event to witness, or undefined when the store already holds this configuration's receipt.
   */
  get configurationEvent(): EvidenceEvent | undefined {
    if (this.unrecorded === undefined) return undefined
    return this.configurationRecordEvent(this.unrecorded.previousRevision, this.unrecorded.revision)
  }

  /**
   * Record the witness receipt of {@link configurationEvent} and adopt its revision in one transaction.
   * @param receipt - Independent acknowledgment whose ID and digest match the event.
   * @throws When no configuration awaits its receipt or the store cannot commit it.
   */
  commitConfiguration(receipt: EvidenceReceipt): void {
    const { unrecorded } = this
    if (unrecorded === undefined) throw new Error('The authority configuration is already recorded')
    const record = { previousRevision: unrecorded.previousRevision, receipt }
    this.transaction(() => {
      this.db.prepare('UPDATE authority SET fingerprint = ?, revision = ?, configuration = ? WHERE id = 1')
        .run(this.grant.fingerprint, unrecorded.revision, JSON.stringify(record))
    })
    this.revision = unrecorded.revision
    this.configuration = record
    this.unrecorded = undefined
  }

  private configurationRecordEvent(previousRevision: string | null, revision: string): EvidenceEvent {
    const { principalId, scopeId, configuration } = this.grant
    const body = { kind: 'configuration', principalId, scopeId, previousRevision, revision, configuration }
    return { id: `configuration-${digest(JSON.stringify(body))}`, operationId: this.ownerEventOperationId, kind: 'admission', body }
  }

  /**
   * Check the owner's edit revision and build a retryable witness event before changing limits.
   * @param update - The revision last read by the owner and the requested limits.
   * @returns The event to witness, or undefined when the limits already match.
   * @throws When the edit revision is stale or the store is unavailable.
   */
  prepareGrantUpdate(update: OperationGrantUpdate): EvidenceEvent | undefined {
    return this.access(() => {
      this.assertGrantRevision(update.revision)
      const { expiresAt, maxOperations } = this.limits
      if (expiresAt !== update.expiresAt || maxOperations !== update.maxOperations) return this.grantUpdateEvent(update)
    })
  }

  /**
   * Commit the witnessed limits and publish the new revision.
   * @param update - The revision last read by the owner and the requested limits.
   * @param receipt - Independent acknowledgment of this exact change.
   * @returns The updated budget, including reservations made during witness acknowledgment.
   * @throws When the revision changed or the store cannot commit the witnessed limits.
   */
  commitGrantUpdate(update: OperationGrantUpdate, receipt: EvidenceReceipt): OperationGrantBudget {
    const limits = { update, receipt }
    this.transaction(() => {
      this.assertGrantRevision(update.revision)
      this.verifyGrantLimits(limits)
      this.db.prepare('UPDATE authority SET owner_limits = ? WHERE id = 1').run(JSON.stringify(limits))
    })
    this.ownerLimits = limits
    return this.grantSettings()
  }

  /**
   * Check the owner's edit revision and build the witness event for a complete replacement of the unattended rules.
   * @param rules - The grant revision last read by the owner and each action's rules with its route digest, in ascending action ID order.
   * @returns The event to witness before {@link commitUnattendedRules}.
   * @throws When the edit revision is stale or the store is unavailable.
   */
  prepareUnattendedRules(rules: Omit<OwnerRules, 'receipt'>): EvidenceEvent {
    return this.access(() => {
      this.assertGrantRevision(rules.revision)
      return this.unattendedRulesEvent(rules)
    })
  }

  /**
   * Commit witnessed unattended rules and publish the new revision. They replace the profile's rules from then on.
   * @param rules - The rules passed to {@link prepareUnattendedRules}.
   * @param receipt - Independent acknowledgment of this exact change.
   * @throws When the revision changed or the store cannot commit the witnessed rules.
   */
  commitUnattendedRules(rules: Omit<OwnerRules, 'receipt'>, receipt: EvidenceReceipt): void {
    const saved: OwnerRules = { ...rules, receipt }
    this.transaction(() => {
      this.assertGrantRevision(rules.revision)
      this.verifyUnattendedRules(saved)
      this.db.prepare('UPDATE authority SET owner_rules = ? WHERE id = 1').run(JSON.stringify(saved))
    })
    this.ownerRules = saved
  }

  private assertGrantRevision(revision: string): void {
    if (revision !== this.grantRevision) {
      throw new OperationControlError('revision-mismatch', 'The grant changed. Refresh the limits before saving again.')
    }
  }

  private grantUpdateEvent({ revision, expiresAt, maxOperations }: OperationGrantUpdate): EvidenceEvent {
    const { principalId, scopeId } = this.grant
    const body = { kind: 'grant-limits-update', principalId, scopeId, previousRevision: revision, expiresAt, maxOperations }
    const id = `grant-limits-${digest(JSON.stringify(body))}`
    return { id, operationId: this.ownerEventOperationId, kind: 'admission', body }
  }

  private unattendedRulesEvent({ revision, actions }: Omit<OwnerRules, 'receipt'>): EvidenceEvent {
    const { principalId, scopeId } = this.grant
    const body = {
      kind: 'unattended-rules-update', principalId, scopeId, previousRevision: revision,
      // The event ID hashes this text, so each entry's and rule's keys keep one order through storage and validation.
      actions: actions.map(({ action, routeDigest, rules }) => ({
        action, routeDigest,
        rules: rules.map(({ match, allow }) => ({ ...match === undefined ? {} : { match }, ...allow === undefined ? {} : { allow } })),
      })),
    }
    const id = `unattended-rules-${digest(JSON.stringify(body))}`
    return { id, operationId: this.ownerEventOperationId, kind: 'admission', body }
  }

  /**
   * Build the witness event for one accepted owner request to change a stored credential, recorded before the write.
   * It carries no credential value and does not establish that the write succeeded.
   * @param action - Broker action whose token changes, or undefined for the model route's key.
   * @param stored - Whether a value is stored rather than removed.
   * @returns A new event; two identical changes are separate events.
   */
  credentialChangeEvent(action: string | undefined, stored: boolean): EvidenceEvent {
    const { principalId, scopeId } = this.grant
    return {
      id: `credential-${randomUUID()}`,
      operationId: this.ownerEventOperationId,
      kind: 'admission',
      body: { kind: 'credential-change', principalId, scopeId, ...action === undefined ? { model: true } : { action }, stored },
    }
  }

  private verifyGrantLimits({ update, receipt }: z.infer<typeof ownerLimitsSchema>): void {
    const event = this.grantUpdateEvent(update)
    if (receipt.id !== event.id || receipt.digest !== digestEvidenceEvent(event)) {
      throw new Error('The saved grant limits lack matching witness evidence')
    }
  }

  private verifyUnattendedRules({ receipt, ...rules }: OwnerRules): void {
    const event = this.unattendedRulesEvent(rules)
    if (receipt.id !== event.id || receipt.digest !== digestEvidenceEvent(event)) {
      throw new Error('The saved unattended rules lack matching witness evidence')
    }
  }

  /**
   * Inspect retained issues, business operations, and the latest settled operation in reservation order.
   * @param sessionId - Session whose operations are requested.
   * @param workId - Limit to one assignment when supplied.
   * @param visit - Synchronous reader of each verified operation.
   */
  inspectSessionOperations(sessionId: SessionId, workId: WorkId | undefined, visit: (operation: Operation) => void): void {
    this.access(() => {
      const rows = this.db.prepare(`SELECT record FROM operations WHERE ${SESSION_FILTER} AND (
        ${OPERATION_STATE} IN ('pending-approval', 'running', 'unknown', 'pending-outcome-evidence', 'canceled')
        OR json_type(record, '$.proposal.business') = 'object'
        OR json_extract(record, '$.outcome.observation.exitCode') <> 0
        OR rowid = (SELECT MAX(rowid) FROM operations WHERE ${SESSION_FILTER} AND ${OPERATION_STATE} = 'settled')
      ) ORDER BY rowid`).iterate(sessionId, workId ?? null, workId ?? null, sessionId, workId ?? null, workId ?? null)
      for (const row of rows) visit(this.decode(row))
    })
  }

  /**
   * Read one bounded page of business records without scanning unrelated payloads.
   * @param sessionId - Session whose original requests may be inspected.
   * @param after - Last operation from the preceding page.
   * @param workId - Limit to one assignment when supplied.
   * @returns The next page and, when older records exist, its cursor.
   */
  businessOperations(sessionId: SessionId, after?: OperationId, workId?: WorkId): { operations: Operation[]; next?: OperationId } {
    return this.access(() => {
      const filter = [sessionId, workId ?? null, workId ?? null] as const
      const cursor = after === undefined ? undefined
        : this.db.prepare(`SELECT rowid FROM operations WHERE ${BUSINESS_SESSION_FILTER} AND id = ?`).get(...filter, after)?.rowid
      if (after !== undefined && cursor === undefined) {
        throw new OperationControlError('business-cursor-invalid', 'The cursor does not identify a business operation in the requested scope.')
      }
      const rows = cursor === undefined
        ? this.db.prepare(`SELECT record FROM operations WHERE ${BUSINESS_SESSION_FILTER}
          ORDER BY rowid DESC LIMIT ?`).all(...filter, MAX_BUSINESS_OPERATIONS + 1)
        : this.db.prepare(`SELECT record FROM operations WHERE ${BUSINESS_SESSION_FILTER} AND rowid < ?
          ORDER BY rowid DESC LIMIT ?`).all(...filter, cursor, MAX_BUSINESS_OPERATIONS + 1)
      const operations = rows.slice(0, MAX_BUSINESS_OPERATIONS).map(row => this.decode(row))
      const next = rows.length > MAX_BUSINESS_OPERATIONS ? operations.at(-1)?.id : undefined
      return next === undefined ? { operations } : { operations, next }
    })
  }

  /**
   * Read one page of business records across every Session, newest first in reservation order.
   * @param after - Last operation of the preceding page.
   * @returns Up to {@link MAX_BUSINESS_RECORDS} records and whether older ones exist.
   */
  businessRecords(after?: OperationId): { operations: Operation[]; more: boolean } {
    return this.access(() => {
      const cursor = after === undefined ? undefined
        : this.db.prepare(`SELECT rowid FROM operations WHERE ${BUSINESS} AND id = ?`).get(after)?.rowid
      if (after !== undefined && cursor === undefined) {
        throw new OperationControlError('business-cursor-invalid', 'The cursor does not identify a business operation.')
      }
      const rows = this.db.prepare(`SELECT record FROM operations WHERE ${BUSINESS} AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
        .all(cursor ?? Number.MAX_SAFE_INTEGER, MAX_BUSINESS_RECORDS + 1)
      return { operations: rows.slice(0, MAX_BUSINESS_RECORDS).map(row => this.decode(row)), more: rows.length > MAX_BUSINESS_RECORDS }
    })
  }

  /**
   * Read and verify the latest retained reconciliation attempt for a business operation.
   * @param operation - Original business operation.
   * @returns The latest attempt, if one exists.
   */
  latestReconciliation(operation: Operation): ReconciliationAttempt | undefined {
    return this.access(() => {
      const row = this.db.prepare('SELECT record FROM reconciliations WHERE operation_id = ? ORDER BY rowid DESC LIMIT 1').get(operation.id)
      if (row === undefined) return undefined
      if (typeof row.record !== 'string') throw new Error('Invalid reconciliation database row')
      const attempt = reconciliationSchema.parse(JSON.parse(row.record))
      if (attempt.intent !== undefined) {
        const intent = reconciliationIntentEvent(operation, attempt)
        if (attempt.intent.id !== intent.id || attempt.intent.digest !== digestEvidenceEvent(intent)) {
          throw new Error('Reconciliation lacks matching intent evidence')
        }
      }
      if (attempt.observation !== undefined && !('source' in attempt.observation)
        && attempt.intent === undefined) throw new Error('Reconciliation observation lacks an intent')
      if (attempt.receipt !== undefined) {
        if (attempt.observation === undefined) throw new Error('Reconciliation receipt lacks an observation')
        const event = reconciliationObservationEvent(operation.id, attempt.id, attempt.observation)
        if (attempt.receipt.id !== event.id || attempt.receipt.digest !== digestEvidenceEvent(event)) {
          throw new Error('Reconciliation lacks matching observation evidence')
        }
      }
      return attempt
    })
  }

  /**
   * Reserve a reconciliation observation or recover an intent that has yet to authorize a lookup.
   * @param id - Original business operation ID.
   * @param previous - Latest attempt, when present.
   * @param owner - Owner determination when supplied; omission reserves a read-only lookup under current permissions.
   * @returns A durable reconciliation reservation.
   */
  reserveReconciliation(
    id: OperationId, previous?: ReconciliationAttempt, owner?: Extract<ReconciliationObservation, { source: 'owner' }>,
  ): ReconciliationAttempt {
    return this.transaction(() => {
      if (owner === undefined) this.assertLookupAllowed(this.get(id))
      if (owner === undefined && previous !== undefined && previous.intent === undefined
        && previous.revision === this.revision) return previous
      const attempt = {
        id: reconciliationAttemptIdSchema.parse(randomUUID()),
        revision: this.revision,
        expiresAt: this.limits.expiresAt,
        ...(owner === undefined ? {} : { observation: owner }),
      }
      this.db.prepare('INSERT INTO reconciliations (id, operation_id, record) VALUES (?, ?, ?)').run(attempt.id, id, JSON.stringify(attempt))
      return attempt
    })
  }

  /**
   * Durably record the witness acknowledgment or normalized observation for one attempt.
   * @param attempt - Updated attempt owned by the authority's in-flight reconciliation.
   */
  putReconciliation(attempt: ReconciliationAttempt): void {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE reconciliations SET record = ? WHERE id = ?').run(JSON.stringify(attempt), attempt.id)
      if (result.changes !== 1) throw new Error('The reconciliation attempt disappeared during its transition')
    })
  }

  /**
   * Durably advance an operation from its current expected state.
   * @param operation - next record, with immutable binding retained.
   * @param expected - required preceding state.
   * @returns the saved record or the current record if another request advanced it first.
   */
  put(operation: Operation, expected: Operation['state']): Operation {
    return this.transaction(() => {
      const current = this.get(operation.id)
      if (current.state !== expected) return current
      if (operation.state === 'issued' || operation.state === 'running' ||
        (expected === 'pending-approval' && operation.state === 'pending-evidence')) {
        this.assertCurrent(current)
      }
      if (operation.state === 'settled' && operation.outcome?.kind === 'released') {
        this.assertCurrent(current)
      }
      this.write(operation)
      return operation
    })
  }

  /**
   * Check whether an unconsumed approval or permit was invalidated.
   * A witnessed configuration revision, or an owner edit of the limits or rules, invalidates it.
   * @param operation - The retained operation to inspect.
   * @returns Whether this operation can no longer advance.
   */
  isPermitSuperseded(operation: Operation): boolean {
    return (operation.state === 'pending-approval' || operation.state === 'pending-evidence' || operation.state === 'issued') &&
      (operation.revision !== this.revision
        || operation.limitsRevision !== this.ownerLimits?.receipt.digest
        || operation.rulesRevision !== this.ownerRules?.receipt.digest)
  }

  /**
   * Check the grant revision, expiry, and current work assignment before an operation advances.
   * An already consumed handoff can recover its release under a renewed expiry.
   * @param operation - The retained operation about to advance or return a witnessed release.
   * @throws When the operation no longer has permission to advance.
   */
  assertCurrent(operation: Operation): void {
    const renewedRelease = operation.outcome?.kind === 'released' && this.ownerLimits !== undefined &&
      operation.limitsRevision !== this.ownerLimits.receipt.digest
    const expiresAt = renewedRelease ? this.limits.expiresAt : Math.min(operation.expiresAt, this.limits.expiresAt)
    this.checkCurrent(operation.revision, expiresAt, operation.id)
    if (this.isPermitSuperseded(operation)) {
      throw new OperationControlError('revision-mismatch', 'The owner changed the grant before execution.', operation.id)
    }
    this.checkWorkBinding(operation, this.authorize(operation.proposal, operation.id))
    if ('handoff' in operation.proposal) {
      if (operation.state === 'settled') {
        const { handoff } = operation.proposal
        if (handoff.kind === 'delegation' && this.readWork(handoff.targetSessionId)?.workId !== handoff.delegation?.workId) {
          throw new OperationControlError('work-superseded', 'This work release has been superseded.', operation.id)
        }
      } else {
        this.resolveDelegation(operation.proposal, operation.id)
      }
    }
  }

  /**
   * Check the parent grant before resolving a guest-supplied broker action.
   * @param parent - The active shell operation submitting the request.
   * @param action - The validated guest action identity.
   * @throws When this work lacks permission for the action.
   */
  assertBrokerAction(parent: Operation, action: string): void {
    this.checkCurrent(parent.revision, Math.min(parent.expiresAt, this.limits.expiresAt), parent.id)
    const work = this.authorize(parent.proposal, parent.id)
    this.checkWorkBinding(parent, work)
    if (work !== undefined) this.checkAction(work, action, parent.id)
  }

  /**
   * Check both the original work grant and current policy before a read-only lookup.
   * @param operation - The original business dispatch.
   * @throws When the current policy or either work assignment forbids the action.
   */
  assertLookupAllowed(operation: Operation): void {
    const { id, proposal, workId } = operation
    this.checkCurrent(this.revision, this.limits.expiresAt, id)
    const current = this.authorize(proposal, id)
    if (current === undefined || workId === undefined) {
      this.checkWorkBinding(operation, current)
      return
    }
    if (!('business' in proposal)) throw new Error('Reconciliation requires a business proposal')
    const original = this.readWorkById(workId)
    if (original?.sessionId !== proposal.sessionId) throw new Error('Business operation lacks its original work grant')
    this.checkAction(original, proposal.business.action, id)
  }

  /**
   * Check current disclosure policy for retained transfer and potentially data-bearing outcomes.
   * @param operation - The operation whose observation would be disclosed.
   * @throws When the current ceiling or either work grant forbids disclosure.
   */
  assertOutcomeDisclosure({ id, proposal, workId }: Operation): void {
    if (!('file' in proposal) && !(('command' in proposal || 'modelRequest' in proposal) && this.hasPossibleImport(proposal.sessionId))) return
    this.checkCurrent(this.revision, this.limits.expiresAt, id)
    if (!this.permitsDisclosure(proposal.sessionId, workId) ||
      ('file' in proposal && proposal.file.kind === 'export' && proposal.file.targetSessionId !== this.grant.assistant?.mainSessionId)) {
      throw new OperationControlError('work-disclosure-denied', 'The current work grant does not permit releasing this data.', id)
    }
  }

  /**
   * Check current disclosure policy for data a Session may retain from imported owner files, such as a work report.
   * @param sessionId - The Session whose data would be disclosed.
   * @param workId - The assignment that produced the data.
   * @returns False when the Session may retain imported bytes and the current ceiling or either work grant forbids
   *   disclosure to the model or the owner; true otherwise, including after grant expiry.
   */
  disclosesImportedData(sessionId: SessionId, workId: WorkId | undefined): boolean {
    return !this.hasPossibleImport(sessionId) || this.permitsDisclosure(sessionId, workId)
  }

  /**
   * Resolve the immutable work grant for an already reserved delegation.
   * @param proposal - The exact stored handoff.
   * @param id - The reserved operation identity, or omitted before reservation.
   * @returns The work grant, or undefined for a delivery.
   */
  resolveDelegation(proposal: HandoffProposal, id?: OperationId): WorkGrant | undefined {
    const { handoff } = proposal
    if (handoff.kind === 'delivery') return undefined
    const { assistant, principalId } = this.grant
    const { delegation, targetSessionId } = handoff
    if (assistant === undefined || delegation === undefined) {
      throw new OperationControlError('handoff-denied', 'The delegation lacks an authorized work assignment.', id)
    }
    const { workId, previousWorkId } = delegation
    const previous = this.readWork(targetSessionId)
    if (previousWorkId !== (previous?.workId ?? null) || this.readWorkById(workId) !== undefined) {
      throw new OperationControlError('work-conflict', 'The delegation does not match the current work assignment.', id)
    }
    if (previous !== undefined && this.hasRunningOperation(previous.workId)) {
      throw new OperationControlError('work-busy', 'Wait for the prior work execution to stop before continuing.', id)
    }
    const root = assistant.permissions
    const data = intersectData(previous?.permissions.data, root.data)
    const ceiling = previous === undefined ? root : {
      exec: root.exec && previous.permissions.exec,
      brokerActions: previous.permissions.brokerActions.filter(action => root.brokerActions.includes(action)),
      ...(data === undefined ? {} : { data }),
    }
    if (previous === undefined && delegation.permissions === undefined) {
      throw new OperationControlError('work-permission-required', 'Fresh work must state its permissions.', id)
    }
    const permissions = delegation.permissions ?? ceiling
    if (!permissionSubset(permissions, ceiling)) {
      throw new OperationControlError('work-permission-denied', 'The requested permissions exceed the current work grant.', id)
    }
    const inputs = previous === undefined ? delegation.inputs : previous.inputs
    if (previous !== undefined && delegation.inputs !== undefined &&
      JSON.stringify(delegation.inputs) !== JSON.stringify(previous.inputs ?? [])) {
      throw new OperationControlError('work-input-conflict', 'A continuation must retain the exact input files of its work Session.', id)
    }
    if ((inputs?.length || (previous !== undefined && this.hasPossibleImport(targetSessionId))) && !canDisclose(permissions)) {
      throw new OperationControlError('work-disclosure-denied', 'Use a fresh work Session to change disclosure of its retained input files.', id)
    }
    if (previous === undefined && inputs?.length) {
      if (permissions.data?.import !== true) {
        throw new OperationControlError('work-permission-denied', 'This work grant does not permit importing its input files.', id)
      }
      if (inputs.some(input => input.bytes > (this.grant.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES))) {
        throw new OperationControlError('file-too-large', 'An input file exceeds the authority transfer limit.', id)
      }
    }
    return { workId, previousWorkId, principalId, sessionId: targetSessionId, permissions, ...(inputs === undefined ? {} : { inputs }) }
  }

  /**
   * Check whether a business operation's response text may be returned to its requesting script.
   * @param operation - The dispatched business operation.
   * @returns True without an Assistant grant; otherwise true only when the current ceiling and the operation's work grant
   *   both allow `returnResponses`.
   */
  returnsResponses(operation: Operation): boolean {
    const { assistant } = this.grant
    if (assistant === undefined) return true
    const work = operation.workId === undefined ? undefined : this.readWorkById(operation.workId)
    return assistant.permissions.data?.returnResponses === true && work?.permissions.data?.returnResponses === true
  }

  /** Release the SQLite lock after the authority has drained. */
  close(): void { this.db.close() }

  private authorize(proposal: OperationProposal, id?: OperationId): WorkGrant | undefined {
    const { assistant } = this.grant
    if ('handoff' in proposal) {
      const { targetSessionId, kind, delegation } = proposal.handoff
      if (assistant === undefined || proposal.sessionId !== assistant.mainSessionId ||
        (targetSessionId === assistant.mainSessionId) !== (kind === 'delivery') ||
        (delegation === undefined) !== (kind === 'delivery')) {
        throw new OperationControlError('handoff-denied', 'The operation grant does not allow this Assistant handoff.', id)
      }
      return undefined
    }
    if (assistant === undefined && 'file' in proposal) {
      throw new OperationControlError('work-not-authorized', 'A witnessed work grant is required for file transfer.', id)
    }
    if (assistant === undefined && this.hasPossibleImport(proposal.sessionId)) {
      throw new OperationControlError('work-disclosure-denied', 'This work Session retains imported files under a revoked disclosure grant.', id)
    }
    if (assistant === undefined || (proposal.sessionId === assistant.mainSessionId && 'modelRequest' in proposal)) return undefined
    const work = this.readWork(proposal.sessionId)
    if (work === undefined) {
      throw new OperationControlError('work-not-authorized', 'This Session has no witnessed work grant.', id)
    }
    if ('file' in proposal) {
      const { file } = proposal
      if (work.workId !== file.workId) {
        throw new OperationControlError('work-superseded', 'This transfer names an earlier work assignment.', id)
      }
      if (!canDisclose(assistant.permissions) || !canDisclose(work.permissions)) {
        throw new OperationControlError('work-disclosure-denied', 'The work grant must allow disclosure to its model and owner before transferring files.', id)
      }
      if (assistant.permissions.data?.[file.kind] !== true || work.permissions.data?.[file.kind] !== true) {
        throw new OperationControlError('work-permission-denied', 'The work grant does not permit this file transfer.', id)
      }
      if (file.kind === 'import') {
        if (!work.inputs?.some(input => JSON.stringify(input) === JSON.stringify(file.source))) {
          throw new OperationControlError('work-input-denied', 'This exact owner file was not granted to the work.', id)
        }
        if (file.source.bytes > (this.grant.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)) {
          throw new OperationControlError('file-too-large', 'The input file exceeds the authority transfer limit.', id)
        }
      } else if (file.targetSessionId !== assistant.mainSessionId) {
        throw new OperationControlError('work-recipient-denied', 'The file may be exported only to the owner entrance.', id)
      }
      return work
    }
    if (this.hasPossibleImport(proposal.sessionId) && (!canDisclose(assistant.permissions) || !canDisclose(work.permissions))) {
      throw new OperationControlError('work-disclosure-denied', 'This work Session retains imported files under a revoked disclosure grant.', id)
    }
    if (!('modelRequest' in proposal) && (!assistant.permissions.exec || !work.permissions.exec)) {
      throw new OperationControlError('work-permission-denied', 'This work grant does not permit shell execution.', id)
    }
    if ('business' in proposal) this.checkAction(work, proposal.business.action, id)
    return work
  }

  /**
   * Find the newest earlier business request under this grant with the same action that may have taken
   * effect: one that was not canceled before dispatch, not stopped by the broker before sending, and not confirmed succeeded or failed
   * by a witnessed lookup or owner determination. The whole database belongs to one principal and scope, so the match spans every
   * Session and work assignment.
   */
  private unresolvedRepeat({ action }: BusinessProposal['business']): OperationId | undefined {
    const rows = this.db.prepare(`SELECT record FROM operations WHERE ${BUSINESS}
      AND json_extract(record, '$.proposal.business.action') = ?
      AND ${OPERATION_STATE} <> 'canceled' AND json_extract(record, '$.outcome.kind') IS NOT 'business-not-sent'
      ORDER BY rowid DESC`).all(action)
    for (const row of rows) {
      const operation = this.decode(row)
      const attempt = this.latestReconciliation(operation)
      const confirmed = attempt?.receipt === undefined ? undefined : attempt.observation?.kind
      if (confirmed !== 'succeeded' && confirmed !== 'failed') return operation.id
    }
    return undefined
  }

  private checkWorkBinding(operation: Operation, work: WorkGrant | undefined): void {
    if (operation.workId !== work?.workId) {
      throw new OperationControlError('work-superseded', 'This operation is bound to an earlier work assignment.', operation.id)
    }
    if (work !== undefined && this.pendingDelegation(work, true) !== undefined) {
      throw new OperationControlError('work-busy', 'A continuation is awaiting release for this Session.', operation.id)
    }
  }

  private checkAction(work: WorkGrant, action: string, id?: OperationId): void {
    if (!work.permissions.brokerActions.includes(action) || !this.grant.assistant?.permissions.brokerActions.includes(action)) {
      throw new OperationControlError('work-permission-denied', 'This work grant does not permit the requested business action.', id)
    }
  }

  private readWork(sessionId: SessionId): WorkGrant | undefined {
    return this.readReleasedWork(WORK_SESSION, sessionId)
  }

  private readWorkById(workId: WorkGrant['workId']): WorkGrant | undefined {
    return this.readReleasedWork(WORK_ID, workId)
  }

  private readReleasedWork(column: typeof WORK_SESSION | typeof WORK_ID, value: string): WorkGrant | undefined {
    return this.access(() => {
      const row = this.db.prepare(`SELECT record FROM operations WHERE ${SETTLED_WORK} AND ${column} = ?
        ORDER BY rowid DESC LIMIT 1`).get(value)
      if (row === undefined) return undefined
      const operation = this.decode(row)
      if (operation.outcome?.kind !== 'released' || operation.outcome.work === undefined) {
        throw new Error('Work grant lacks its witnessed release')
      }
      return operation.outcome.work
    })
  }

  private pendingDelegation({ sessionId, workId }: WorkGrant, consumedOnly: boolean): OperationId | undefined {
    return this.access(() => {
      const row = this.db.prepare(`SELECT id FROM operations WHERE ${PENDING_DELEGATION}
        AND json_extract(record, '$.revision') = ? AND (${DELEGATION_SESSION} = ? OR ${DELEGATION_WORK_ID} = ?)
        AND (${OPERATION_STATE} IN ('running', 'pending-outcome-evidence')
          OR (? = 0 AND json_extract(record, '$.limitsRevision') IS ? AND json_extract(record, '$.rulesRevision') IS ?)) LIMIT 1`)
        .get(this.revision, sessionId, workId, Number(consumedOnly), this.ownerLimits?.receipt.digest ?? null,
          this.ownerRules?.receipt.digest ?? null)
      return row === undefined ? undefined : operationIdSchema.parse(row.id)
    })
  }

  private checkPendingDelegation(work: WorkGrant): void {
    const pending = this.pendingDelegation(work, false)
    if (pending !== undefined) {
      throw new OperationControlError('work-conflict', 'Another delegation is pending for this work or Session.', pending)
    }
  }

  private hasRunningOperation(workId: WorkGrant['workId']): boolean {
    return this.access(() => this.db.prepare(`SELECT 1 FROM operations
      WHERE json_extract(record, '$.workId') = ? AND ${OPERATION_STATE} = 'running' LIMIT 1`).get(workId) !== undefined)
  }

  private permitsDisclosure(sessionId: SessionId, workId: WorkId | undefined): boolean {
    const { assistant } = this.grant
    const current = this.readWork(sessionId)
    const original = workId === undefined ? undefined : current?.workId === workId ? current : this.readWorkById(workId)
    return assistant !== undefined && current !== undefined && original?.sessionId === sessionId &&
      canDisclose(assistant.permissions) && canDisclose(current.permissions) && canDisclose(original.permissions)
  }

  private hasPossibleImport(sessionId: SessionId): boolean {
    return this.access(() => this.db.prepare(`SELECT 1 FROM operations WHERE ${POSSIBLE_IMPORT}
      AND json_extract(record, '$.proposal.sessionId') = ? LIMIT 1`).get(sessionId) !== undefined)
  }

  private initialize(): void {
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version === 0) {
      this.db.exec(`
        CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK (id = 1), principal TEXT NOT NULL, scope TEXT NOT NULL, fingerprint TEXT NOT NULL, revision TEXT NOT NULL) STRICT;
        CREATE TABLE operations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, record TEXT NOT NULL) STRICT;
      `)
      // An empty fingerprint marks a store in which no configuration has taken effect.
      this.db.prepare('INSERT INTO authority VALUES (1, ?, ?, \'\', ?)').run(
        this.grant.principalId, this.grant.scopeId, digest(randomUUID()),
      )
    } else if (version === 1) {
      this.db.exec(`
        UPDATE operations SET record = json_set(
          json_remove(record, '$.commandDigest'), '$.payloadDigest', json_extract(record, '$.commandDigest')
        );
      `)
    } else if (version !== 2 && version !== 3 && version !== 4 && version !== 5 &&
      version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11 && version !== 12 &&
      version !== SCHEMA_VERSION) {
      throw new Error('The operation database uses an unsupported schema version')
    }
    if (version < 6) {
      this.db.exec(`
        CREATE INDEX operations_business_session ON operations (json_extract(record, '$.proposal.sessionId'))
          WHERE json_type(record, '$.proposal.business') = 'object';
        CREATE TABLE reconciliations (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, record TEXT NOT NULL) STRICT;
        CREATE INDEX reconciliations_operation ON reconciliations (operation_id);
      `)
    }
    if (version < 7) {
      this.db.exec(`
        CREATE UNIQUE INDEX operations_work_id ON operations (${WORK_ID}) WHERE ${SETTLED_WORK};
        CREATE INDEX operations_work_session ON operations (${WORK_SESSION}) WHERE ${SETTLED_WORK};
        CREATE INDEX operations_pending_delegation ON operations (${DELEGATION_SESSION}, ${DELEGATION_WORK_ID})
          WHERE ${PENDING_DELEGATION};
        CREATE INDEX operations_running_work ON operations (json_extract(record, '$.workId')) WHERE ${OPERATION_STATE} = 'running';
      `)
    }
    if (version < 8) {
      this.db.exec(`
        CREATE INDEX operations_imported_session ON operations (json_extract(record, '$.proposal.sessionId'))
          WHERE ${POSSIBLE_IMPORT};
      `)
    }
    if (version < 9) this.db.exec('ALTER TABLE authority ADD COLUMN owner_limits TEXT')
    if (version < 10) this.db.exec('ALTER TABLE authority ADD COLUMN owner_rules TEXT')
    if (version < 11) {
      // Only an unattended rule admits a business request without a recorded decision: it was reserved in
      // `pending-evidence`, or holds an admission receipt. A record canceled before admission stays unmarked.
      this.db.exec(`
        UPDATE operations SET record = json_set(record, '$.approval', 'unattended')
          WHERE ${BUSINESS} AND json_type(record, '$.approval') IS NULL
          AND (${OPERATION_STATE} = 'pending-evidence' OR json_type(record, '$.admission') = 'object');
      `)
    }
    if (version < 12) this.db.exec('ALTER TABLE authority ADD COLUMN configuration TEXT')
    if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    const owner = this.db.prepare(`SELECT principal, scope, fingerprint, revision, configuration, owner_limits, owner_rules
      FROM authority WHERE id = 1`).get()
    if (owner?.principal !== this.grant.principalId || owner.scope !== this.grant.scopeId) {
      throw new Error('The operation database belongs to a different principal or scope')
    }
    if (typeof owner.fingerprint !== 'string' || typeof owner.revision !== 'string') throw new Error('The operation grant revision is corrupt')
    const unchanged = owner.fingerprint === this.grant.fingerprint
    if (unchanged && owner.configuration !== null) {
      if (typeof owner.configuration !== 'string') throw new Error('The saved configuration record is corrupt')
      const record = configurationRecordSchema.parse(JSON.parse(owner.configuration))
      const event = this.configurationRecordEvent(record.previousRevision, owner.revision)
      if (record.receipt.id !== event.id || record.receipt.digest !== digestEvidenceEvent(event)) {
        throw new Error('The saved configuration lacks matching witness evidence')
      }
      this.revision = owner.revision
      this.configuration = record
    } else {
      // A store without a configuration record keeps its revision when the fingerprint is unchanged. The new revision
      // depends only on stored state, so a start that repeats an acknowledged but uncommitted record repeats its event ID.
      this.unrecorded = {
        previousRevision: owner.fingerprint === '' ? null : owner.revision,
        revision: unchanged ? owner.revision : digest(JSON.stringify([owner.revision, this.grant.fingerprint])),
      }
    }
    if (owner.owner_rules !== null) {
      if (typeof owner.owner_rules !== 'string') throw new Error('The saved unattended rules are corrupt')
      const rules = ownerRulesSchema.safeParse(JSON.parse(owner.owner_rules))
      if (!rules.success) throw new Error('The saved unattended rules are corrupt')
      this.verifyUnattendedRules(rules.data)
      this.ownerRules = rules.data
    }
    if (owner.owner_limits !== null) {
      if (typeof owner.owner_limits !== 'string') throw new Error('The saved grant limits are corrupt')
      const limits = ownerLimitsSchema.parse(JSON.parse(owner.owner_limits))
      this.verifyGrantLimits(limits)
      this.ownerLimits = limits
    }
    const interrupted = this.db.prepare("SELECT record FROM operations WHERE json_extract(record, '$.state') = 'running'").all()
    for (const row of interrupted) {
      const operation = this.decode(row)
      this.write({ ...operation, state: 'unknown', outcome: { kind: 'unknown', code: 'authority-interrupted' } })
    }
    const orphaned = this.db.prepare(`SELECT record FROM operations
      WHERE json_type(record, '$.proposal.business') = 'object'
      AND json_extract(record, '$.state') IN ('pending-approval', 'pending-evidence', 'issued')`).all()
    for (const row of orphaned) this.write({ ...this.decode(row), state: 'canceled' })
  }

  private decode(row: { record?: unknown }): Operation {
    if (typeof row.record !== 'string') throw new Error('Invalid operation database row')
    const operation = recordSchema.parse(JSON.parse(row.record))
    if (operation.principalId !== this.grant.principalId || operation.scopeId !== this.grant.scopeId ||
      operation.payloadDigest !== payloadDigest(operation.proposal)) throw new Error('Operation binding is corrupt')
    const { id, proposal, outcome, state, receipt, approval, admission, revoked } = operation
    if (((approval !== undefined || state === 'pending-approval') && !('command' in proposal || 'business' in proposal)) ||
      (state === 'pending-approval' &&
        (approval !== undefined || admission !== undefined || outcome !== undefined || receipt !== undefined || revoked !== undefined)) ||
      (approval === 'denied' && (state !== 'canceled' || admission !== undefined || outcome !== undefined || receipt !== undefined))) {
      throw new Error('Operation approval state is corrupt')
    }
    const kind = outcome?.kind
    if ((kind === 'exited' && !('command' in operation.proposal))
      || (kind === 'model-response' && !('modelRequest' in operation.proposal))) throw new Error('Operation observation is corrupt')
    if (outcome?.kind === 'business-response' || outcome?.kind === 'business-not-sent') {
      if (!('business' in proposal)) throw new Error('Business observation lacks a business request')
      if (state === 'settled') {
        const eventId = `${id}-outcome`
        const body = outcome.kind === 'business-response' ? businessResponseEvidence(outcome) : outcome
        const digest = digestEvidenceEvent({ id: eventId, operationId: id, kind: 'outcome', body })
        if (receipt?.id !== eventId || receipt.digest !== digest) throw new Error('Business observation lacks matching outcome evidence')
      } else if (state !== 'pending-outcome-evidence' || receipt !== undefined) {
        throw new Error('Business observation has an invalid state')
      }
    } else if ('business' in proposal && state === 'settled') {
      throw new Error('Settled business operation lacks its outcome')
    }
    if ('business' in proposal && outcome?.kind === 'unknown' && receipt !== undefined) {
      const event = { id: `${id}-outcome`, operationId: id, kind: 'outcome', body: outcome } as const
      if (receipt.id !== event.id || receipt.digest !== digestEvidenceEvent(event)) throw new Error('Unknown business observation lacks matching evidence')
    }
    if (outcome?.kind === 'file-imported' || outcome?.kind === 'file-exported') {
      if (!('file' in proposal) || proposal.file.workId !== operation.workId || outcome.workId !== operation.workId) {
        throw new Error('File observation lacks its work binding')
      }
      const { file } = proposal
      const matches = file.kind === 'import'
        ? outcome.kind === 'file-imported' && outcome.path === workInputPath(file.source) &&
          outcome.digest === file.source.attachmentId && outcome.bytes === file.source.bytes &&
          JSON.stringify(outcome.source) === JSON.stringify(file.source)
        : outcome.kind === 'file-exported' && 'contentBase64' in outcome && outcome.path === file.path &&
          outcome.targetSessionId === file.targetSessionId
      if (!matches) throw new Error('File observation does not match its proposal')
      if (state === 'settled') {
        if (receipt?.id !== `${id}-outcome` || receipt.digest !== fileReceiptDigest(id, outcome)) {
          throw new Error('File observation lacks matching outcome evidence')
        }
      } else if (state !== 'pending-outcome-evidence' || receipt !== undefined) {
        throw new Error('File observation has an invalid state')
      }
    } else if ('file' in proposal && state === 'settled') {
      throw new Error('Settled file transfer lacks its observation')
    }
    if (outcome?.kind === 'released') {
      if (!('handoff' in proposal)) throw new Error('Handoff release lacks a handoff proposal')
      const { delegation } = proposal.handoff
      const { work } = outcome
      if (work === undefined ? delegation !== undefined : delegation === undefined || proposal.handoff.kind !== 'delegation' ||
        work.workId !== delegation.workId || work.previousWorkId !== delegation.previousWorkId || work.workId === work.previousWorkId ||
        work.sessionId !== proposal.handoff.targetSessionId || work.principalId !== operation.principalId ||
        (delegation.permissions !== undefined && JSON.stringify(work.permissions) !== JSON.stringify(delegation.permissions)) ||
        (delegation.inputs !== undefined && JSON.stringify(work.inputs ?? []) !== JSON.stringify(delegation.inputs))) {
        throw new Error('Handoff release has an invalid work grant')
      }
      const expected = handoffOutcome(proposal.handoff, work)
      if (outcome.handoffKind !== expected.handoffKind || outcome.targetSessionId !== expected.targetSessionId ||
        outcome.contentDigest !== expected.contentDigest) throw new Error('Handoff release does not match its proposal')
      if (state === 'settled') {
        if (receipt?.id !== `${id}-outcome` || receipt.digest !== handoffReceiptDigest(id, expected)) {
          throw new Error('Handoff release lacks matching outcome evidence')
        }
      } else if (state !== 'pending-outcome-evidence' || receipt !== undefined) {
        throw new Error('Handoff release has an invalid state')
      }
    } else if ('handoff' in proposal && state === 'settled') {
      throw new Error('Settled handoff lacks a release')
    }
    if (operation.state === 'issued' && operation.admission === undefined) throw new Error('Issued operation lacks admission evidence')
    return operation
  }

  private checkCurrent(revision: string, expiresAt: number, id?: OperationId): void {
    if (revision !== this.revision) throw new OperationControlError('revision-mismatch', 'The operation grant revision changed.', id)
    if (Date.now() >= expiresAt) throw new OperationControlError('grant-expired', 'The operation grant has expired.', id)
  }

  private reservationCount(): number {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM operations').get()?.count
    if (typeof count !== 'number') throw new Error('Could not read the operation budget')
    return count
  }

  private write(operation: Operation): void {
    const result = this.db.prepare('UPDATE operations SET record = ? WHERE id = ?').run(JSON.stringify(operation), operation.id)
    if (result.changes !== 1) throw new Error('The operation record disappeared during its transition')
  }

  private transaction<T>(fn: () => T): T {
    return this.access(() => {
      this.db.exec('BEGIN EXCLUSIVE')
      try {
        const value = fn()
        this.db.exec('COMMIT')
        return value
      } catch (error: unknown) {
        if (this.db.isTransaction) {
          try { this.db.exec('ROLLBACK') }
          catch (rollback: unknown) { throw new AggregateError([error, rollback], 'Operation state could not roll back') }
        }
        throw error
      }
    })
  }

  private access<T>(fn: () => T): T {
    if (this.failed !== undefined) throw this.failed
    try {
      return fn()
    } catch (error: unknown) {
      if (error instanceof OperationControlError) throw error
      this.failed = new OperationControlError(
        'storage-unavailable', 'Operation state is unavailable. Inspect the authority database before restarting.', undefined, { cause: error },
      )
      throw this.failed
    }
  }
}
