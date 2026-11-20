/** The MCP tool provider calls only configured tools, with the authority's token, and reports what the server returned. */
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { generate } from 'selfsigned'
import { expect, it, vi, type TestContext } from 'vitest'
import { z } from 'zod'
import type { BrokerCorrelation } from '../src/index.ts'
import McpToolBroker, { type Config, type McpToolConfig } from '../src/mcp.ts'

const correlation: BrokerCorrelation = {
  operationId: brandString<BrokerCorrelation['operationId']>('7df4dd65-6b61-4a35-ae16-28f9af7ac1ee'), payloadDigest: 'a'.repeat(64),
}
const identity = { parentId: correlation.operationId, requestKey: '943eeb66-e002-440b-915b-a0521cf616e1' }
const token = 'fixture-token'

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

/** A loopback MCP server over TLS whose certificate the test trusts for its duration. */
async function server(test: TestContext, trust = true) {
  const calls: Array<{ tool: string; text: string; authorization: string | undefined }> = []
  const handler = createMcpHandler(({ requestInfo }) => {
    const mcp = new McpServer({ name: 'broker-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    const record = (tool: string, text: string): void => {
      calls.push({ tool, text, authorization: requestInfo?.headers.get('authorization') ?? undefined })
    }
    mcp.registerTool('post_note', { description: 'Stores a note.', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => {
      record('post_note', text)
      if (text === 'reject') return { isError: true, content: [{ type: 'text', text: 'note refused' }] }
      if (text === 'echo-token') return { content: [{ type: 'text', text: `seen ${requestInfo?.headers.get('authorization')}` }] }
      if (text === 'large') return { content: [{ type: 'text', text: `${requestInfo?.headers.get('authorization')} ${'x'.repeat(40_000)}` }] }
      if (text === 'images') return { content: Array.from({ length: 20 }, () => ({ type: 'image' as const, data: '', mimeType: 'image/png' })) }
      return { content: [{ type: 'text', text: `stored ${text}` }, { type: 'text', text: 'second line' }] }
    })
    mcp.registerTool('notify', { inputSchema: z.object({ recipientId: z.number() }) }, async (args) => {
      record('notify', JSON.stringify(args))
      return { content: [] }
    })
    mcp.registerTool('delete_all', { description: 'Not permitted.', inputSchema: z.object({}) }, async () => {
      record('delete_all', '')
      return { content: [] }
    })
    return mcp
  })
  const { cert, private: key } = generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  })
  const handle = toNodeHandler(handler)
  const https = createServer({ cert, key }, (request, response) => {
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => { response.writeHead(500).end(String(error)) })
  })
  const listening = once(https, 'listening')
  https.listen(0, '127.0.0.1')
  await listening
  const original = getCACertificates('default')
  if (trust) setDefaultCACertificates([...original, cert])
  test.onTestFinished(async () => {
    setDefaultCACertificates(original)
    await handler.close()
    const closed = once(https, 'close')
    https.close()
    https.closeAllConnections()
    await closed
  })
  const address = https.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback HTTPS listener.')
  return { url: `https://127.0.0.1:${address.port}/mcp`, calls, cert }
}

const storedToken: CredentialProvider['resolve'] = async () => ({ value: token, source: 'fixture' })

async function broker(test: TestContext, config: Config, resolve = storedToken) {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(FixtureCredentials, vi.fn<CredentialProvider['resolve']>(resolve))
  await ctx.plugin(McpToolBroker, config)
  return ctx.operationBrokerMcp
}

const tools = [
  { action: 'post-note', tool: 'post_note', description: 'Store a note. Body: {"text": string}.', returnResponse: true },
  { action: 'post-note-quiet', tool: 'post_note' },
]

