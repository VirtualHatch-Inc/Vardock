/** Browser-safe operation and work identities and grant settings types. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Authority-issued identity of one durable operation. */
export type OperationId = Branded<'OperationId'>

/** Identity of one Assistant work request, including a continuation. */
export type WorkId = Branded<'AssistantWorkId'>

export type { BrokerConnections, BrokerConnectionUpdate, BusinessResolution, BusinessRecords, OperationGrantBudget, OperationGrantUpdate } from './protocol.ts'
