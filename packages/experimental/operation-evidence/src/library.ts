/**
 * Witness access for callers outside the Loader: the socket client, the event digest that its receipts carry, and the
 * socket preparation shared by every operation service.
 * @module @deepseek-ai/dsh-operation-evidence/library
 */
export { EvidenceClient, type EvidenceClientOptions } from './client.ts'
export { digestEvidenceEvent } from './protocol.ts'
export { prepareOperationSocket } from './socket.ts'
