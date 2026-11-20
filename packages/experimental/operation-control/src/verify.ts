/**
 * Compare the witness's committed events with the receipts the authority holds for the same operations, and the
 * authority's receipt of its configuration record with the witness's event. Its first privileged request finalizes an
 * unconfirmed configuration record once the witness confirms it; otherwise the comparison changes nothing.
 *
 * @module
 */
import type { EvidenceReceipt } from '@deepseek-ai/dsh-operation-evidence'
import type { EvidenceClient } from '@deepseek-ai/dsh-operation-evidence/library'
import type { OperationControlClient } from './client.ts'
import { MAX_RECEIPT_LOOKUP, operationIdSchema, type OperationId, type OperationReceipts } from './protocol.ts'

/** One witness event the authority's records do not account for, or the configuration record the witness lacks. */
export interface RecordProblem {
  /** Witness event ID. */
  readonly eventId: string
  /**
   * `operation-missing`: the authority has no record of the operation. `receipt-missing`: the authority has the operation
   * but not this receipt, which also happens when the authority stopped between the witness's acknowledgment and its own
   * commit. `digest-mismatch`: the authority's receipt names different content. `event-missing`: the witness has no
   * event for the authority's receipt of its configuration record.
   */
  readonly problem: 'operation-missing' | 'receipt-missing' | 'digest-mismatch' | 'event-missing'
}

/** Result of one comparison. */
export interface RecordVerification {
  /** Witness events read. Each event's digest matched its content when it was read. */
  readonly events: number
  /** Admission, outcome, and revocation events and the current configuration record compared with an authority receipt. */
  readonly compared: number
  /** Other events about settings and lookups, which no authority receipt covers. They are counted and not compared. */
  readonly other: number
  /** Compared events the authority's records do not account for, in commit order, then any configuration record problem. */
  readonly problems: readonly RecordProblem[]
}

/**
 * Read every witness event and compare each operation event and the current configuration record with the authority's
 * receipt for it.
 * @param approver - Client of the authority's approval socket.
 * @param evidence - Client of the witness socket.
 * @param signal - Cancels the reads.
 * @returns Counts and every operation event the authority's records do not account for.
 * @throws When either service cannot be read, the witness returns a record whose digest does not match its event, or a
 *   witness page's `next` does not advance past the position it was read after.
 */
export async function verifyRecords(
  approver: Pick<OperationControlClient, 'grant' | 'receipts'>, evidence: Pick<EvidenceClient, 'list'>, signal?: AbortSignal,
): Promise<RecordVerification> {
  const problems: RecordProblem[] = []
  const { configuration } = await approver.grant(signal)
  let witnessedConfiguration: EvidenceReceipt | undefined
  let events = 0
  let compared = 0
  let other = 0
  for (let after: number | undefined = 0; after !== undefined;) {
    const page = await evidence.list(after, signal)
    if (page.next !== undefined && page.next <= after) {
      throw new Error(`The witness returned page position ${page.next} after position ${after}, so the comparison cannot advance.`)
    }
    after = page.next
    events += page.records.length
    witnessedConfiguration ??= page.records.find(({ receipt }) => receipt.id === configuration.id)?.receipt
    const operations = page.records.flatMap(({ event, receipt }) => {
      if (receipt.id === configuration.id) return []
      const id = operationIdSchema.safeParse(event.operationId)
      const linked = id.success && event.id === `${event.operationId}-${event.kind}`
      if (!linked) other++
      return linked ? [{ id: id.data, kind: event.kind, receipt }] : []
    })
    const held = new Map<OperationId, OperationReceipts['receipts'][number]>()
    const ids = [...new Set(operations.map(({ id }) => id))]
    for (let start = 0; start < ids.length; start += MAX_RECEIPT_LOOKUP) {
      const reply = await approver.receipts(ids.slice(start, start + MAX_RECEIPT_LOOKUP), signal)
      for (const receipts of reply.receipts) held.set(receipts.id, receipts)
    }
    for (const { id, kind, receipt } of operations) {
      compared++
      const receipts = held.get(id)
      const recorded = receipts?.[kind]
      if (receipts === undefined) problems.push({ eventId: receipt.id, problem: 'operation-missing' })
      else if (recorded?.id !== receipt.id) problems.push({ eventId: receipt.id, problem: 'receipt-missing' })
      else if (recorded.digest !== receipt.digest) problems.push({ eventId: receipt.id, problem: 'digest-mismatch' })
    }
  }
  if (witnessedConfiguration === undefined) problems.push({ eventId: configuration.id, problem: 'event-missing' })
  else if (witnessedConfiguration.digest !== configuration.digest) problems.push({ eventId: configuration.id, problem: 'digest-mismatch' })
  return { events, compared: compared + 1, other, problems }
}
