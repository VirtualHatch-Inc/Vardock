/** Exercise request preparation, HTTPS dispatch, and read-only business reconciliation. */
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestListener, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import CredentialProvider, { type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { generate } from 'selfsigned'
import { expect, it, vi, type TestContext } from 'vitest'
import HttpsJsonBroker, { type BrokerCorrelation, type BrokerRequestIdentity, type Config } from '../src/index.ts'
import { brokerActionId } from '../src/request.ts'

const route = { action: 'create-record', endpoint: 'https://example.test/records', credentialRef: 'RECORDS_TOKEN' }
const statusRoute = { ...route, reconciliationEndpoint: 'https://example.test/records/status' }
const correlation: BrokerCorrelation = {
  operationId: brandString<BrokerCorrelation['operationId']>('a9586d3f-2fcf-4223-a079-e6bdfbf97a85'),
  payloadDigest: '5'.repeat(64),
}
const identity: BrokerRequestIdentity = {
  parentId: brandString<BrokerCorrelation['operationId']>('2de81a6e-1eb8-48de-a6f7-d938738e8783'),
  requestKey: '943eeb66-e002-440b-915b-a0521cf616e1',
}
const signal = new AbortController().signal

function unexpectedCredentialCall(): never {
  throw new Error('Unexpected credential provider call.')
}

class FixtureCredentials extends CredentialProvider {
  override describe = unexpectedCredentialCall
  override set = unexpectedCredentialCall
  override unset = unexpectedCredentialCall
  override readRecord = unexpectedCredentialCall
  override describeRecord = unexpectedCredentialCall
  override listRecords = unexpectedCredentialCall
  override modifyRecord = unexpectedCredentialCall
  override deleteRecord = unexpectedCredentialCall

  constructor(ctx: Context, override readonly resolve: CredentialProvider['resolve']) {
    super(ctx)
  }
}

async function fixture(test: TestContext, config: Config) {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  const resolve = vi.fn<CredentialProvider['resolve']>()
  await ctx.plugin(FixtureCredentials, resolve)
  await ctx.plugin(HttpsJsonBroker, config)
  return { broker: ctx.operationBroker, resolve }
}

async function httpsFixture(test: TestContext, listener: RequestListener) {
  const { cert, private: key } = generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  })
  const server = createServer({ cert, key }, listener)
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  test.onTestFinished(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  await listening
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback HTTPS listener.')
  return {
    origin: `https://127.0.0.1:${address.port}`, cert,
    async withTrust(run: () => Promise<void>): Promise<void> {
      const original = getCACertificates('default')
      setDefaultCACertificates([...original, cert])
      try {
        await run()
      } finally {
        setDefaultCACertificates(original)
      }
    },
  }
}

it('freezes the exact JSON text and fixed route without resolving credentials', async (test) => {
  const { broker, resolve } = await fixture(test, { routes: [route], maxBodyBytes: 32 })
  const body = '{ "message": "é" }\n'
  const spec = broker.resolve(route.action, body, identity)
  expect(spec).toEqual({ ...route, method: 'POST', body })
  expect(Object.isFrozen(spec)).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  expect(() => broker.resolve('other-action', body, identity)).toThrow(expect.objectContaining({ code: 'broker-action-unavailable' }))
  for (const invalid of ['{broken', '"\ud800"', JSON.stringify('é'.repeat(16))]) {
    expect(() => broker.resolve(route.action, invalid, identity)).toThrow(expect.objectContaining({ code: 'broker-invalid-body' }))
  }
})

it('loads an empty route table and rejects every action', async (test) => {
  const { broker, resolve } = await fixture(test, { routes: [] })
  expect(() => broker.resolve(route.action, '{}', identity)).toThrow(expect.objectContaining({ code: 'broker-action-unavailable' }))
  expect(resolve).not.toHaveBeenCalled()
})

