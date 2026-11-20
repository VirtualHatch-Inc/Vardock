/**
 * Broker value checks for callers outside the Loader, such as the operation authority.
 * @module @deepseek-ai/dsh-operation-broker/library
 */
import type { BrokerReceiptId } from './index.ts'

const BEARER = /^[a-zA-Z0-9._~+/-]+=*$/u
const RECEIPT_ID = /^[a-zA-Z0-9._~-]{1,128}$/u

/**
 * Check a bearer token before storing or sending it.
 * @param value - Candidate token text.
 * @returns Whether the text is a valid HTTP bearer token.
 */
export function isBearerToken(value: string): boolean {
  return BEARER.test(value)
}

/**
 * Check the length and character set of an upstream receipt ID.
 * @param value - Candidate receipt identity from JSON or storage.
 * @returns Whether the value is a valid receipt identity.
 */
export function isBrokerReceiptId(value: unknown): value is BrokerReceiptId {
  return typeof value === 'string' && RECEIPT_ID.test(value)
}
