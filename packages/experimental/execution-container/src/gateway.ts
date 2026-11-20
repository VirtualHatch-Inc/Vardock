/** Relay exact-target CONNECT or per-execution requests over a private Unix socket. */
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { chmod, lstat, type FileHandle } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection, isIP, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { prepareOperationSocket } from '@deepseek-ai/dsh-operation-evidence/library'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import ipaddr from 'ipaddr.js'
import type { ExecutionBroker } from './service.ts'

/** Exact HTTP path for per-execution guest requests. */
export const BUSINESS_ROUTE = '/business'
/** Guest loopback port on which each backend serves the gateway. */
export const GUEST_GATEWAY_PORT = 3128
/** Guest URL of the gateway listener. */
export const GUEST_GATEWAY_URL = `http://127.0.0.1:${GUEST_GATEWAY_PORT}`
/** Maximum bytes in one business request body. */
export const MAX_BROKER_REQUEST_BYTES = 256 * 1024
/** Maximum bytes in one serialized business response. */
export const MAX_BROKER_RESPONSE_BYTES = 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Hand a broker credential to one guest command by variable name, so it stays off the container CLI's command line.
 * @param token - Credential returned by {@link ExecutionGateway.registerBroker}.
 * @returns Container CLI `--env` arguments, and the variables the CLI process must carry.
 */
export function brokerEnvironment(token: string): { args: string[]; env: Record<`DSH_${string}`, string> } {
  const env = { DSH_BROKER_URL: `${GUEST_GATEWAY_URL}${BUSINESS_ROUTE}`, DSH_BROKER_TOKEN: token }
  return {
    args: [...Object.keys(env).flatMap(name => ['--env', name]), '--env', 'NO_PROXY=127.0.0.1', '--env', 'no_proxy=127.0.0.1'],
    env,
  }
}

interface BrokerRegistration {
  readonly signal: AbortSignal
  readonly run: ExecutionBroker
  readonly requests: Set<Promise<void>>
  dispose(): Promise<void>
}

/** Operator-owned network policy shared by the guests of one execution provider. */
export interface ExecutionGatewayConfig {
  /** Stable socket path inside the provider's private directory. */
  socketPath: string
  /** Exact canonical host:port authorities. Empty denies every connection; no wildcards. */
  allowedTargets: readonly string[]
  /** Maximum milliseconds without socket activity, including connection setup. */
  idleTimeoutMs: number
  /** Maximum concurrent guest connections, each of which may own one outbound socket. */
  maxConnections: number
}

function targetOf(value: string): { hostname: string; port: number } {
  const url = new URL(`tcp://${value}`)
  if (url.host !== value || url.username || url.password || url.pathname || url.search || url.hash || !url.port) {
    throw new Error('Gateway targets must be canonical host:port authorities')
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  if ((!isIP(hostname) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname)) || Number(url.port) === 0) {
    throw new Error('Gateway targets require a literal IP or DNS hostname and a nonzero port')
  }
  return { hostname, port: Number(url.port) }
}

function replyJson(response: ServerResponse, status: number, body: string): void {
  if (response.destroyed) return
  response.writeHead(status, { connection: 'close', 'content-type': 'application/json' })
  response.end(body)
}

/** Host transport for raw CONNECT tunnels and separately configured per-call request handlers. */
export class ExecutionGateway {
  private readonly targets = new Map<string, ReturnType<typeof targetOf>>()
  private readonly sockets = new Set<Socket>()
  private readonly brokers = new Map<string, BrokerRegistration>()
  private readonly server = createServer((request, response) => {
    this.handleRequest(request, response)
  })
  private lock: FileHandle | undefined
  private closed = false

