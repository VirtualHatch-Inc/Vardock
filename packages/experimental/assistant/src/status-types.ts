/** Browser-safe types for Assistant owner status reads. */
import type { OperationId as AuthorityOperationId, WorkId as AuthorityWorkId } from '@deepseek-ai/dsh-operation-control/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkPhase } from './work-phase.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'assistant/work-unavailable': { readonly reason: string }
  }
}

export type {
  BrokerConnections, BrokerConnectionUpdate, BusinessResolution, BusinessRecords, OperationGrantBudget, OperationGrantUpdate,
} from '@deepseek-ai/dsh-operation-control/types'

export type { WorkPhase } from './work-phase.ts'

/** Authority operation addressed by the Assistant owner interface. */
export type OperationId = AuthorityOperationId

/** Work assignment addressed by the Assistant owner interface. */
export type WorkId = AuthorityWorkId

/** One read-only authority observation, including an independently unavailable authority. */
export type AuthorityStatus<T> = { kind: 'available'; value: T } | { kind: 'unavailable'; code: string }

interface BusinessEffect {
  readonly id: OperationId
  readonly action: string
  readonly dispatch: 'queued' | 'running' | 'pending-approval' | 'not-sent' | 'unconfirmed'
  readonly completion: 'unconfirmed' | 'pending' | 'succeeded' | 'failed'
  readonly receiptId?: string
  readonly canReconcile: boolean
  /** The authority sent the request under an operator rule without a human decision. */
  readonly unattended: boolean
}

interface AuthoritySummary {
  readonly pendingApprovals: number
  readonly unknown: number
  readonly lastFailure?: { readonly id: OperationId; readonly code: string }
}

/** Grant status for the entrance, including expired and exhausted grants. */
export interface OperationBudget extends AuthoritySummary {
  readonly expiresAt: number
  readonly expired: boolean
  readonly maxOperations: number
  readonly reserved: number
  readonly remaining: number
}

/** Authority status scoped to the exact work assignment. */
export interface WorkOperations extends AuthoritySummary {
  readonly businessCompletion: {
    readonly pending: number
    readonly unconfirmed: number
    readonly succeeded: number
    readonly failed: number
  }
  readonly business: readonly BusinessEffect[]
  readonly truncated: boolean
}

interface WorkStatus {
  readonly id: WorkId
  readonly sessionId: SessionId
  readonly prompt: string
  readonly status: WorkPhase
  readonly result: string | null
  readonly inspectable: boolean
  readonly artifacts?: readonly { readonly name: string; readonly bytes: number; readonly digest: string }[]
  readonly operations?: AuthorityStatus<WorkOperations>
}

/** Retained work and authority observations readable independently of model turns. */
export interface WorkStatusSnapshot {
  readonly refreshMs: number
  readonly authority: AuthorityStatus<OperationBudget>
  readonly work: readonly WorkStatus[]
}
