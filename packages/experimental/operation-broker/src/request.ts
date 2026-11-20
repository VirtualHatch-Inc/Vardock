/** Checks shared by the broker providers before a request leaves the authority. */
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { addAbortListener } from 'node:events'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { BrokerError, type BrokerActionId } from './index.ts'
import { isBearerToken } from './library.ts'

/** Syntax of an operator-selected action identity. */
export const ACTION = /^[a-z][a-z0-9._-]{0,63}$/u

/**
 * Validate an action identity at a configuration or wire boundary.
 * @param value - The unbranded action ID.
 * @returns The validated action ID.
 */
export function brokerActionId(value: string): BrokerActionId {
  if (!ACTION.test(value)) {
    throw new BrokerError('broker-action-unavailable', 'not-sent', 'The broker action ID is invalid.')
  }
  return brandString<BrokerActionId>(value)
}

/**
 * Validate an operator-configured destination.
 * @param value - Configured URL text.
 * @returns The same text when it is a canonical HTTPS URL without user info or a fragment.
 * @throws When the text is not such a URL.
 */
export function routeEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    void error
    throw new Error('Broker routes require a canonical HTTPS endpoint.')
  }
  if (url.protocol !== 'https:' || value !== `${url.origin}${url.pathname}${url.search}`) {
    throw new Error('Broker routes require a canonical HTTPS endpoint without user info or a fragment.')
  }
  return value
}

/**
 * Read the destination trust roots used in dispatch and route identity.
 * @param file - Operator-configured PEM file path.
 * @returns Absolute path, original UTF-8 PEM text, and its SHA-256 digest.
 * @throws When the file cannot be read or parsed as an X.509 certificate.
 */
export function loadCertificate(file: string): { path: string; pem: string; digest: string } {
  const path = resolve(file)
  const pem = readFileSync(path, 'utf8')
  new X509Certificate(pem)
  return { path, pem, digest: createHash('sha256').update(pem).digest('hex') }
}

/**
 * Describe a request that stopped before anything was sent.
 * @returns The failure for the operation record.
 */
export function canceled(): BrokerError {
  return new BrokerError('broker-canceled', 'not-sent', 'The broker request stopped before sending.')
}

/**
 * Stop before sending when the request was canceled.
 * @param signal - Cancellation of the request.
 * @throws A not-sent {@link BrokerError} when the signal is aborted.
 */
export function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw canceled()
}

/**
 * Check a requester's body before it is stored or sent.
 * @param body - Exact text supplied by the requester.
 * @param maxBytes - Maximum UTF-8 bytes.
 * @returns The parsed JSON value.
 * @throws A not-sent {@link BrokerError} when the text is not bounded, well-formed JSON.
 */
export function requireJsonBody(body: string, maxBytes: number): unknown {
  const invalidBody = () => new BrokerError('broker-invalid-body', 'not-sent', 'The broker request needs bounded, well-formed JSON text.')
  if (!body.isWellFormed() || Buffer.byteLength(body) > maxBytes) throw invalidBody()
  try {
    return JSON.parse(body)
  } catch (error) {
    void error
    throw invalidBody()
  }
}

/**
 * Read the bearer token an action sends.
 * @param credentials - Authority's credential provider.
 * @param ref - Reference configured for the action.
 * @param signal - Cancellation of the request.
 * @returns The token.
 * @throws A not-sent {@link BrokerError} when the request was canceled or the token is missing or malformed.
 */
export async function resolveBearerToken(credentials: CredentialProvider, ref: CredentialRef, signal: AbortSignal): Promise<string> {
  requireActive(signal)
  const stopped = Promise.withResolvers<undefined>()
  using _listener = addAbortListener(signal, () => { stopped.resolve(undefined) })
  let token: string | undefined
  try {
    token = (await Promise.race([credentials.resolve(ref), stopped.promise]))?.value
  } catch (error) {
    void error
  }
  requireActive(signal)
  if (token === undefined) {
    throw new BrokerError('broker-credential-unavailable', 'not-sent', 'The authority could not resolve the broker credential.')
  }
  if (!isBearerToken(token)) {
    throw new BrokerError('broker-credential-invalid', 'not-sent', 'The configured broker credential is not a valid bearer token.')
  }
  return token
}

/**
 * Digest the fields that identify where a request for one action goes and what comes back.
 * @param fields - Provider kind followed by those fields in a fixed order.
 * @returns The SHA-256 hex digest of their JSON text.
 */
export function routeDigest(fields: readonly (string | number | boolean | null)[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}
