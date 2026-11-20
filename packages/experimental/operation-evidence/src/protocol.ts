/** Wire records and canonical encoding for the execution witness. */
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

/** Default server and client request budget. */
export const DEFAULT_TIMEOUT_MS = 5_000
/** Default append body size limit in bytes. */
export const DEFAULT_REQUEST_BYTES = 65_536
/** Largest configurable append body size. */
export const MAX_REQUEST_BYTES = 1_048_576
/** Smallest configurable append body size. */
export const MIN_REQUEST_BYTES = 256
/** Portable Unix pathname limit across supported POSIX hosts. */
export const MAX_SOCKET_BYTES = 103
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Lossless JSON payload retained in a witness event. */
export type EvidenceJson = JsonValue

/** An immutable fact supplied by the authenticated execution broker. */
export interface EvidenceEvent {
  /** Caller-selected idempotency key for this fact. */
  id: string
  /** Correlation identifier assigned by the execution broker. */
  operationId: string
  /** Phase of the operation attested by the broker. */
  kind: 'admission' | 'outcome' | 'revocation'
  /** Fact-specific data. */
  body: EvidenceJson
}

/** Identity and SHA-256 digest of a durably committed event. */
export interface EvidenceReceipt {
  id: string
  digest: string
}

/** A previously committed event and its receipt. */
export interface EvidenceRecord {
  event: EvidenceEvent
  receipt: EvidenceReceipt
}

/** Machine-readable witness failure. An unknown append may have committed. */
export class EvidenceError extends Error {
  override name = 'EvidenceError'

  /**
   * @param code - whether input was invalid, its key conflicts, the read was unavailable, or an append may have committed.
   * @param message - actionable diagnostic for the caller.
   * @param options - local transport or storage failure, when available.
   */
  constructor(readonly code: 'invalid' | 'conflict' | 'unavailable' | 'unknown', message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Check the wire identifier syntax shared by evidence and operation keys.
 * @param value - candidate identifier.
 * @returns Whether the identifier can be carried as a literal URL path segment.
 */
export function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate an append request.
 * @param value - parsed request JSON.
 * @returns The fields the witness commits.
 */
export function eventOf(value: unknown): EvidenceEvent {
  if (!object(value) || Object.keys(value).length !== 4 || !validId(value.id) || !validId(value.operationId)
    || (value.kind !== 'admission' && value.kind !== 'outcome' && value.kind !== 'revocation')
    || !isJsonValue(value.body)) {
    throw new EvidenceError('invalid', 'Provide an evidence id, operation id, event kind and JSON body.')
  }
  return { id: value.id, operationId: value.operationId, kind: value.kind, body: value.body as EvidenceJson }
}

/**
 * Validate the receipt for a particular event.
 * @param value - parsed response JSON.
 * @param id - expected event identity.
 * @returns A validated receipt.
 */
export function receiptOf(value: unknown, id: string): EvidenceReceipt {
  if (!object(value) || Object.keys(value).length !== 2 || value.id !== id
    || typeof value.digest !== 'string' || !DIGEST.test(value.digest)) {
    throw new EvidenceError('invalid', 'The evidence service returned an invalid receipt.')
  }
  return { id, digest: value.digest }
}

/**
 * Validate a previously committed event and its digest.
 * @param value - parsed response JSON.
 * @param id - expected event identity.
 * @returns The validated record.
 */
export function recordOf(value: unknown, id: string): EvidenceRecord {
  if (!object(value) || Object.keys(value).length !== 2) {
    throw new EvidenceError('invalid', 'The evidence service returned an invalid record.')
  }
  const event = eventOf(value.event)
  const receipt = receiptOf(value.receipt, id)
  if (event.id !== id || evidenceDigest(encodeEvent(event)) !== receipt.digest) {
    throw new EvidenceError('invalid', 'The evidence record does not match its receipt.')
  }
  return { event, receipt }
}

/** Number of records in one page of the commit-order listing. */
export const EVIDENCE_PAGE_SIZE = 50

/** One page of committed records in commit order. */
export interface EvidencePage {
  records: EvidenceRecord[]
  /** Position to pass for the following page. Absent after the last committed record. */
  next?: number
}

/**
 * Validate one page of committed records, including each record's digest.
 * @param value - parsed response JSON.
 * @returns The validated page.
 */
export function pageOf(value: unknown): EvidencePage {
  if (!object(value) || !Array.isArray(value.records) || (value.next !== undefined && !Number.isSafeInteger(value.next))) {
    throw new EvidenceError('invalid', 'The evidence service returned an invalid page.')
  }
  const records = value.records.map((record: unknown) => {
    const id: unknown = object(record) && object(record.receipt) ? record.receipt.id : undefined
    if (!validId(id)) throw new EvidenceError('invalid', 'The evidence service returned an invalid page.')
    return recordOf(record, id)
  })
  return { records, ...value.next === undefined ? {} : { next: value.next as number } }
}

/**
 * Serialize one event with deterministic object-key ordering.
 * @param event - fact to encode.
 * @returns The UTF-8 JSON text used for idempotency and hashing.
 */
export function encodeEvent(event: EvidenceEvent): string {
  try {
    return JSON.stringify(event, (_key, value: unknown) => object(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
      : value)
  } catch (cause) {
    throw new EvidenceError('invalid', 'The evidence event exceeds JSON encoding limits.', { cause })
  }
}

/**
 * Compute the digest of canonical evidence text.
 * @param text - canonical encoded event.
 * @returns The lowercase hexadecimal SHA-256 digest.
 */
export function evidenceDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Derive the digest the witness returns for an immutable event.
 * @param event - The complete fact submitted to the witness.
 * @returns The lowercase hexadecimal SHA-256 digest of its canonical encoding.
 */
export function digestEvidenceEvent(event: EvidenceEvent): string {
  return evidenceDigest(encodeEvent(event))
}

/** A wire body exceeded its receiver's byte limit. */
export class MessageLimitError extends EvidenceError {
  constructor() {
    super('invalid', 'The evidence message exceeds the configured byte limit.')
  }
}

/**
 * Read a bounded UTF-8 JSON body without taking ownership of its stream.
 * @param stream - incoming HTTP body.
 * @param maxBytes - maximum allowed byte count.
 * @returns The parsed JSON for caller-owned schema validation.
 */
export async function readJson(stream: Readable, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  // The caller owns the socket and decides how to settle an oversized message.
  for await (const chunk of stream.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new MessageLimitError()
    chunks.push(chunk)
  }
  try {
    return JSON.parse(utf8.decode(Buffer.concat(chunks, bytes)))
  } catch (cause) {
    throw new EvidenceError('invalid', 'Provide a UTF-8 JSON evidence message.', { cause })
  }
}
