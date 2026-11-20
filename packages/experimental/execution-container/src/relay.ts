/**
 * Broker requests carried over the standard streams of one guest command, for guests with no network device and no
 * Host socket. The guest relay is untrusted: the Host pump validates every line and replays each request to the
 * execution gateway, which authenticates and bounds it like a request on its own socket.
 */
import { request } from 'node:http'
import type { Readable, Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { BUSINESS_ROUTE, MAX_BROKER_REQUEST_BYTES } from './gateway.ts'

/** Longest authorization header value the relay forwards. A longer value is forwarded as absent. */
const MAX_AUTHORIZATION_LENGTH = 128
/** Longest relay line the Host accepts: a base64 request body plus fixed JSON framing. */
const MAX_RELAY_LINE_BYTES = Math.ceil(MAX_BROKER_REQUEST_BYTES / 3) * 4 + 1024

/**
 * Guest program for `node -e`; arguments are the loopback port, the request byte limit, and the in-flight request
 * limit. It writes `{"ready":true}` once listening, then one line per request: `{"id","authorization","body"}` with a
 * base64 body, or `{"id","cancel":true}` when the client disconnects after its request line. It answers from Host lines
 * `{"id","status","body"}`, where a null status closes the client connection. A cancelled id keeps its request slot until
 * the Host's line for it arrives, so the relay and the Host count the same outstanding requests. When its stdin ends, the
 * Host is gone: it answers every pending request with 502, stops listening, and exits.
 */
export const RELAY_SCRIPT = String.raw`
const http = require('node:http')
const [port, maxBytes, maxRequests] = process.argv.slice(1).map(Number)
const pending = new Map()
let next = 0
const send = message => { process.stdout.write(JSON.stringify(message) + '\n') }
const reply = (response, status, type, body) => {
  if (response.destroyed) return
  response.writeHead(status, { connection: 'close', 'content-type': type })
  response.end(body)
}
const server = http.createServer((request, response) => {
  if (request.url !== '${BUSINESS_ROUTE}' || request.method !== 'POST') {
    reply(response, 405, 'text/plain', 'Send business requests with POST to ${BUSINESS_ROUTE}.\n')
    return
  }
  if (closed) {
    fail(response)
    return
  }
  if (pending.size >= maxRequests) {
    request.socket.destroy()
    return
  }
  const id = next++
  const chunks = []
  let size = 0
  let forwarded = false
  pending.set(id, response)
  response.once('close', () => {
    if (pending.get(id) !== response) return
    if (!forwarded) {
      pending.delete(id)
      return
    }
    // The slot stays taken until the Host answers this id.
    pending.set(id, null)
    send({ id, cancel: true })
  })
  request.on('data', chunk => {
    size += chunk.length
    if (size <= maxBytes) chunks.push(chunk)
  })
  request.on('end', () => {
    if (closed) return
    if (size > maxBytes) {
      pending.delete(id)
      reply(response, 413, 'application/json', '{"error":"Business request exceeds the byte limit."}')
      return
    }
    const authorization = request.headers.authorization
    forwarded = true
    send({
      id,
      authorization: typeof authorization === 'string' && authorization.length <= ${MAX_AUTHORIZATION_LENGTH} ? authorization : null,
      body: Buffer.concat(chunks).toString('base64'),
    })
  })
})
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  let end
  while ((end = buffered.indexOf('\n')) >= 0) {
    const { id, status, body } = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    const response = pending.get(id)
    if (response === undefined) continue
    pending.delete(id)
    if (response === null) continue
    if (status === null) response.destroy()
    else reply(response, status, 'application/json', body)
  }
})
let closed = false
const fail = response => {
  reply(response, 502, 'application/json', '{"error":"Business request could not be completed."}')
}
process.stdin.on('end', () => {
  closed = true
  for (const response of pending.values()) if (response !== null) fail(response)
  pending.clear()
  server.close(() => { process.exit(0) })
  server.closeIdleConnections()
})
server.listen(port, '127.0.0.1', () => { send({ ready: true }) })
`

/** Host side of one relay command: its stdout, its stdin, and a way to end it. */
export interface RelayStreams {
  /** The relay's stdout. */
  readonly input: Readable
  /** The relay's stdin. */
  readonly output: Writable
  /** Terminate the relay command. Idempotent. */
  stop(): void
}

/** The execution gateway that authenticates and bounds replayed requests. */
export interface RelayGateway {
  /** Host Unix socket of the execution gateway. */
  readonly socketPath: string
  /** Most requests one relay may have in flight; the gateway's connection limit. */
  readonly maxConnections: number
}

/** Readiness and settlement of one relay pump. */
export interface RelayPump {
  /** Resolves on the relay's readiness line; rejects when the relay ends or violates the protocol first. Await it. */
  readonly ready: Promise<void>
  /** Resolves after the relay's output ended and every replayed request settled. Never rejects. */
  readonly done: Promise<void>
}

/** A relay line that breaks the protocol. The pump stops the relay after reporting it. */
export class RelayProtocolError extends Error {
  override readonly name = 'RelayProtocolError'
}

interface RelayRequest {
  readonly id: number
  readonly authorization: string | null
  readonly body: Buffer
}

type RelayLine = { readonly kind: 'ready' } | { readonly kind: 'cancel'; readonly id: number } | ({ readonly kind: 'request' } & RelayRequest)

function parseLine(line: string): RelayLine {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (cause) {
    throw new RelayProtocolError('The broker relay sent a line that is not JSON.', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RelayProtocolError('The broker relay sent a non-object line.')
  const fields = new Map<string, unknown>(Object.entries(value))
  const id = fields.get('id')
  if (fields.size === 1 && fields.get('ready') === true) return { kind: 'ready' }
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 0) throw new RelayProtocolError('The broker relay sent an invalid request id.')
  if (fields.size === 2 && fields.get('cancel') === true) return { kind: 'cancel', id }
  const authorization = fields.get('authorization')
  const body = fields.get('body')
  if (fields.size !== 3 || typeof body !== 'string'
    || (authorization !== null && (typeof authorization !== 'string' || authorization.length > MAX_AUTHORIZATION_LENGTH
      || !/^[\x20-\x7e]*$/u.test(authorization)))) {
    throw new RelayProtocolError('The broker relay sent an invalid request line.')
  }
  const bytes = Buffer.from(body, 'base64')
  if (bytes.toString('base64') !== body || bytes.length > MAX_BROKER_REQUEST_BYTES) {
    throw new RelayProtocolError('The broker relay sent an invalid request body.')
  }
  return { kind: 'request', id, authorization, body: bytes }
}

/** Replay one request; settles only after the request's socket to the gateway has closed. */
async function replay(
  gateway: RelayGateway, relayed: RelayRequest, signal: AbortSignal,
): Promise<{ status: number; body: string } | null> {
  const answered = Promise.withResolvers<{ status: number; body: string } | null>()
  const closed = Promise.withResolvers<undefined>()
  let responded = false
  const forward = request({
    socketPath: gateway.socketPath, path: BUSINESS_ROUTE, method: 'POST', agent: false, signal,
    headers: { 'content-length': relayed.body.length, ...relayed.authorization === null ? {} : { authorization: relayed.authorization } },
  }, (response) => {
    responded = true
    text(response).then(
      (body) => { answered.resolve(response.statusCode === undefined ? null : { status: response.statusCode, body }) },
      // The gateway closed the response early, as it does when it cancels a request.
      () => { answered.resolve(null) },
    )
  })
  // A refused, reset, or cancelled replay closes the guest connection, as the gateway does on its own socket.
  forward.on('error', () => { answered.resolve(null) })
  forward.once('close', () => {
    if (!responded) answered.resolve(null)
    closed.resolve(undefined)
  })
  forward.end(relayed.body)
  const [reply] = await Promise.all([answered.promise, closed.promise])
  return reply
}

/**
 * Pump one relay's requests to the execution gateway until the relay's output ends. A malformed or oversized line,
 * a reused request id, or more requests in flight than the gateway's connection limit is reported, stops the relay,
 * and cancels its replayed requests. A cancelled request stays in flight until its replay to the gateway has closed;
 * the pump then answers it with a null status, which frees the relay's slot. While the relay's stdin does not accept a
 * reply, the pump reads no further requests, so the reply backlog is bounded by the buffered replies plus the requests
 * already in flight; a relay that never reads its stdin holds its requests until the call's deadline stops it.
 * @param relay - The relay command's streams.
 * @param gateway - The execution gateway socket and its connection limit.
 * @param report - Receives each protocol violation once.
 * @returns Readiness and settlement of the pump.
 */
export function pumpRelay(relay: RelayStreams, gateway: RelayGateway, report: (error: RelayProtocolError) => void): RelayPump {
  // Every replay whose gateway request has not closed, cancelled or not.
  const inFlight = new Map<number, { controller: AbortController; done: Promise<void> }>()
  const ready = Promise.withResolvers<undefined>()
  let started = false
  let stopped = false
  let buffered = ''

  const stop = (error?: RelayProtocolError): void => {
    if (stopped) return
    stopped = true
    if (error !== undefined) report(error)
    ready.reject(error ?? new Error('The broker relay ended before it was ready.'))
    for (const { controller } of inFlight.values()) controller.abort()
    relay.stop()
    // A paused stdout would never reach its close, which settles the pump.
    relay.input.resume()
  }
  const write = (message: object): void => {
    if (!stopped && !relay.output.write(`${JSON.stringify(message)}\n`)) relay.input.pause()
  }
  const accept = (line: RelayLine): void => {
    if (!started) {
      if (line.kind !== 'ready') throw new RelayProtocolError('The broker relay sent a request before it was ready.')
      started = true
      ready.resolve(undefined)
      return
    }
    if (line.kind === 'ready') throw new RelayProtocolError('The broker relay reported readiness twice.')
    if (line.kind === 'cancel') {
      inFlight.get(line.id)?.controller.abort()
      return
    }
    if (inFlight.has(line.id)) throw new RelayProtocolError('The broker relay reused an active request id.')
    if (inFlight.size >= gateway.maxConnections) throw new RelayProtocolError('The broker relay exceeded the request limit.')
    const controller = new AbortController()
    const done = replay(gateway, line, controller.signal).then((reply) => {
      inFlight.delete(line.id)
      write(controller.signal.aborted || reply === null ? { id: line.id, status: null, body: '' } : { id: line.id, ...reply })
    })
    inFlight.set(line.id, { controller, done })
  }

  relay.input.setEncoding('utf8')
  // A stream error means the relay command has ended; the close of its stdout settles the pump.
  relay.output.on('error', () => { stop() })
  relay.output.on('close', () => { stop() })
  relay.output.on('drain', () => { if (!stopped) relay.input.resume() })
  relay.input.on('error', () => { stop() })
  relay.input.on('data', (chunk: string) => {
    if (stopped) return
    buffered += chunk
    try {
      let end: number
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        if (Buffer.byteLength(line) > MAX_RELAY_LINE_BYTES) throw new RelayProtocolError('The broker relay sent an oversized line.')
        accept(parseLine(line))
      }
      if (Buffer.byteLength(buffered) > MAX_RELAY_LINE_BYTES) throw new RelayProtocolError('The broker relay sent an oversized line.')
    } catch (error) {
      if (!(error instanceof RelayProtocolError)) throw error
      buffered = ''
      stop(error)
    }
  })
  const ended = new Promise<void>((resolve) => {
    relay.input.once('close', () => { resolve() })
  })
  const done = ended.then(async () => {
    stop()
    await Promise.all([...inFlight.values()].map(({ done }) => done))
  })
  return { ready: ready.promise, done }
}