it('rejects ambiguous actions and endpoints at configuration time', () => {
  const ctx = new Context()
  expect(() => brokerActionId('Create Record')).toThrow('action ID is invalid')
  expect(() => new HttpsJsonBroker(ctx, { routes: [route, route] })).toThrow('configured more than once')
  expect(() => new HttpsJsonBroker(ctx, { routes: [{ ...route, credentialRef: 'INVALID-REF' }] })).toThrow('needs a credential reference name')
  for (const endpoint of [
    '/records',
    'http://example.test/records',
    'https://user@example.test/records',
    'https://example.test/records#fragment',
    'https://EXAMPLE.test/records',
  ]) {
    expect(() => new HttpsJsonBroker(ctx, { routes: [{ ...route, endpoint }] })).toThrow('canonical HTTPS endpoint')
  }
  for (const [endpoint, diagnostic] of [
    ['https://example.test/status#fragment', 'canonical HTTPS endpoint'],
    ['https://example.test:8443/status', 'must share the origin'],
    ['https://other.example.test/status', 'must share the origin'],
    ['https://example.test/status?operationId=other', 'reserve the operationId and payloadDigest'],
    ['https://example.test/status?payload%44igest=other', 'reserve the operationId and payloadDigest'],
  ] as const) {
    expect(() => new HttpsJsonBroker(ctx, { routes: [{ ...route, reconciliationEndpoint: endpoint }] })).toThrow(diagnostic)
  }
})

it('fingerprints the configured routes independently of their order', async (test) => {
  const another = { ...route, action: 'read-record' }
  const first = await fixture(test, { routes: [statusRoute, another] })
  const second = await fixture(test, { routes: [another, statusRoute] })
  expect(first.broker.fingerprint).toBe(second.broker.fingerprint)
})

it('lists actions in action ID order with usage text that leaves the fingerprint unchanged', async (test) => {
  const description = 'Create one record. The body is {"name": string}.'
  const another = { ...route, action: 'archive-record' }
  const { broker, resolve } = await fixture(test, { routes: [{ ...route, description }, another] })
  const routeDigest = true
  expect(broker.actions().map(entry => ({ ...entry, routeDigest: /^[0-9a-f]{64}$/u.test(entry.routeDigest) }))).toEqual([
    { action: 'archive-record', credentialRef: route.credentialRef, routeDigest },
    { action: route.action, description, credentialRef: route.credentialRef, routeDigest },
  ])
  const undescribed = (await fixture(test, { routes: [route, another] })).broker
  expect(broker.fingerprint).toBe(undescribed.fingerprint)
  expect(broker.actions().map(entry => entry.routeDigest)).toEqual(undescribed.actions().map(entry => entry.routeDigest))
  expect(resolve).not.toHaveBeenCalled()
  const ctx = new Context()
  expect(() => new HttpsJsonBroker(ctx, { routes: [{ ...route, description: 'x'.repeat(2001) }] })).toThrow()
  expect(() => new HttpsJsonBroker(ctx, { routes: [{ ...route, description: '' }] })).toThrow()
})

it.for([
  ['usage text and the timeout', { routes: [{ ...statusRoute, returnResponse: true, description: 'Create a record.' }, { ...route, action: 'archive-record' }], timeoutMs: 1_000 }, []],
  ["the other action's endpoint", { routes: [{ ...statusRoute, returnResponse: true }, { ...route, action: 'archive-record', endpoint: 'https://example.test/archive' }] }, ['archive-record']],
  ['the response limit, which only a returning action uses', { routes: [{ ...statusRoute, returnResponse: true }, { ...route, action: 'archive-record' }], maxResponseBytes: 64 }, ['create-record']],
  ['the status endpoint', { routes: [{ ...statusRoute, reconciliationEndpoint: 'https://example.test/other-status', returnResponse: true }, { ...route, action: 'archive-record' }] }, ['create-record']],
  ['the removed status endpoint', { routes: [{ ...route, returnResponse: true }, { ...route, action: 'archive-record' }] }, ['create-record']],
  ['the credential reference', { routes: [{ ...statusRoute, credentialRef: 'ROTATED_TOKEN', returnResponse: true }, { ...route, action: 'archive-record' }] }, ['create-record']],
  ['whether the response is returned', { routes: [statusRoute, { ...route, action: 'archive-record' }] }, ['create-record']],
  ['the body limit', { routes: [{ ...statusRoute, returnResponse: true }, { ...route, action: 'archive-record' }], maxBodyBytes: 64 }, ['archive-record', 'create-record']],
] satisfies [string, Config, string[]][])('changes the route digest of exactly the affected actions when the operator changes %s', async ([_change, config, changed], test) => {
  const digests = async (changedConfig: Config) => Object.fromEntries((await fixture(test, changedConfig)).broker.actions()
    .map(({ action, routeDigest }) => [action, routeDigest]))
  const original = await digests({ routes: [{ ...statusRoute, returnResponse: true }, { ...route, action: 'archive-record' }] })
  const current = await digests(config)
  expect(Object.keys(current).filter(action => current[action] !== original[action])).toEqual(changed)
})