it('calls a configured tool with the stored token and returns its text only for a returning action', async (test) => {
  const { url, calls } = await server(test)
  const provider = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }] })
  const routeDigest = true
  expect(provider.actions().map(entry => ({ ...entry, routeDigest: /^[0-9a-f]{64}$/u.test(entry.routeDigest) }))).toEqual([
    { action: 'post-note', description: 'Store a note. Body: {"text": string}.', credentialRef: 'NOTES_TOKEN', returnsResponse: true, routeDigest },
    { action: 'post-note-quiet', credentialRef: 'NOTES_TOKEN', routeDigest },
  ])
  const signal = new AbortController().signal
  const spec = provider.resolve('post-note', '{"text":"hello"}', identity)
  expect(spec).toEqual({ action: 'post-note', method: 'POST', endpoint: url, tool: 'post_note', credentialRef: 'NOTES_TOKEN', body: '{"text":"hello"}' })
  expect(await provider.run(spec, correlation, signal)).toEqual({ kind: 'tool-result', isError: false, body: 'stored hello\nsecond line' })
  expect(await provider.run(provider.resolve('post-note-quiet', '{"text":"quiet"}', identity), correlation, signal))
    .toEqual({ kind: 'tool-result', isError: false })
  expect(await provider.run(provider.resolve('post-note', '{"text":"reject"}', identity), correlation, signal))
    .toEqual({ kind: 'tool-result', isError: true, body: 'note refused' })
  expect(await provider.run(provider.resolve('post-note', '{"text":"echo-token"}', identity), correlation, signal))
    .toEqual({ kind: 'tool-result', isError: false, bodyOmitted: 'contains-credential' })
  expect(calls.map(call => [call.tool, call.text, call.authorization])).toEqual([
    ['post_note', 'hello', `Bearer ${token}`], ['post_note', 'quiet', `Bearer ${token}`],
    ['post_note', 'reject', `Bearer ${token}`], ['post_note', 'echo-token', `Bearer ${token}`],
  ])
  await expect(provider.reconcile(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-reconciliation-unavailable', dispatch: 'not-sent' })
})

it('prepares the same numeric JSON text the MCP tool receives', async (test) => {
  const body = '{"recipientId":9007199254740993}'
  const expected = '{"recipientId":9007199254740992}'
  const { url, calls } = await server(test)
  const provider = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools: [{ action: 'notify', tool: 'notify' }] }] })
  const spec = provider.resolve('notify', body, identity)
  expect(await provider.run(spec, correlation, new AbortController().signal)).toEqual({ kind: 'tool-result', isError: false })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.text).toBe(expected)
  expect(spec.body).toBe(calls[0]?.text)
})

it('completes a call whose result exceeds the response limit, omitting the text only for a returning action', async (test) => {
  const { url, calls } = await server(test)
  const provider = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }] })
  const signal = new AbortController().signal
  expect(await provider.run(provider.resolve('post-note', '{"text":"large"}', identity), correlation, signal))
    .toEqual({ kind: 'tool-result', isError: false, bodyOmitted: 'too-large' })
  expect(await provider.run(provider.resolve('post-note-quiet', '{"text":"large"}', identity), correlation, signal))
    .toEqual({ kind: 'tool-result', isError: false })
  expect(calls.map(call => call.text)).toEqual(['large', 'large'])
})

it('stops reading past the read limit: an unknown outcome after the call, not sent during the handshake', async (test) => {
  const { url, calls } = await server(test)
  const signal = new AbortController().signal
  const afterCall = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }], maxReadBytes: 20_000 })
  for (const action of ['post-note', 'post-note-quiet']) {
    const error: unknown = await afterCall.run(afterCall.resolve(action, '{"text":"large"}', identity), correlation, signal)
      .then(() => undefined, (rejection: unknown) => rejection)
    expect(error).toMatchObject({ code: 'broker-response-unavailable', dispatch: 'unknown' })
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(token)
  }
  const handshake = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }], maxReadBytes: 1 })
  await expect(handshake.run(handshake.resolve('post-note', '{"text":"hello"}', identity), correlation, signal))
    .rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'not-sent' })
  expect(calls.map(call => call.text)).toEqual(['large', 'large'])
})

