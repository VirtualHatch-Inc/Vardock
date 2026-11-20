/** Unix socket client for an independently administered evidence service. */
import { request, type IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_REQUEST_BYTES, DEFAULT_TIMEOUT_MS, EvidenceError, MAX_REQUEST_BYTES, MAX_SOCKET_BYTES, MIN_REQUEST_BYTES,
  EVIDENCE_PAGE_SIZE, encodeEvent, evidenceDigest, pageOf, readJson, receiptOf, recordOf, validId,
  type EvidenceEvent, type EvidencePage, type EvidenceReceipt, type EvidenceRecord,
} from './protocol.ts'

/** Client connection and message limits. */
export interface EvidenceClientOptions {
  socketPath: string
  timeoutMs?: number
  maxRequestBytes?: number
}

/** Appends or reads witness facts without opening the witness database. */
export class EvidenceClient {
  private readonly timeoutMs: number
  private readonly maxRequestBytes: number
  private readonly socketPath: string

  /** @param options - operator-selected witness endpoint and bounded request settings. */
  constructor(options: EvidenceClientOptions) {
    const { socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, maxRequestBytes = DEFAULT_REQUEST_BYTES } = options
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > MAX_SOCKET_BYTES
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS
      || !Number.isInteger(maxRequestBytes) || maxRequestBytes < MIN_REQUEST_BYTES || maxRequestBytes > MAX_REQUEST_BYTES) {
      throw new EvidenceError('invalid', 'Configure an absolute evidence socket path and bounded request limits.')
    }
    this.socketPath = socketPath
    this.timeoutMs = timeoutMs
    this.maxRequestBytes = maxRequestBytes
  }

  /**
   * Commit an event or return the receipt for the identical event already committed under its id.
   * @param event - immutable fact with a stable retry key.
   * @param signal - optional cancellation. Cancellation after submission can leave the outcome unknown.
   * @returns The durable receipt. An unknown outcome may be resolved with get or by repeating the identical append.
   */
  async append(event: EvidenceEvent, signal?: AbortSignal): Promise<EvidenceReceipt> {
    const body = encodeEvent(event)
    if (Buffer.byteLength(body) > this.maxRequestBytes) {
      throw new EvidenceError('invalid', 'The evidence event exceeds the configured byte limit.')
    }
    const reply = await this.call('POST', '/events', signal, body)
    try {
      const receipt = receiptOf(reply, event.id)
      if (receipt.digest === evidenceDigest(body)) return receipt
      throw new Error('The receipt digest differs from the submitted event digest.')
    } catch (cause) {
      throw new EvidenceError('unknown', 'Evidence may have committed. Read its id or repeat the identical append.', { cause })
    }
  }

  /**
   * Read one committed event.
   * @param id - event idempotency key.
   * @param signal - optional cancellation.
   * @returns The committed record, or undefined when the service confirms the id is absent.
   */
  async get(id: string, signal?: AbortSignal): Promise<EvidenceRecord | undefined> {
    if (!validId(id)) throw new EvidenceError('invalid', 'Provide a valid evidence id.')
    const reply = await this.call('GET', `/events/${id}`, signal)
    if (reply === undefined) return undefined
    try {
      return recordOf(reply, id)
    } catch (cause) {
      throw new EvidenceError('unavailable', 'The evidence service returned an unreadable record.', { cause })
    }
  }

  /**
   * Read one page of committed records in commit order. Reading changes nothing in the witness.
   * @param after - `next` of the previous page, or 0 for the first page.
   * @param signal - optional cancellation.
   * @returns Up to {@link EVIDENCE_PAGE_SIZE} records whose digests match their events, and the position of the following page.
   */
  async list(after: number, signal?: AbortSignal): Promise<EvidencePage> {
    const reply = await this.call('GET', `/events?after=${after}`, signal, undefined, EVIDENCE_PAGE_SIZE)
    try {
      return pageOf(reply)
    } catch (cause) {
      throw new EvidenceError('unavailable', 'The evidence service returned an unreadable page.', { cause })
    }
  }

  private async call(
    method: 'GET' | 'POST', path: string, signal: AbortSignal | undefined, body?: string, records = 1,
  ): Promise<unknown> {
    if (signal?.aborted) throw new EvidenceError('unavailable', 'The evidence request was cancelled before submission.', { cause: signal.reason })
    using limit = deadline(signal, this.timeoutMs, 'EVIDENCE_TIMEOUT')
    let response: IncomingMessage
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request({
          socketPath: this.socketPath, method, path, agent: false, signal: limit.signal,
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }),
        }, resolve)
        req.once('error', reject)
        req.end(body)
      })
    } catch (cause) {
      throw this.transportError(method, cause)
    }
    try {
      switch (response.statusCode) {
        case 200:
          try {
            return await readJson(response, records * (this.maxRequestBytes + 256))
          } catch (cause) {
            throw this.transportError(method, cause)
          }
        case 404: if (method === 'GET') return undefined; break
        case 400: throw new EvidenceError('invalid', 'The evidence service refused the event or request.')
        case 413: throw new EvidenceError('invalid', 'The evidence message exceeds the service byte limit.')
        case 409: throw new EvidenceError('conflict', 'The evidence id already belongs to a different event.')
        default: throw this.transportError(method)
      }
      throw this.transportError(method)
    } finally {
      response.destroy()
    }
  }

  private transportError(method: 'GET' | 'POST', cause?: unknown): EvidenceError {
    return method === 'POST'
      ? new EvidenceError('unknown', 'Evidence may have committed. Read its id or repeat the identical append.', { cause })
      : new EvidenceError('unavailable', 'Could not read the evidence service. Check its socket and service status.', { cause })
  }
}