it('rejects route changes before looking up the credential', async (test) => {
  const { broker } = await fixture(test, { routes: [statusRoute] })
  const spec = broker.resolve(route.action, '{}', identity)
  expect(spec.reconciliationEndpoint).toBe(statusRoute.reconciliationEndpoint)
  for (const changedRoute of [
    { ...statusRoute, credentialRef: 'ROTATED_RECORDS_TOKEN' },
    { ...statusRoute, endpoint: 'https://example.test/changed' },
    { ...statusRoute, reconciliationEndpoint: 'https://example.test/changed-status' },
    route,
  ]) {
    const changed = await fixture(test, { routes: [changedRoute] })
    expect(changed.broker.fingerprint).not.toBe(broker.fingerprint)
    const failure = { code: 'broker-route-changed', dispatch: 'not-sent' }
    await expect(changed.broker.run(spec, correlation, signal)).rejects.toMatchObject(failure)
    await expect(changed.broker.reconcile(spec, correlation, signal)).rejects.toMatchObject(failure)
    expect(changed.resolve).not.toHaveBeenCalled()
  }
})

it('rejects status lookup on an opted-out route before resolving credentials', async (test) => {
  const { broker, resolve } = await fixture(test, { routes: [route] })
  await expect(broker.reconcile(broker.resolve(route.action, '{}', identity), correlation, signal)).rejects.toMatchObject({
    code: 'broker-reconciliation-unavailable', dispatch: 'not-sent',
  })
  expect(resolve).not.toHaveBeenCalled()
})

it('contains credential provider failures and malformed bearer tokens', async (test) => {
  const { broker, resolve } = await fixture(test, { routes: [route] })
  const spec = broker.resolve(route.action, '{}', identity)
  resolve.mockRejectedValueOnce(new Error('fixture-private-provider-detail'))
  const failedLookup = broker.run(spec, correlation, signal)
  await expect(failedLookup).rejects.toMatchObject({
    code: 'broker-credential-unavailable', dispatch: 'not-sent',
    message: 'The authority could not resolve the broker credential.',
  })
  await expect(failedLookup).rejects.not.toHaveProperty('cause')
  resolve.mockResolvedValueOnce({ value: 'token\nwith-control-byte', source: 'fixture' })
  await expect(broker.run(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-credential-invalid', dispatch: 'not-sent' })
})

it('stops a request canceled during credential lookup before dispatch', async (test) => {
  const { broker, resolve } = await fixture(test, { routes: [route] })
  const lookup = Promise.withResolvers<ResolvedCredential>()
  resolve.mockReturnValue(lookup.promise)
  const controller = new AbortController()
  const pending = broker.run(broker.resolve(route.action, '{}', identity), correlation, controller.signal)
  expect(resolve).toHaveBeenCalledExactlyOnceWith(route.credentialRef)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'broker-canceled', dispatch: 'not-sent' })
  lookup.resolve({ value: 'fixture-late-token', source: 'fixture' })
})

