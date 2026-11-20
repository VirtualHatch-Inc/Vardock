/** Authority-owned HTTPS JSON dispatch and status lookup with fixed routes and per-call credentials. */
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { request } from 'node:https'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { isBrokerReceiptId } from './library.ts'
import { ACTION, brokerActionId, loadCertificate, requireActive, requireJsonBody, resolveBearerToken, routeDigest, routeEndpoint } from './request.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_BODY_BYTES = 32_768
const DEFAULT_RESPONSE_BYTES = 32_768
const MAX_RESPONSE_HEADER_BYTES = 16_384
const MAX_RECONCILIATION_BODY_BYTES = 4096
const MAX_DESCRIPTION_LENGTH = 2000
/** Product token every broker request sends, because many HTTP APIs reject a request without a `User-Agent`. */
const USER_AGENT = 'deepseek-harness'

declare module '@deepseek-ai/cordis' {
  interface Context {
    operationBroker: OperationBroker
  }
}

/** Operator-selected action identity in the broker route table. */
export type BrokerActionId = Branded<'BrokerActionId'>

/** Complete request for authority storage and review before credential resolution. */
export interface PreparedBrokerRequest {
  /** Configured action. */
  readonly action: BrokerActionId
  /** HTTP method selected by the provider. */
  readonly method: 'POST'
  /** Fixed canonical HTTPS endpoint. */
  readonly endpoint: string
  /** Tool the endpoint runs with `body` as its arguments, for a provider that calls tools on a remote server. */
  readonly tool?: string
  /** Fixed same-origin HTTPS status endpoint, when the route supports reconciliation. */
  readonly reconciliationEndpoint?: string
  /** Authority-only reference to the bearer token. */
  readonly credentialRef: CredentialRef
  /** Exact JSON text to send as UTF-8. */
  readonly body: string
}

/** One action a requester can submit, with the provider's usage text. */
export interface BrokerActionDescription {
  /** Action ID a requester passes to the authority. */
  readonly action: BrokerActionId
  /** What the action does and what its JSON body contains, when the provider supplies it. */
  readonly description?: string
  /** Authority-only reference to the bearer token the action sends. */
  readonly credentialRef: CredentialRef
  /** Whether the response text is handed to the requesting work environment, where it can reach the model. */
  readonly returnsResponse?: boolean
  /**
   * SHA-256 hex digest of where a request for this action goes and what comes back: the provider's route fields and
   * the limits that change what is sent or returned for this action. Usage text does not affect it. The provider's
   * `fingerprint` covers every field it digests, so a changed digest also changes the fingerprint.
   */
  readonly routeDigest: string
}

/** Human-readable presentation derived from the exact prepared request. */
export interface BrokerReviewPresentation {
  /** Localized question describing the action and destination. */
  readonly title: { readonly en: string; readonly [locale: string]: string }
  /** Plain-text preview of the outgoing content. The authority also shows the complete JSON. */
  readonly detail: string
}

/** Authority-issued binding of one approved request to its external business operation. */
export interface BrokerCorrelation {
  /** Durable operation identity sent as the idempotency key. */
  readonly operationId: Branded<'OperationId'>
  /** SHA-256 hex digest of the reviewed operation payload. */
  readonly payloadDigest: string
}

/** Stable identity available during preparation, before a business operation is reserved. */
export interface BrokerRequestIdentity {
  /** Authority-issued identity of the live parent execution. */
  readonly parentId: BrokerCorrelation['operationId']
  /** Requester's validated key for this business proposal. */
  readonly requestKey: string
}

interface ReturnedResponse {
  /** Complete UTF-8 response text, only from an action configured to return its response. */
  readonly body?: string
  /** Why an action configured to return its response has no `body`. The response was still observed. */
  readonly bodyOmitted?: 'too-large' | 'not-utf8' | 'contains-credential' | 'unavailable'
}

/** Response observed at the configured endpoint. Neither kind establishes a business outcome. */
export type BrokerObservation =
  | ({
    /** Discriminant for a received final HTTP status. */
    readonly kind: 'http-response'
    /** Numeric response status. */
    readonly statusCode: number
  } & ReturnedResponse)
  | ({
    /** Discriminant for a completed tool call. */
    readonly kind: 'tool-result'
    /** Whether the server marked the result as an error. */
    readonly isError: boolean
  } & ReturnedResponse)

