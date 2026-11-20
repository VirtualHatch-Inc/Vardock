/** Authority-owned calls to operator-selected tools of remote MCP servers, one connection per call. */
import { createHash } from 'node:crypto'
import { fetch as fetchWithDispatcher } from 'undici'
import { createRouteDispatcher } from '@deepseek-ai/dsh-http-proxy'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { Config as McpClientConfig, type StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { callServerTool } from '@deepseek-ai/dsh-mcp-client/call'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import {
  BrokerError, OperationBroker,
  type BrokerActionDescription, type BrokerCorrelation, type BrokerObservation, type BrokerRequestIdentity, type BrokerResolution,
  type PreparedBrokerRequest,
} from './index.ts'
import { brokerActionId, canceled, loadCertificate, requireActive, requireJsonBody, resolveBearerToken, routeDigest, routeEndpoint } from './request.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    operationBrokerMcp: OperationBroker
  }
}

/** One tool of a server that requesters may call as a broker action. */
export interface McpToolConfig {
  /** Stable action ID supplied by the caller. */
  readonly action: string
  /** Tool name as the server lists it. */
  readonly tool: string
  /** Usage text shown to the requesting model: what the tool does and what its JSON arguments contain. */
  readonly description?: string
  /** Return the result text to the requesting work environment, where it can reach the model. */
  readonly returnResponse?: boolean
}

/** One remote MCP server reached over Streamable HTTP with a bearer token. */
export interface McpServerConfig {
  /** PEM certificate authority file trusted only for this endpoint; read at plugin load. */
  readonly ca?: string
  /** Canonical HTTPS endpoint of the server. */
  readonly url: string
  /** Name of the bearer token in the authority's credential provider. */
  readonly credentialRef: string
  /** Tools available to the authority. A tool the server lists but this table omits cannot be called. */
  readonly tools: McpToolConfig[]
}

/** Operator configuration for the MCP tool broker. */
export interface Config {
  /** Servers and their permitted tools. */
  readonly servers: McpServerConfig[]
  /** Deadline in milliseconds for the credential lookup, for connecting, and separately for the tool call. */
  readonly timeoutMs?: number
  /** Maximum UTF-8 bytes of the JSON arguments. */
  readonly maxBodyBytes?: number
  /** Maximum UTF-8 bytes of result text returned to the requesting work environment; larger text is omitted. */
  readonly maxResponseBytes?: number
  /**
   * Maximum bytes the authority reads from the server for one call, counting every HTTP response body of its connection.
   * Exceeding it closes the connection: the call is not sent when this happens during the handshake, and its outcome is unknown after.
   */
  readonly maxReadBytes?: number
}

type Route = Omit<PreparedBrokerRequest, 'body'> & { readonly tool: string }

/** Call operator-selected MCP tools after the authority admits each request. */
export default class McpToolBroker extends OperationBroker {
  static readonly inject = ['credentials']

  static readonly Config: z<Config, Required<Config>> = z.object({
    servers: z.array(z.object({
      url: z.string().min(1).required(),
      ca: z.string().min(1),
      credentialRef: z.string().min(1).required(),
      tools: z.array(z.object({
        action: z.string().pattern(/^[a-z][a-z0-9._-]{0,63}$/u).required(),
        tool: z.string().min(1).max(256).required(),
        description: z.string().min(1).max(2000),
        returnResponse: z.boolean().default(false),
      }).required()).required(),
    }).required()).required(),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
    maxBodyBytes: z.number().step(1).min(1).max(131_072).default(32_768),
    maxResponseBytes: z.number().step(1).min(1).max(131_072).default(32_768),
    maxReadBytes: z.number().step(1).min(1).max(67_108_864).default(16_777_216),
  })

  readonly fingerprint: string
  private readonly routes = new Map<string, Route>()
  private readonly descriptions: readonly BrokerActionDescription[]
  private readonly certificates = new Map<string, ReturnType<typeof loadCertificate>>()
  private readonly returning = new Set<string>()
  private readonly lifetime = new AbortController()
  private readonly limits: Pick<Required<Config>, 'timeoutMs' | 'maxBodyBytes' | 'maxResponseBytes' | 'maxReadBytes'>