it('omits result text that grows past the limit when projected', async (test) => {
  const { url } = await server(test)
  const provider = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }], maxResponseBytes: 2_000 })
  expect(await provider.run(provider.resolve('post-note', '{"text":"images"}', identity), correlation, new AbortController().signal))
    .toEqual({ kind: 'tool-result', isError: false, bodyOmitted: 'too-large' })
})

it('ends a credential lookup that never settles at the deadline without contacting the server', async (test) => {
  const { url, calls } = await server(test)
  const provider = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }], timeoutMs: 50 }, () => new Promise(() => {}))
  await expect(provider.run(provider.resolve('post-note', '{"text":"hello"}', identity), correlation, new AbortController().signal))
    .rejects.toMatchObject({ code: 'broker-canceled', dispatch: 'not-sent' })
  expect(calls).toEqual([])
})

it('refuses unlisted tools, non-object arguments, a changed route, and a missing token before contacting the server', async (test) => {
  const { url, calls } = await server(test)
  const provider = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }], maxBodyBytes: 32 })
  const signal = new AbortController().signal
  expect(() => provider.resolve('delete-all', '{}', identity)).toThrow(expect.objectContaining({ code: 'broker-action-unavailable' }))
  for (const body of ['[]', '"text"', 'null', '{', JSON.stringify({ text: 'x'.repeat(40) })]) {
    expect(() => provider.resolve('post-note', body, identity)).toThrow(expect.objectContaining({ code: 'broker-invalid-body', dispatch: 'not-sent' }))
  }
  const spec = provider.resolve('post-note', '{"text":"hello"}', identity)
  for (const changed of [{ ...spec, tool: 'delete_all' }, { ...spec, endpoint: 'https://other.example.test/mcp' }]) {
    await expect(provider.run(changed, correlation, signal)).rejects.toMatchObject({ code: 'broker-route-changed', dispatch: 'not-sent' })
  }
  const aborted = new AbortController()
  aborted.abort()
  await expect(provider.run(spec, correlation, aborted.signal)).rejects.toMatchObject({ code: 'broker-canceled', dispatch: 'not-sent' })
  const withoutToken = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }] }, async () => undefined)
  await expect(withoutToken.run(spec, correlation, signal)).rejects.toMatchObject({ code: 'broker-credential-unavailable', dispatch: 'not-sent' })
  expect(calls).toEqual([])
})

it('reports an unreachable server as not sent and rejects invalid configuration', async (test) => {
  const unreachable = await broker(test, { servers: [{ url: 'https://127.0.0.1:9/mcp', credentialRef: 'NOTES_TOKEN', tools }], timeoutMs: 2_000 })
  await expect(unreachable.run(unreachable.resolve('post-note', '{"text":"hello"}', identity), correlation, new AbortController().signal))
    .rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'not-sent' })
  const mount = (config: Config) => broker(test, config)
  await expect(mount({ servers: [{ url: 'http://127.0.0.1/mcp', credentialRef: 'NOTES_TOKEN', tools }] })).rejects.toThrow('canonical HTTPS endpoint')
  await expect(mount({ servers: [{ url: 'https://example.test/mcp', credentialRef: 'not a name', tools }] })).rejects.toThrow('credential reference name')
  await expect(mount({ servers: [
    { url: 'https://example.test/mcp', credentialRef: 'NOTES_TOKEN', tools: [tools[1]!] },
    { url: 'https://other.example.test/mcp', credentialRef: 'OTHER_TOKEN', tools: [tools[1]!] },
  ] })).rejects.toThrow('configured more than once')
})