it('sends exact HTTPS JSON with the current token and reports only the HTTP status', async (test) => {
  const observed: object[] = []
  const https = await httpsFixture(test, (request, response) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const token = request.headers.authorization
      observed.push({
        path: request.url, method: request.method, token, userAgent: request.headers['user-agent'], body,
        operationId: request.headers['idempotency-key'], payloadDigest: request.headers['x-dsh-request-digest'],
      })
      if (observed.length === 3) {
        request.socket.destroy()
        return
      }
      if (observed.length === 4) {
        response.writeHead(101, { connection: 'upgrade', upgrade: 'fixture' }).end()
        return
      }
      if (observed.length === 5) {
        response.writeHead(700).end()
        return
      }
      response.writeHead(307, { location: '/redirected', 'x-credential-echo': token ?? '' })
      response.end(token)
    })
  })
  const endpoint = `${https.origin}/records?fixed=1`
  const { broker, resolve } = await fixture(test, { routes: [{ ...route, endpoint }] })
  const body = '{ "message": "é" }\n'
  const spec = broker.resolve(route.action, body, identity)
  resolve.mockResolvedValueOnce({ value: 'fixture-first-token', source: 'fixture' })
    .mockResolvedValue({ value: 'fixture-rotated-token', source: 'fixture' })

  await https.withTrust(async () => {
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ kind: 'http-response', statusCode: 307 })
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ kind: 'http-response', statusCode: 307 })
    await expect(broker.run(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'unknown' })
    await expect(broker.run(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'unknown' })
    await expect(broker.run(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'unknown' })
  })
  expect(observed).toEqual(['fixture-first-token', ...Array<string>(4).fill('fixture-rotated-token')].map(token => ({
    path: '/records?fixed=1', method: 'POST', token: `Bearer ${token}`, userAgent: 'deepseek-harness', body, ...correlation,
  })))
})

it('returns a bounded UTF-8 response only for a route configured to return it and keeps the status otherwise', async (test) => {
  const replies: ((response: ServerResponse) => void)[] = [
    (response) => { response.writeHead(200).end('{"ok":false,"error":"channel_not_found"}') },
    (response) => { response.writeHead(200).end('x'.repeat(65)) },
    (response) => { response.writeHead(200).end(Buffer.from([0xff, 0xfe])) },
    (response) => { response.writeHead(200).end('echo fixture-token') },
    (response) => {
      response.writeHead(200, { 'content-length': 10 }).write('half', () => { setTimeout(() => { response.socket?.destroy() }, 50) })
    },
    (response) => { response.writeHead(200).end('{"ok":true}') },
  ]
  const https = await httpsFixture(test, (request, response) => {
    request.resume().once('end', () => { replies.shift()?.(response) })
  })
  const returning = { ...route, endpoint: `${https.origin}/post`, returnResponse: true }
  const silent = { ...route, action: 'silent-record', endpoint: `${https.origin}/silent` }
  const { broker, resolve } = await fixture(test, { routes: [returning, silent], maxResponseBytes: 64 })
  resolve.mockResolvedValue({ value: 'fixture-token', source: 'fixture' })
  const spec = broker.resolve(returning.action, '{}', identity)
  await https.withTrust(async () => {
    const received = { kind: 'http-response', statusCode: 200 }
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ ...received, body: '{"ok":false,"error":"channel_not_found"}' })
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ ...received, bodyOmitted: 'too-large' })
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ ...received, bodyOmitted: 'not-utf8' })
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ ...received, bodyOmitted: 'contains-credential' })
    await expect(broker.run(spec, correlation, signal)).resolves.toEqual({ ...received, bodyOmitted: 'unavailable' })
    await expect(broker.run(broker.resolve(silent.action, '{}', identity), correlation, signal)).resolves.toEqual(received)
  })
  const plain = await fixture(test, { routes: [{ ...returning, returnResponse: false }, silent], maxResponseBytes: 64 })
  expect(plain.broker.fingerprint).not.toBe(broker.fingerprint)
  const unbounded = await fixture(test, { routes: [{ ...returning, returnResponse: false }, silent] })
  expect(plain.broker.fingerprint).toBe(unbounded.broker.fingerprint)
})