  /**
   * @param ctx - Authority context with a credential provider.
   * @param config - Operator's servers, permitted tools, and limits.
   */
  constructor(ctx: Context, config: Config) {
    const { servers, ...limits } = McpToolBroker.Config(config)
    super(ctx, 'operationBrokerMcp')
    const descriptions: BrokerActionDescription[] = []
    for (const server of servers) {
      const endpoint = routeEndpoint(server.url)
      if (!isCredentialRefName(server.credentialRef)) throw new Error(`MCP server "${endpoint}" needs a credential reference name.`)
      const ref = credentialRef(server.credentialRef)
      const ca = server.ca === undefined ? undefined : loadCertificate(server.ca)
      for (const { action: id, tool, description, returnResponse } of server.tools) {
        const action = brokerActionId(id)
        if (this.routes.has(action)) throw new Error(`Broker action "${action}" is configured more than once.`)
        this.routes.set(action, Object.freeze({ action, method: 'POST', endpoint, tool, credentialRef: ref }))
        if (ca !== undefined) this.certificates.set(action, ca)
        if (returnResponse) this.returning.add(action)
        descriptions.push(Object.freeze({
          action, ...description === undefined ? {} : { description }, credentialRef: ref,
          ...returnResponse ? { returnsResponse: true } : {},
          // The timeout and `maxReadBytes` decide only whether a result arrives, so they do not identify the route.
          routeDigest: routeDigest(['mcp-tool', endpoint, tool, ref, returnResponse === true, limits.maxBodyBytes,
            returnResponse === true ? limits.maxResponseBytes : null, ...ca === undefined ? [] : [ca.path, ca.digest]]),
        }))
      }
    }
    this.descriptions = Object.freeze(descriptions.sort((left, right) => left.action.localeCompare(right.action, 'en')))
    this.limits = limits
    this.fingerprint = createHash('sha256').update(JSON.stringify([
      'mcp-tool', ...this.certificates.size === 0 ? [] : [{ certificates: [...this.certificates].sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([action, ca]) => [action, ca.path, ca.digest]) }], this.descriptions.map(({ action }) => this.routes.get(action)),
      limits.timeoutMs, limits.maxBodyBytes,
      limits.maxResponseBytes, limits.maxReadBytes, ...this.returning.size === 0 ? [] : [{ returning: [...this.returning].sort() }],
    ])).digest('hex')
    ctx.effect(() => () => { this.lifetime.abort() }, 'operation-broker-mcp.cancel')
  }

  override actions(): readonly BrokerActionDescription[] {
    return this.descriptions
  }

  override resolve(action: string, body: string, _identity: BrokerRequestIdentity): PreparedBrokerRequest {
    const route = this.route(action)
    const args = this.toolArguments(body)
    return Object.freeze({ ...route, body: JSON.stringify(args) })
  }

  override async run(spec: PreparedBrokerRequest, _correlation: BrokerCorrelation, signal: AbortSignal): Promise<BrokerObservation> {
    const current = this.route(spec.action)
    if (spec.endpoint !== current.endpoint || spec.tool !== current.tool || spec.credentialRef !== current.credentialRef) {
      throw new BrokerError('broker-route-changed', 'not-sent', 'The broker route no longer matches the reviewed request.')
    }
    const args = this.toolArguments(spec.body)
    const active = AbortSignal.any([signal, this.lifetime.signal])
    const token = await this.token(current.credentialRef, active)
    requireActive(active)
    // The literal transport selects the Streamable HTTP branch of the validated union.
    const config = McpClientConfig({
      transport: 'streamable-http', serverName: 'operation-broker', url: current.endpoint,
      headers: { Authorization: `Bearer ${token}` },
      startupTimeoutMs: this.limits.timeoutMs, toolCallTimeoutMs: this.limits.timeoutMs,
    }) as StreamableHttpConfig
    const ca = this.certificates.get(spec.action)?.pem
    const dispatcher = ca === undefined ? undefined : await createRouteDispatcher({
      get: name => process.env[name] === undefined ? undefined : { value: process.env[name] },
    }, { ca })
    let result: Awaited<ReturnType<typeof callServerTool>>
    try {
      result = await callServerTool(this.ctx, config, { name: current.tool, arguments: args }, this.limits.maxReadBytes, active,
        dispatcher === undefined ? undefined : (url, init) => {
          // proxy-exempt: createRouteDispatcher applies proxy policy with this endpoint's CA.
          const options = { ...init, dispatcher }
          // Undici and the MCP SDK type the same Fetch API against different DOM declarations.
          return (fetchWithDispatcher as typeof fetch)(url, options)
        })
    } finally {
      await dispatcher?.close()
    }
    if (!result.ok) {
      if (result.stage === 'connect') {
        throw active.aborted ? canceled()
          : new BrokerError('broker-response-unavailable', 'not-sent', 'The broker could not connect to the MCP server.')
      }
      throw new BrokerError('broker-response-unavailable', 'unknown', 'The broker did not observe the tool result.')
    }
    const observed = { kind: 'tool-result', isError: result.isError } as const
    if (!this.returning.has(spec.action)) return observed
    if (Buffer.byteLength(result.text) > this.limits.maxResponseBytes) return { ...observed, bodyOmitted: 'too-large' }
    if (result.text.includes(token)) return { ...observed, bodyOmitted: 'contains-credential' }
    return { ...observed, body: result.text }
  }

  override reconcile(_spec: PreparedBrokerRequest, _correlation: BrokerCorrelation, _signal: AbortSignal): Promise<BrokerResolution> {
    return Promise.reject(new BrokerError('broker-reconciliation-unavailable', 'not-sent', 'MCP has no lookup for a past tool call.'))
  }

  private async token(ref: Route['credentialRef'], signal: AbortSignal): Promise<string> {
    using limit = deadline(signal, this.limits.timeoutMs, 'broker-timeout')
    return await resolveBearerToken(this.ctx.credentials, ref, limit.signal)
  }

  private route(action: string): Route {
    const route = this.routes.get(action)
    if (route === undefined) throw new BrokerError('broker-action-unavailable', 'not-sent', 'The broker action is not configured.')
    return route
  }

  private toolArguments(body: string): Record<string, JsonValue> {
    const value = requireJsonBody(body, this.limits.maxBodyBytes)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BrokerError('broker-invalid-body', 'not-sent', 'An MCP tool request needs a JSON object of arguments.')
    }
    return value as Record<string, JsonValue>
  }
}