/** Opaque receipt identity issued by the business endpoint for a terminal outcome. */
export type BrokerReceiptId = Branded<'BrokerReceiptId'>

/** Business status confirmed by a read-only lookup bound to the original request. */
export type BrokerResolution =
  | { readonly kind: 'pending' }
  | { readonly kind: 'succeeded'; readonly receiptId: BrokerReceiptId }
  | { readonly kind: 'failed'; readonly receiptId: BrokerReceiptId }

/** Stable broker failures suitable for an authority operation record. */
export type BrokerErrorCode =
  | 'broker-action-unavailable'
  | 'broker-invalid-body'
  | 'broker-route-changed'
  | 'broker-credential-unavailable'
  | 'broker-credential-invalid'
  | 'broker-canceled'
  | 'broker-response-unavailable'
  | 'broker-reconciliation-unavailable'
  | 'broker-reconciliation-unconfirmed'

/** Failure with a safe diagnostic and the strongest known dispatch fact. */
export class BrokerError extends Error {
  /**
   * @param code - Stable failure code for the operation record.
   * @param dispatch - Whether the broker can confirm that this call sent no request.
   * @param message - Safe diagnostic without credential or upstream content.
   */
  constructor(
    readonly code: BrokerErrorCode,
    readonly dispatch: 'not-sent' | 'unknown',
    message: string,
  ) {
    super(message)
    this.name = 'BrokerError'
  }
}

/** Service Definition for preparing, dispatching, and reconciling approved business requests. */
export abstract class OperationBroker extends Service {
  /**
   * @param ctx - Authority context that owns this provider.
   * @param name - Service name the authority configuration refers to. Each provider package mounted together needs its own.
   */
  constructor(ctx: Context, name = 'operationBroker') {
    super(ctx, name)
  }

  /** Stable fingerprint of the provider's approved deployment settings. */
  abstract readonly fingerprint: string

  /**
   * List the actions this provider accepts, without resolving credentials or contacting an endpoint.
   * @returns Every configured action in ascending action ID order.
   */
  abstract actions(): readonly BrokerActionDescription[]

  /**
   * Prepare an immutable request for authority storage and exact review without resolving credentials.
   * Repeated preparations with the same inputs and configuration must produce the same request.
   * @param action - Operator-configured action ID.
   * @param body - Exact JSON text supplied by the requester.
   * @param identity - Authority-supplied parent execution ID and validated proposal key.
   * @returns The fixed target and exact outgoing body for review.
   * @throws A {@link BrokerError} when the action or body is invalid.
   */
  abstract resolve(action: string, body: string, identity: BrokerRequestIdentity): PreparedBrokerRequest

  /**
   * Describe the exact request during human review without resolving credentials or contacting the endpoint.
   * @param _spec - Stored request awaiting review.
   * @returns An optional provider presentation alongside the exact outgoing JSON.
   */
  reviewPresentation(_spec: PreparedBrokerRequest): BrokerReviewPresentation | undefined {
    return undefined
  }