it('reconciles an applied POST with one authenticated GET after response loss and a lower POST body limit', async (test) => {
  const records = new Map<string, { body: string; digest: string }>()
  const observed: object[] = []
  const https = await httpsFixture(test, (request, response) => {
    request.setEncoding('utf8')
    let body = ''
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      observed.push({
        path: request.url, method: request.method, token: request.headers.authorization, userAgent: request.headers['user-agent'], body,
      })
      if (request.method === 'POST') {
        const operationId = request.headers['idempotency-key']
        const digest = request.headers['x-dsh-request-digest']
        if (typeof operationId === 'string' && typeof digest === 'string') records.set(operationId, { body, digest })
        request.socket.destroy()
        return
      }
      const query = new URL(request.url ?? '', 'https://unused.test').searchParams
      const operationId = query.get('operationId') ?? ''
      const record = records.get(operationId)
      if (record === undefined || query.get('payloadDigest') !== record.digest) {
        response.writeHead(404).end()
        return
      }
      response.setHeader('x-ignored', request.headers.authorization ?? '')
      response.end(JSON.stringify({
        operationId, payloadDigest: record.digest, status: 'succeeded', receiptId: 'receipt-73', raw: request.headers.authorization,
      }))
    })
  })
  const endpoint = `${https.origin}/records`
  const reconciliationEndpoint = `${https.origin}/records/status?tenant=example%20test`
  const routes = [{ ...route, endpoint, reconciliationEndpoint }]
  const { broker, resolve } = await fixture(test, { routes, maxBodyBytes: 32 })
  const body = '{"name":"persisted"}'
  const spec = broker.resolve(route.action, body, identity)
  resolve.mockResolvedValueOnce({ value: 'fixture-send-token', source: 'fixture' })
  await https.withTrust(async () => {
    await expect(broker.run(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'unknown' })
    expect(records.get(correlation.operationId)).toEqual({ body, digest: correlation.payloadDigest })
    const lookup = await fixture(test, { routes, maxBodyBytes: 8 })
    lookup.resolve.mockResolvedValueOnce({ value: 'fixture-lookup-token', source: 'fixture' })
    expect(() => lookup.broker.resolve(route.action, body, identity)).toThrow(expect.objectContaining({ code: 'broker-invalid-body' }))
    await expect(lookup.broker.reconcile(spec, correlation, signal)).resolves.toEqual({ kind: 'succeeded', receiptId: 'receipt-73' })
  })
  expect(observed).toEqual([
    { path: '/records', method: 'POST', token: 'Bearer fixture-send-token', userAgent: 'deepseek-harness', body },
    {
      path: `/records/status?tenant=example%20test&operationId=${correlation.operationId}&payloadDigest=${correlation.payloadDigest}`,
      method: 'GET', token: 'Bearer fixture-lookup-token', userAgent: 'deepseek-harness', body: '',
    },
  ])
})

