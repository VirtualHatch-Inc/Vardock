/** Transport policy is enforced on the Host socket, independently of guest proxy settings. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createConnection, createServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { expect, it, vi, type TestContext } from 'vitest'
import { ExecutionGateway } from '../src/gateway.ts'

async function boot(test: TestContext, allowedTargets: string[], maxConnections = 64) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gateway-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'proxy.sock')
  const gateway = new ExecutionGateway({ socketPath, allowedTargets, idleTimeoutMs: 60_000, maxConnections })
  test.onTestFinished(() => gateway.close())
  await gateway.ready()
  return { gateway, socketPath }
}

async function connect(test: TestContext, socketPath: string, target: string) {
  const socket = createConnection(socketPath)
  test.onTestFinished(async () => {
    if (socket.closed) return
    const closed = once(socket, 'close')
    socket.destroy()
    await closed
  })
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
  const dataEvent: unknown[] = await response
  const data = dataEvent[0]
  expect(Buffer.isBuffer(data)).toBe(true)
  return { socket, response: String(data) }
}

function post(socketPath: string, token: string, body: string, signal?: AbortSignal) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const client = request({
      socketPath, path: '/business', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) },
      ...(signal === undefined ? {} : { signal }),
    }, (response) => {
      void text(response).then((body) => { resolve({ status: response.statusCode, body }) }, reject)
    })
    client.on('error', reject)
    client.end(body)
  })
}

it.skipIf(process.platform === 'win32')('routes guest requests only to the live execution holding the credential', async (test) => {
  const { gateway, socketPath } = await boot(test, [])
  const signal = new AbortController().signal
  const run = vi.fn(async (value: unknown) => ({ value }))
  const other = vi.fn(async () => ({ other: true }))
  const first = gateway.registerBroker(run, signal)
  const second = gateway.registerBroker(other, signal)

  expect(first.token).not.toBe(second.token)
  expect(await post(socketPath, 'invalid', '{}')).toMatchObject({ status: 403 })
  expect(await post(socketPath, first.token, '{"input":"first"}')).toEqual({ status: 200, body: '{"value":{"input":"first"}}' })
  expect(run).toHaveBeenCalledExactlyOnceWith({ input: 'first' }, expect.any(AbortSignal))
  expect(other).not.toHaveBeenCalled()
  expect(await post(socketPath, second.token, '{}')).toEqual({ status: 200, body: '{"other":true}' })
  expect((await connect(test, socketPath, 'example.com:443')).response).toContain('403 Forbidden')

  await first.dispose()
  expect(await post(socketPath, first.token, '{}')).toMatchObject({ status: 403 })
  expect(run).toHaveBeenCalledOnce()
  expect(await post(socketPath, second.token, '{}')).toMatchObject({ status: 200 })
})

it.skipIf(process.platform === 'win32')('refuses broker credentials when raw CONNECT targets are configured', async (test) => {
  const { gateway } = await boot(test, ['example.com:443'])
  expect(() => gateway.registerBroker(() => Promise.resolve(null), new AbortController().signal))
    .toThrow('empty CONNECT allowlist')
})

it.skipIf(process.platform === 'win32')('bounds business request and response bytes and keeps callback errors private', async (test) => {
  const { gateway, socketPath } = await boot(test, [])
  const run = vi.fn<(input: unknown) => Promise<unknown>>()
    .mockResolvedValueOnce('x'.repeat(1024 * 1024))
    .mockRejectedValueOnce(new Error('private provider diagnostic'))
  const { token } = gateway.registerBroker(run, new AbortController().signal)

  expect(await post(socketPath, token, '{')).toMatchObject({ status: 400 })
  expect(await post(socketPath, token, ' '.repeat(256 * 1024 + 1))).toMatchObject({ status: 413 })
  expect(run).not.toHaveBeenCalled()
  expect(await post(socketPath, token, '{}')).toMatchObject({ status: 502 })
  expect(await post(socketPath, token, '{}')).toEqual({ status: 502, body: '{"error":"Business request could not be completed."}' })
})

it.skipIf(process.platform === 'win32').for(['guest disconnect', 'shell cancellation'] as const)(
  'cancels and drains an admitted request after %s', async (trigger, test) => {
    const { gateway, socketPath } = await boot(test, [])
    const entered = Promise.withResolvers<AbortSignal>()
    const canceled = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<null>()
    test.onTestFinished(() => { released.resolve(null) })
    const shell = new AbortController()
    const registration = gateway.registerBroker((_request, signal) => {
      signal.addEventListener('abort', () => { canceled.resolve(undefined) }, { once: true })
      entered.resolve(signal)
      return released.promise
    }, shell.signal)
    const requestAbort = new AbortController()
    const pending = post(socketPath, registration.token, '{}', requestAbort.signal)
    const failed = expect(pending).rejects.toBeInstanceOf(Error)
    const signal = await entered.promise
    if (trigger === 'guest disconnect') requestAbort.abort()
    else shell.abort()
    await failed
    await canceled.promise
    expect(signal.aborted).toBe(true)
    if (trigger === 'shell cancellation') expect(await post(socketPath, registration.token, '{}')).toMatchObject({ status: 403 })

    let disposed = false
    const disposing = registration.dispose().then(() => { disposed = true })
    expect(await post(socketPath, registration.token, '{}')).toMatchObject({ status: 403 })
    expect(disposed).toBe(false)
    released.resolve(null)
    await disposing
  },
)

it.skipIf(process.platform === 'win32')('rejects every target with an empty allowlist', async (test) => {
  const { socketPath } = await boot(test, [])
  expect((await connect(test, socketPath, 'example.com:443')).response).toContain('403 Forbidden')
})

it.each(['https://example.com:443', '*.example.com:443', 'example.com', 'user@example.com:443', 'example.com:443/path'])('rejects malformed target %s at configuration', (target) => {
  expect(() => new ExecutionGateway({ socketPath: '/unused.sock', allowedTargets: [target], idleTimeoutMs: 1000, maxConnections: 64 })).toThrow()
})

it.skipIf(process.platform === 'win32')('rejects an allowed DNS name resolving to the Host loopback', async (test) => {
  const { socketPath } = await boot(test, ['localhost:443'])
  expect((await connect(test, socketPath, 'localhost:443')).response).toContain('502 Bad Gateway')
})

it.skipIf(process.platform === 'win32')('bounds guest connections even before CONNECT headers arrive', async (test) => {
  const { socketPath } = await boot(test, [], 1)
  const admitted = createConnection(socketPath)
  test.onTestFinished(() => { admitted.destroy() })
  await once(admitted, 'connect')
  const excess = createConnection(socketPath)
  test.onTestFinished(() => { excess.destroy() })
  await once(excess, 'close')
  expect(admitted.destroyed).toBe(false)
  expect(excess.destroyed).toBe(true)
})

it.skipIf(process.platform === 'win32')('closes a guest tunnel without waiting for a half-open destination', async (test) => {
  const target = createServer({ allowHalfOpen: true })
  test.onTestFinished(() => new Promise<void>((resolve) => { target.close(() => { resolve() }) }))
  const accepted = once(target, 'connection')
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  const address = target.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener')
  const authority = `127.0.0.1:${address.port}`
  const { socketPath } = await boot(test, [authority])
  const { socket } = await connect(test, socketPath, authority)
  const acceptedEvent: unknown[] = await accepted
  const upstream = acceptedEvent[0]
  if (!(upstream instanceof Socket)) throw new Error('Expected destination socket')
  upstream.resume()
  test.onTestFinished(() => { upstream.destroy() })
  const closed = once(socket, 'close')
  socket.end()
  await closed
  expect(socket.destroyed).toBe(true)
})

it.skipIf(process.platform === 'win32')('holds exclusive ownership before recovering VMs and never opens on recovery failure', async (test) => {
  const { gateway, socketPath } = await boot(test, [])
  const competing = new ExecutionGateway({ socketPath, allowedTargets: [], idleTimeoutMs: 1000, maxConnections: 64 })
  test.onTestFinished(() => competing.close())
  let recovered = false
  await expect(competing.ready(async () => { recovered = true })).rejects.toThrow()
  expect(recovered).toBe(false)
  expect((await connect(test, socketPath, 'example.com:443')).response).toContain('403 Forbidden')
  await gateway.close()
  const failing = new ExecutionGateway({ socketPath, allowedTargets: [], idleTimeoutMs: 1000, maxConnections: 64 })
  test.onTestFinished(() => failing.close())
  await expect(failing.ready(async () => { throw new Error('VM stop unconfirmed') })).rejects.toThrow('VM stop unconfirmed')
  const replacement = new ExecutionGateway({ socketPath, allowedTargets: [], idleTimeoutMs: 1000, maxConnections: 64 })
  test.onTestFinished(() => replacement.close())
  await replacement.ready()
  expect((await connect(test, socketPath, 'example.com:443')).response).toContain('403 Forbidden')
})

it.skipIf(process.platform === 'win32')('relays only the exact target and terminates active tunnels on shutdown', async (test) => {
  const target = createServer(socket => socket.pipe(socket))
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  test.onTestFinished(() => new Promise<void>((resolve, reject) => target.close((error) => {
    if (error) reject(error)
    else resolve()
  })))
  const address = target.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener')
  const authority = `127.0.0.1:${address.port}`
  const { gateway, socketPath } = await boot(test, [authority])
  expect((await connect(test, socketPath, '127.0.0.1:1')).response).toContain('403 Forbidden')
  const { socket, response } = await connect(test, socketPath, authority)
  expect(response).toContain('200 Connection Established')
  const received = once(socket, 'data')
  socket.write('gateway-only')
  expect(String((await received)[0])).toBe('gateway-only')
  const closed = once(socket, 'close')
  await gateway.close()
  await closed
  expect(socket.destroyed).toBe(true)
})