  /**
   * Send one request after the authority consumes its witnessed approval.
   * @param spec - Exact stored request authorized by the authority.
   * @param correlation - Authority-issued identity and digest of the approved operation.
   * @param signal - Cancellation for credential lookup and transport.
   * @returns An HTTP response observation.
   * @throws A sanitized {@link BrokerError} with the known dispatch state.
   */
  abstract run(spec: PreparedBrokerRequest, correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerObservation>

  /**
   * Look up the business status of a previously admitted operation without resending its request.
   * Check the saved route against current configuration before lookup. Apply the current POST
   * body size limit only when preparing or sending a POST.
   * @param spec - Exact stored request including its configured status endpoint.
   * @param correlation - The same identity and digest used for dispatch.
   * @param signal - Cancellation for credential lookup and the complete status response.
   * @returns Confirmed pending or terminal status, with a receipt ID for a terminal status.
   * @throws A sanitized {@link BrokerError} when a lookup is unavailable or cannot confirm status.
   */
  abstract reconcile(spec: PreparedBrokerRequest, correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerResolution>
}

/** One operator-configured HTTPS JSON action. */
export interface BrokerRouteConfig {
  /** PEM certificate authority file trusted only for this route, including status lookup; read at plugin load. */
  readonly ca?: string
  /** Stable action ID supplied by the caller. */
  readonly action: string
  /** Usage text shown to the requesting model: what the action does and what its JSON body contains. */
  readonly description?: string
  /** Canonical HTTPS endpoint including its path. */
  readonly endpoint: string
  /** Canonical same-origin HTTPS endpoint for a read-only status lookup. Omit to disable lookups for this route. */
  readonly reconciliationEndpoint?: string
  /** Name of the bearer token in the authority's credential provider. */
  readonly credentialRef: string
  /** Return the complete response text to the requesting work environment, where it can reach the model. */
  readonly returnResponse?: boolean
}

/** Operator configuration for the HTTPS JSON broker. */
export interface Config {
  /** Routes available to the authority. */
  readonly routes: BrokerRouteConfig[]
  /** Deadline in milliseconds through POST response headers or the complete status response, including credential lookup. */
  readonly timeoutMs?: number
  /** Maximum UTF-8 request body bytes. */
  readonly maxBodyBytes?: number
  /** Maximum response body bytes returned by a route with `returnResponse`. A larger response is omitted. */
  readonly maxResponseBytes?: number
}

function reconciliationEndpoint(value: string, endpoint: string): string {
  const url = new URL(routeEndpoint(value))
  if (url.origin !== new URL(endpoint).origin) {
    throw new Error('Broker status endpoints must share the origin of the POST endpoint.')
  }
  if (url.searchParams.has('operationId') || url.searchParams.has('payloadDigest')) {
    throw new Error('Broker status endpoints reserve the operationId and payloadDigest query parameters.')
  }
  return value
}

function requireMatchingRoute(spec: PreparedBrokerRequest, current: Omit<PreparedBrokerRequest, 'body'>): void {
  if (spec.endpoint !== current.endpoint
    || spec.reconciliationEndpoint !== current.reconciliationEndpoint || spec.credentialRef !== current.credentialRef) {
    throw new BrokerError('broker-route-changed', 'not-sent', 'The broker route no longer matches the reviewed request.')
  }
}

function responseUnavailable(): BrokerError {
  return new BrokerError('broker-response-unavailable', 'unknown', 'The broker did not observe a final HTTP response.')
}

function send(
  spec: PreparedBrokerRequest, correlation: BrokerCorrelation, token: string, signal: AbortSignal, maxResponseBytes?: number, ca?: string,
): Promise<BrokerObservation> {
  return new Promise<BrokerObservation>((resolve, reject) => {
    let interrupted = () => { reject(responseUnavailable()) }
    const noResponse = () => { interrupted() }
    const req = request(spec.endpoint, {
      method: spec.method,
      agent: false,
      rejectUnauthorized: true,
      ca,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(spec.body),
        'idempotency-key': correlation.operationId,
        'x-dsh-request-digest': correlation.payloadDigest,
      },
    }, (response) => {
      const statusCode = response.statusCode
      if (statusCode === undefined || statusCode < 200 || statusCode > 599) {
        noResponse()
        response.destroy()
        return
      }
      if (maxResponseBytes === undefined) {
        resolve({ kind: 'http-response', statusCode })
        response.destroy()
        return
      }
      // The status is already observed, so a failed body read omits the text instead of losing the response.
      const chunks: Buffer[] = []
      let bytes = 0
      const omit = (bodyOmitted: NonNullable<BrokerObservation['bodyOmitted']>) => {
        resolve({ kind: 'http-response', statusCode, bodyOmitted })
        response.destroy()
      }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxResponseBytes) omit('too-large')
        else chunks.push(chunk)
      })
      response.once('end', () => {
        const data = Buffer.concat(chunks)
        const body = data.toString('utf8')
        if (!isUtf8(data)) omit('not-utf8')
        else if (body.includes(token)) omit('contains-credential')
        else resolve({ kind: 'http-response', statusCode, body })
      })
      interrupted = () => { omit('unavailable') }
      response.once('error', interrupted)
      response.once('close', interrupted)
    })
    req.on('error', noResponse)
    req.once('close', noResponse)
    req.once('upgrade', (_response, socket) => {
      socket.destroy()
      noResponse()
    })
    req.end(spec.body)
  }).catch(() => { throw responseUnavailable() })
}

function reconciliationUnconfirmed(): BrokerError {
  return new BrokerError('broker-reconciliation-unconfirmed', 'unknown', 'The broker status lookup did not confirm a business status.')
}