it.for([
  ['usage text, the timeout, and the read limit', { tools: [{ ...tools[0]!, description: 'Other text.' }, tools[1]!], timeoutMs: 1_000, maxReadBytes: 1_024 }, []],
  ["the other action's tool", { tools: [tools[0]!, { ...tools[1]!, tool: 'delete_all' }] }, ['post-note-quiet']],
  ['the response limit, which only a returning action uses', { tools, maxResponseBytes: 1_024 }, ['post-note']],
  ['the server URL', { tools, url: 'https://example.test/other-mcp' }, ['post-note', 'post-note-quiet']],
  ['the credential reference', { tools, credentialRef: 'ROTATED_TOKEN' }, ['post-note', 'post-note-quiet']],
  ['whether the result is returned', { tools: [{ ...tools[0]!, returnResponse: false }, tools[1]!] }, ['post-note']],
  ['the body limit', { tools, maxBodyBytes: 64 }, ['post-note', 'post-note-quiet']],
] as const)('changes the route digest of exactly the affected actions when the operator changes %s', async ([_change, change, changed], test) => {
  const digests = async ({ tools: configured, url = 'https://example.test/mcp', credentialRef = 'NOTES_TOKEN', ...limits }: {
    tools: readonly McpToolConfig[]
    url?: string
    credentialRef?: string
  } & Omit<Config, 'servers'>) => Object.fromEntries((await broker(test, { servers: [{ url, credentialRef, tools: [...configured] }], ...limits }))
    .actions().map(({ action, routeDigest }) => [action, routeDigest]))
  const original = await digests({ tools })
  const current = await digests(change)
  expect(Object.keys(current).filter(action => current[action] !== original[action])).toEqual(changed)
})

it('changes its fingerprint with the permitted tools, the response and read limits, and the returned response', async (test) => {
  const server = { url: 'https://example.test/mcp', credentialRef: 'NOTES_TOKEN' }
  const base = await broker(test, { servers: [{ ...server, tools: [tools[1]!] }] })
  const same = await broker(test, { servers: [{ ...server, tools: [tools[1]!] }] })
  const otherTool = await broker(test, { servers: [{ ...server, tools: [{ action: 'post-note-quiet', tool: 'delete_all' }] }] })
  const returning = await broker(test, { servers: [{ ...server, tools: [{ ...tools[1]!, returnResponse: true }] }] })
  const smaller = await broker(test, { servers: [{ ...server, tools: [tools[1]!] }], maxResponseBytes: 1_024 })
  const smallerRead = await broker(test, { servers: [{ ...server, tools: [tools[1]!] }], maxReadBytes: 1_024 })
  expect(same.fingerprint).toBe(base.fingerprint)
  const fingerprints = [base, otherTool, returning, smaller, smallerRead].map(provider => provider.fingerprint)
  expect(new Set(fingerprints).size).toBe(5)
})

it('trusts a CA only for its MCP endpoint and binds its contents to route identity', async (test) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-ca-'))
  test.onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const ca = join(directory, 'ca.pem')
  const { url, cert, calls } = await server(test, false)
  writeFileSync(ca, cert)
  const servers = [{ url, ca, credentialRef: 'NOTES_TOKEN', tools }]
  const trusted = await broker(test, { servers })
  const signal = new AbortController().signal
  expect(await trusted.run(trusted.resolve('post-note', '{"text":"trusted"}', identity), correlation, signal))
    .toMatchObject({ kind: 'tool-result', body: 'stored trusted\nsecond line' })
  const untrusted = await broker(test, { servers: [{ url, credentialRef: 'NOTES_TOKEN', tools }] })
  await expect(untrusted.run(untrusted.resolve('post-note', '{"text":"untrusted"}', identity), correlation, signal))
    .rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'not-sent' })
  expect(calls).toHaveLength(1)
  writeFileSync(ca, generate().cert)
  const changed = await broker(test, { servers })
  expect(changed.fingerprint).not.toBe(trusted.fingerprint)
  expect(changed.actions()[0]?.routeDigest).not.toBe(trusted.actions()[0]?.routeDigest)
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
  try {
    await expect(changed.run(changed.resolve('post-note', '{"text":"wrong-ca"}', identity), correlation, signal))
      .rejects.toMatchObject({ code: 'broker-response-unavailable', dispatch: 'not-sent' })
  } finally {
    vi.unstubAllEnvs()
  }
  writeFileSync(ca, 'invalid PEM')
  await expect(broker(test, { servers })).rejects.toThrow()
  await expect(broker(test, { servers: [{ ...servers[0], url, tools, credentialRef: 'NOTES_TOKEN', ca: join(directory, 'missing.pem') }] }))
    .rejects.toThrow()
})
