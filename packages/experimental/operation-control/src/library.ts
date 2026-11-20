/**
 * Operation authority access for callers outside the Loader: the socket client and the check of the authority's
 * receipts against the witness records.
 * @module @deepseek-ai/dsh-operation-control/library
 */
export { OperationControlClient } from './client.ts'
export type {
  BusinessOperations, BusinessOperationStatus, OperationApprovalDecision, OperationApprovalReview, OperationControlClientOptions,
  BrokerConnections, BrokerConnectionUpdate, BusinessResolution, BusinessRecords, OperationGrantBudget, OperationGrantUpdate,
  OperationId, OperationOutcome, OperationOverview, OperationProposal, OperationStatus,
  ExportedFile, FileOutcome, FileProposal, FileTransferReceipt, WorkDelegation, WorkGrant, WorkId, WorkInputFile, WorkPermissions,
} from './client.ts'
export { verifyRecords, type RecordProblem, type RecordVerification } from './verify.ts'
