/**
 * Isolated execution parts for the operation authority outside the Loader: the exec tool, its observation text, and the
 * workspace transfer rules.
 * @module @deepseek-ai/dsh-execution-container/library
 */
export { createExecTool, renderExecutionObservation } from './tool.ts'
export { isWorkspaceTransferPath, MAX_WORKSPACE_TRANSFER_BYTES } from './workspace-transfer.ts'