  /** @param config - Validated socket location, exact destinations, and inactivity timeout. */
  constructor(private readonly config: ExecutionGatewayConfig) {
    for (const target of config.allowedTargets) this.targets.set(target, targetOf(target))
    this.server.headersTimeout = config.idleTimeoutMs
    this.server.requestTimeout = config.idleTimeoutMs
    this.server.maxConnections = config.maxConnections
    this.server.on('connection', (socket) => { this.track(socket) })
    this.server.on('connect', (request, downstream, head) => {
      const target = this.targets.get(request.url ?? '')
      if (target === undefined) {
        downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      void this.connect(target, downstream, head)
    })
  }

  /**
   * Register one capability for a shell execution on a gateway with no CONNECT targets.
   * @param run - Authority handler for this execution only.
   * @param signal - Shell execution lifetime.
   * @returns The guest credential and a disposer that withdraws it and waits for admitted requests.
   */
  registerBroker(run: ExecutionBroker, signal: AbortSignal): { token: string; dispose: () => Promise<void> } {
    if (this.closed || this.targets.size > 0) {
      throw new HarnessError('Business requests require an execution gateway with an empty CONNECT allowlist.', 'EXEC_BROKER_UNAVAILABLE')
    }
    signal.throwIfAborted()
    const token = randomBytes(32).toString('hex')
    const lifetime = new AbortController()
    const requests = new Set<Promise<void>>()
    const dispose = async (): Promise<void> => {
      lifetime.abort(new Error('The shell execution ended.'))
      await Promise.allSettled(requests)
      this.brokers.delete(token)
    }
    this.brokers.set(token, { signal: AbortSignal.any([signal, lifetime.signal]), run, requests, dispose })
    return { token, dispose }
  }

  /**
   * Reserve and listen on the socket before starting a guest.
   * @param recover - When supplied, stop orphaned guests while holding the exclusive socket lock, before accepting traffic.
   * @returns Completion of socket permission setup. Startup failure leaves no active listener.
   */
  async ready(recover?: () => Promise<void>): Promise<void> {
    if (((await lstat(dirname(this.config.socketPath))).mode & 0o077) !== 0) {
      throw new Error('The execution gateway socket requires a private directory with mode 0700')
    }
    this.lock = await prepareOperationSocket(this.config.socketPath, this.config.idleTimeoutMs)
    try {
      if (recover !== undefined) await recover()
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { reject(error) }
        this.server.once('error', failed)
        this.server.listen(this.config.socketPath, () => {
          this.server.off('error', failed)
          resolve()
        })
      })
      // The private parent excludes other Host users; Apple container forwards this mode to the non-root guest.
      await chmod(this.config.socketPath, 0o666)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /**
   * Close existing tunnels and stop accepting connections before releasing the socket lock.
   * @returns Completion of listener shutdown; pending DNS callbacks cannot open connections afterwards.
   */
  async close(): Promise<void> {
    this.closed = true
    const disconnected = [...this.sockets].map(socket => new Promise<void>((resolve) => {
      socket.once('close', () => { resolve() })
      socket.destroy()
    }))
    const drained = [...this.brokers.values()].map(registration => registration.dispose())
    const stopped = new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error)
        else resolve()
      })
    })
    await Promise.all([...disconnected, ...drained, stopped])
    await this.lock?.close()
    this.lock = undefined
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.url !== BUSINESS_ROUTE || request.method !== 'POST') {
      response.writeHead(405, { connection: 'close', 'content-type': 'text/plain' })
      response.end('Use HTTP CONNECT; for plain HTTP configure your client to tunnel through the proxy.\n')
      return
    }
    const authorization = request.headers.authorization
    const registration = authorization?.startsWith('Bearer ') ? this.brokers.get(authorization.slice(7)) : undefined
    if (registration === undefined || registration.signal.aborted) {
      replyJson(response, 403, '{"error":"No active business request credential."}')
      return
    }
    const pending = this.handleBusiness(request, response, registration)
    registration.requests.add(pending)
    void pending.finally(() => { registration.requests.delete(pending) }).catch(() => { response.destroy() })
  }

  private async handleBusiness(request: IncomingMessage, response: ServerResponse, registration: BrokerRegistration): Promise<void> {
    const disconnected = new AbortController()
    const signal = AbortSignal.any([registration.signal, disconnected.signal])
    const close = (): void => { disconnected.abort(new Error('The guest request disconnected.')) }
    const abort = (): void => { response.destroy() }
    response.once('close', close)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MAX_BROKER_REQUEST_BYTES) {
          replyJson(response, 413, '{"error":"Business request exceeds the byte limit."}')
          return
        }
        chunks.push(chunk)
      }
      let input: unknown
      try {
        input = JSON.parse(utf8.decode(Buffer.concat(chunks, size)))
      } catch (error: unknown) {
        void error
        replyJson(response, 400, '{"error":"Business request must be UTF-8 JSON."}')
        return
      }
      signal.throwIfAborted()
      const result = await registration.run(input, signal)
      signal.throwIfAborted()
      const body = JSON.stringify(result)
      if (Buffer.byteLength(body) > MAX_BROKER_RESPONSE_BYTES) {
        replyJson(response, 502, '{"error":"Business response is unavailable within the byte limit."}')
        return
      }
      replyJson(response, 200, body)
    } catch (error: unknown) {
      void error
      if (!signal.aborted) replyJson(response, 502, '{"error":"Business request could not be completed."}')
    } finally {
      signal.removeEventListener('abort', abort)
      response.off('close', close)
    }
  }

  private track(socket: Socket): void {
    this.sockets.add(socket)
    socket.setTimeout(this.config.idleTimeoutMs, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.sockets.delete(socket))
  }

  private async connect(target: { hostname: string; port: number }, downstream: Duplex, head: Buffer): Promise<void> {
    let address: string
    try {
      if (isIP(target.hostname)) {
        // A literal private address is reachable only when the operator explicitly lists that address and port.
        address = target.hostname
      } else {
        address = (await lookup(target.hostname, { family: 4 })).address
        if (ipaddr.process(address).range() !== 'unicast') throw new Error('Gateway DNS resolved a non-public address')
      }
    } catch (error) {
      // DNS failures and forbidden DNS addresses both fail closed without disclosing Host resolution details.
      void error
      downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    if (this.closed || downstream.destroyed || downstream.readableEnded) return
    const upstream = createConnection({ host: address, port: target.port })
    this.track(upstream)
    downstream.once('end', () => { upstream.destroySoon() })
    downstream.once('close', () => upstream.destroy())
    upstream.once('close', () => downstream.destroy())
    upstream.once('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      downstream.pipe(upstream).pipe(downstream)
    })
  }
}