async function readResolution(response: IncomingMessage, correlation: BrokerCorrelation, token: string): Promise<BrokerResolution> {
  if (response.statusCode !== 200) {
    response.destroy()
    throw reconciliationUnconfirmed()
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    bytes += chunk.length
    if (bytes > MAX_RECONCILIATION_BODY_BYTES) throw reconciliationUnconfirmed()
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks, bytes)
  if (!isUtf8(body)) throw reconciliationUnconfirmed()
  const value: unknown = JSON.parse(body.toString('utf8'))
  if (typeof value !== 'object' || value === null
    || !('operationId' in value) || value.operationId !== correlation.operationId
    || !('payloadDigest' in value) || value.payloadDigest !== correlation.payloadDigest
    || !('status' in value)) throw reconciliationUnconfirmed()
  if (value.status === 'pending') return { kind: 'pending' }
  if ((value.status === 'succeeded' || value.status === 'failed')
    && 'receiptId' in value && isBrokerReceiptId(value.receiptId) && !value.receiptId.includes(token)) {
    return { kind: value.status, receiptId: value.receiptId }
  }
  throw reconciliationUnconfirmed()
}

function lookup(
  endpoint: string, correlation: BrokerCorrelation, token: string, signal: AbortSignal, ca?: string,
): Promise<BrokerResolution> {
  const url = new URL(endpoint)
  const query = new URLSearchParams({ operationId: correlation.operationId, payloadDigest: correlation.payloadDigest })
  url.search += `${url.search === '' ? '?' : '&'}${query}`
  return new Promise<BrokerResolution>((resolve, reject) => {
    const unconfirmed = () => { reject(reconciliationUnconfirmed()) }
    const req = request(url, {
      method: 'GET',
      agent: false,
      rejectUnauthorized: true,
      ca,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      signal,
      headers: {
        authorization: `Bearer ${token}`, 'user-agent': USER_AGENT, accept: 'application/json', 'cache-control': 'no-cache',
      },
    }, (response) => { resolve(readResolution(response, correlation, token)) })
    req.on('error', unconfirmed)
    req.once('close', unconfirmed)
    req.once('upgrade', (_response, socket) => {
      socket.destroy()
      unconfirmed()
    })
    req.end()
  }).catch(() => { throw reconciliationUnconfirmed() })
}

/** Dispatch and reconcile requests through an operator's fixed HTTPS route table. */
export default class HttpsJsonBroker extends OperationBroker {
  static readonly inject = ['credentials']

  static readonly Config: z<Config, Required<Config>> = z.object({
    routes: z.array(z.object({
      action: z.string().pattern(ACTION).required(),
      description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
      endpoint: z.string().min(1).required(),
      ca: z.string().min(1),
      reconciliationEndpoint: z.string().min(1),
      credentialRef: z.string().min(1).required(),
      returnResponse: z.boolean().default(false),
    }).required()).required(),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
    maxBodyBytes: z.number().step(1).min(1).max(131_072).default(DEFAULT_BODY_BYTES),
    maxResponseBytes: z.number().step(1).min(1).max(131_072).default(DEFAULT_RESPONSE_BYTES),
  })

  readonly fingerprint: string
  private readonly routes: ReadonlyMap<string, Omit<PreparedBrokerRequest, 'body'>>
  private readonly descriptions: readonly BrokerActionDescription[]
  private readonly certificates: ReadonlyMap<string, ReturnType<typeof loadCertificate>>
  private readonly returning: ReadonlySet<string>
  private readonly maxResponseBytes: number
  private readonly lifetime = new AbortController()
  private readonly timeoutMs: number
  private readonly maxBodyBytes: number