it('accepts bound pending and failure statuses and rejects unconfirmed lookups', async (test) => {
  const token = 'fixture-secret-token'
  const failed = { ...correlation, status: 'failed', receiptId: 'receipt-failed' }
  const terminal = JSON.stringify(failed)
  const responses = [
    { code: 200, body: JSON.stringify({ ...correlation, status: 'pending', internal: token }), result: { kind: 'pending' } },
    { code: 200, body: terminal.padEnd(4096), result: { kind: 'failed', receiptId: 'receipt-failed' } },
    { code: 404, body: terminal },
    { code: 307, body: terminal },
    { code: 101, body: '' },
    { code: 200, body: '{' },
    { code: 200, body: 'null' },
    { code: 200, body: '"fixture"' },
    { code: 200, body: JSON.stringify({ ...failed, operationId: undefined }) },
    { code: 200, body: JSON.stringify({ ...failed, operationId: 'other-operation' }) },
    { code: 200, body: JSON.stringify({ ...failed, payloadDigest: undefined }) },
    { code: 200, body: JSON.stringify({ ...failed, payloadDigest: '6'.repeat(64) }) },
    { code: 200, body: JSON.stringify({ ...failed, status: undefined }) },
    { code: 200, body: JSON.stringify({ ...failed, status: 'not-found' }) },
    { code: 200, body: JSON.stringify({ ...failed, receiptId: undefined }) },
    { code: 200, body: JSON.stringify({ ...failed, receiptId: 42 }) },
    { code: 200, body: JSON.stringify({ ...failed, receiptId: 'x'.repeat(129) }) },
    { code: 200, body: JSON.stringify({ ...failed, receiptId: `echo-${token}` }) },
    { code: 200, body: Buffer.concat([Buffer.from(terminal), Buffer.from([255])]) },
    { code: 200, body: JSON.stringify({ ...failed, excess: 'é'.repeat(2048) }) },
    { code: 200, body: terminal, partial: true },
  ]
  const paths: (string | undefined)[] = []
  const https = await httpsFixture(test, (request, response) => {
    const next = responses[paths.length]
    paths.push(request.url)
    if (next === undefined) {
      response.writeHead(500).end()
      return
    }
    response.setHeader('location', '/redirected')
    response.setHeader('x-ignored', token)
    if (next.code === 101) {
      response.setHeader('connection', 'upgrade')
      response.setHeader('upgrade', 'fixture')
    }
    if (next.partial) response.setHeader('content-length', Buffer.byteLength(next.body) + 1)
    response.writeHead(next.code).end(next.body)
  })
  const { broker, resolve } = await fixture(test, { routes: [{
    ...route, endpoint: `${https.origin}/records`, reconciliationEndpoint: `${https.origin}/records/status`,
  }] })
  const spec = broker.resolve(route.action, '{}', identity)
  resolve.mockResolvedValue({ value: token, source: 'fixture' })
  await expect(broker.reconcile(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-reconciliation-unconfirmed' })
  expect(paths).toEqual([])
  await https.withTrust(async () => {
    for (const expected of responses) {
      const lookup = broker.reconcile(spec, correlation, signal)
      if (expected.result === undefined) {
        await expect(lookup).rejects.toMatchObject({
          code: 'broker-reconciliation-unconfirmed',
          message: 'The broker status lookup did not confirm a business status.',
        })
        await expect(lookup).rejects.not.toHaveProperty('cause')
      } else {
        await expect(lookup).resolves.toEqual(expected.result)
      }
    }
  })
  expect(paths).toEqual(responses.map(() => `/records/status?operationId=${correlation.operationId}&payloadDigest=${correlation.payloadDigest}`))
})

it('trusts a CA only for its configured route and status lookup and binds its contents to route identity', async (test) => {
  const directory = mkdtempSync(join(tmpdir(), 'broker-ca-'))
  test.onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const ca = join(directory, 'ca.pem')
  const calls: string[] = []
  const { origin, cert } = await httpsFixture(test, (req, res) => {
    calls.push(req.method ?? '')
    if (req.method === 'POST') res.writeHead(202).end()
    else res.writeHead(200).end(JSON.stringify({ ...correlation, status: 'succeeded', receiptId: 'receipt-1' }))
  })
  writeFileSync(ca, cert)
  const routes = [{ ...route, endpoint: `${origin}/records`, reconciliationEndpoint: `${origin}/status`, ca },
    { ...route, action: 'untrusted', endpoint: `${origin}/records` }]
  const { broker, resolve } = await fixture(test, { routes })
  resolve.mockResolvedValue({ value: 'fixture-token', source: 'fixture' })
  const spec = broker.resolve(route.action, '{}', identity)
  expect(await broker.run(spec, correlation, signal)).toEqual({ kind: 'http-response', statusCode: 202 })
  expect(await broker.reconcile(spec, correlation, signal)).toMatchObject({ kind: 'succeeded', receiptId: 'receipt-1' })
  await expect(broker.run(broker.resolve('untrusted', '{}', identity), correlation, signal))
    .rejects.toMatchObject({ code: 'broker-response-unavailable' })
  expect(calls).toEqual(['POST', 'GET'])
  writeFileSync(ca, generate().cert)
  const changed = (await fixture(test, { routes })).broker
  expect(changed.fingerprint).not.toBe(broker.fingerprint)
  expect(changed.actions()[0]?.routeDigest).not.toBe(broker.actions()[0]?.routeDigest)
  expect(changed.actions()[1]?.routeDigest).toBe(broker.actions()[1]?.routeDigest)
  writeFileSync(ca, 'invalid PEM')
  await expect(fixture(test, { routes })).rejects.toThrow()
  await expect(fixture(test, { routes: [{ ...route, ca: join(directory, 'missing.pem') }] })).rejects.toThrow()
})
