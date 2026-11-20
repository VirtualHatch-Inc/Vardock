/** Owner status records derived from the durable coordinator and the operation authority. */
import { OperationControlError, type BusinessOperationStatus, type HandoffControl } from '@deepseek-ai/dsh-operation-control/handoff'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Work } from './state.ts'
import type { AuthorityStatus, OperationBudget, OperationId, WorkOperations } from './status-types.ts'

async function authorityStatus<T>(read: Promise<T>, signal: AbortSignal): Promise<AuthorityStatus<T>> {
  try {
    return { kind: 'available', value: await read }
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (!(error instanceof OperationControlError)) throw error
    return { kind: 'unavailable', code: error.code }
  }
}

/**
 * Read the owner-visible budget independently of retained work.
 * @param authority - configured Host authority service.
 * @param sessionId - configured entrance Session.
 * @param signal - status read lifetime.
 * @returns Current budget and authority issues, including after grant expiry.
 */
export function readBudget(
  authority: HandoffControl, sessionId: SessionId, signal: AbortSignal,
): Promise<AuthorityStatus<OperationBudget>> {
  const budget = authority.overview(sessionId, signal).then(({
    expiresAt, expired, maxOperations, reserved, remaining, pendingApprovals, unknown, lastFailure,
  }) => ({ expiresAt, expired, maxOperations, reserved, remaining, pendingApprovals, unknown,
    ...(lastFailure === undefined ? {} : { lastFailure }),
  }))
  return authorityStatus(budget, signal)
}

function dispatchStatus({ state, outcome, businessCompletion }: BusinessOperationStatus): WorkOperations['business'][number]['dispatch'] {
  if (state === 'canceled' || outcome?.kind === 'business-not-sent') return 'not-sent'
  if (businessCompletion.kind === 'unconfirmed' && businessCompletion.code === 'revision-mismatch'
    && (state === 'pending-approval' || state === 'pending-evidence' || state === 'issued')) return 'not-sent'
  if (state === 'pending-approval' || state === 'running') return state
  if (state === 'pending-evidence' || state === 'issued') return 'queued'
  return 'unconfirmed'
}

/**
 * Inspect one assignment, keeping effects of older assignments in their own work rows.
 * @param authority - configured Host authority service.
 * @param work - retained work request.
 * @param signal - status read lifetime.
 * @returns Scoped counts and newest business operations. Legacy work may have no authority grant.
 */
export function readWorkAuthority(
  authority: HandoffControl, work: Work, signal: AbortSignal,
): Promise<AuthorityStatus<WorkOperations>> | undefined {
  const grant = work.authorization?.grant
  if (grant === undefined) return undefined
  return authorityStatus((async (): Promise<WorkOperations> => {
    const { pendingApprovals, unknown, businessCompletion, lastFailure } = await authority.overview(work.sessionId, signal, work.id)
    const page = grant.permissions.brokerActions.length > 0
      ? await authority.businessOperations(work.sessionId, signal, undefined, work.id) : undefined
    return {
      pendingApprovals, unknown, businessCompletion, ...(lastFailure === undefined ? {} : { lastFailure }),
      business: page?.operations.map((operation) => {
        const { id, action, canReconcile, businessCompletion: completion, approval, state } = operation
        return { id, action, dispatch: dispatchStatus(operation), canReconcile, completion: completion.kind,
          unattended: approval === 'unattended' && state !== 'canceled',
          ...('receiptId' in completion ? { receiptId: completion.receiptId } : {}),
        }
      }) ?? [],
      truncated: page?.next !== undefined,
    }
  })(), signal)
}

/**
 * List the business operations of one assignment whose outcome is unresolved: they may have been sent, and no witnessed
 * lookup or owner determination confirmed that they succeeded or failed.
 * @param authority - configured Host authority service.
 * @param work - retained work request.
 * @param signal - read lifetime.
 * @returns Every unresolved operation, or the authority's error code when it could not be read.
 */
export function readUnresolvedBusiness(
  authority: HandoffControl, work: Work, signal: AbortSignal,
): Promise<AuthorityStatus<OperationId[]>> {
  if ((work.authorization?.grant.permissions.brokerActions.length ?? 0) === 0) return Promise.resolve({ kind: 'available', value: [] })
  return authorityStatus((async () => {
    const unresolved: OperationId[] = []
    let after: OperationId | undefined
    do {
      const page = await authority.businessOperations(work.sessionId, signal, after, work.id)
      for (const operation of page.operations) {
        const { kind } = operation.businessCompletion
        if (dispatchStatus(operation) !== 'not-sent' && kind !== 'succeeded' && kind !== 'failed') unresolved.push(operation.id)
      }
      after = page.next
    } while (after !== undefined)
    return unresolved
  })(), signal)
}