  /**
   * @param ctx - Authority context with a credential provider.
   * @param config - Operator's routes and limits.
   */
  constructor(ctx: Context, config: Config) {
    const resolved = HttpsJsonBroker.Config(config)
    const certificates = new Map<string, ReturnType<typeof loadCertificate>>()
    const configuredRoutes = new Map<string, Omit<PreparedBrokerRequest, 'body'>>()
    for (const route of resolved.routes) {
      const action = brokerActionId(route.action)
      if (configuredRoutes.has(action)) throw new Error(`Broker action "${action}" is configured more than once.`)
      if (!isCredentialRefName(route.credentialRef)) throw new Error(`Broker action "${action}" needs a credential reference name.`)
      const endpoint = routeEndpoint(route.endpoint)
      if (route.ca !== undefined) {
        certificates.set(action, loadCertificate(route.ca))
      }
      configuredRoutes.set(action, Object.freeze({
        action,
        method: 'POST',
        endpoint,
        ...route.reconciliationEndpoint === undefined ? {} : {
          reconciliationEndpoint: reconciliationEndpoint(route.reconciliationEndpoint, endpoint),
        },
        credentialRef: credentialRef(route.credentialRef),
      }))
    }
    super(ctx)
    this.certificates = certificates
    this.routes = configuredRoutes
    this.timeoutMs = resolved.timeoutMs
    this.maxBodyBytes = resolved.maxBodyBytes
    this.maxResponseBytes = resolved.maxResponseBytes
    this.descriptions = Object.freeze(resolved.routes
      .map(({ action: id, description, returnResponse }) => {
        const route = this.route(id)
        const ca = this.certificates.get(id)
        return Object.freeze({
          action: route.action, ...description === undefined ? {} : { description }, credentialRef: route.credentialRef,
          ...returnResponse ? { returnsResponse: true } : {},
          // The timeout decides only whether a response arrives in time, so it does not identify the route.
          routeDigest: routeDigest(['https-json', route.method, route.endpoint, route.reconciliationEndpoint ?? null,
            route.credentialRef, returnResponse === true, this.maxBodyBytes, returnResponse === true ? this.maxResponseBytes : null,
            ...ca === undefined ? [] : [ca.path, ca.digest]]),
        })
      })
      .sort((left, right) => left.action.localeCompare(right.action, 'en')))
    this.returning = new Set(resolved.routes.filter(route => route.returnResponse).map(route => route.action))
    const routes = [...configuredRoutes.values()].sort((left, right) => left.action.localeCompare(right.action, 'en'))
    this.fingerprint = createHash('sha256').update(JSON.stringify([
      'https-json', routes, ...this.certificates.size === 0 ? [] : [{ certificates: [...this.certificates].sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([action, ca]) => [action, ca.path, ca.digest]) }], this.timeoutMs, this.maxBodyBytes, MAX_RESPONSE_HEADER_BYTES,
      ...this.returning.size === 0 ? [] : [{ returning: [...this.returning].sort(), maxResponseBytes: this.maxResponseBytes }],
    ])).digest('hex')
    ctx.effect(() => () => { this.lifetime.abort() }, 'operation-broker.cancel')
  }

  override actions(): readonly BrokerActionDescription[] {
    return this.descriptions
  }

  override resolve(action: string, body: string, _identity: BrokerRequestIdentity): PreparedBrokerRequest {
    const route = this.route(action)
    requireJsonBody(body, this.maxBodyBytes)
    return Object.freeze({ ...route, body })
  }

  override async run(spec: PreparedBrokerRequest, correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerObservation> {
    const { body } = spec
    const current = this.route(spec.action)
    requireJsonBody(body, this.maxBodyBytes)
    requireMatchingRoute(spec, current)
    using limit = deadline(AbortSignal.any([signal, this.lifetime.signal]), this.timeoutMs, 'broker-timeout')
    const token = await resolveBearerToken(this.ctx.credentials, current.credentialRef, limit.signal)
    requireActive(limit.signal)
    return await send({ ...current, body }, correlation, token, limit.signal,
      this.returning.has(spec.action) ? this.maxResponseBytes : undefined, this.certificates.get(spec.action)?.pem)
  }

  override async reconcile(spec: PreparedBrokerRequest, correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerResolution> {
    const current = this.route(spec.action)
    requireMatchingRoute(spec, current)
    if (current.reconciliationEndpoint === undefined) {
      throw new BrokerError('broker-reconciliation-unavailable', 'not-sent', 'The broker route has no status endpoint.')
    }
    using limit = deadline(AbortSignal.any([signal, this.lifetime.signal]), this.timeoutMs, 'broker-timeout')
    const token = await resolveBearerToken(this.ctx.credentials, current.credentialRef, limit.signal)
    requireActive(limit.signal)
    return await lookup(current.reconciliationEndpoint, correlation, token, limit.signal, this.certificates.get(spec.action)?.pem)
  }

  private route(action: string): Omit<PreparedBrokerRequest, 'body'> {
    const route = this.routes.get(action)
    if (route === undefined) throw new BrokerError('broker-action-unavailable', 'not-sent', 'The broker action is not configured.')
    return route
  }
}
