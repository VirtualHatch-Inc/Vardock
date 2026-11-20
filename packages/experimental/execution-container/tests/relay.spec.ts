/** The guest relay under local Node, pumped by the Host into a real execution gateway; and a hostile relay. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { expect, it, vi, type TestContext } from 'vitest'
import { ExecutionGateway, MAX_BROKER_REQUEST_BYTES, MAX_BROKER_RESPONSE_BYTES } from '../src/gateway.ts'
import { pumpRelay, RELAY_SCRIPT, RelayProtocolError } from '../src/relay.ts'
import type { ExecutionBroker } from '../src/service.ts'

async function gateway(test: TestContext, broker: ExecutionBroker, maxConnections = 64) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-'))
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'gateway.sock')
  const server = new ExecutionGateway({ socketPath, allowedTargets: [], idleTimeoutMs: 60_000, maxConnections })
  test.onTestFinished(() => server.close())
  await server.ready()
  const { token, dispose } = server.registerBroker(broker, new AbortController().signal)
  return { socketPath, token, maxConnections, dispose }
}

/** Start the shipped relay on an OS-assigned port; observe its listener through stderr. */
async function guestRelay(test: TestContext, maxConnections: number) {
  const observed = RELAY_SCRIPT + "\nserver.once('listening', () => process.stderr.write(String(server.address().port) + '\\n'))"
  const child = spawn(process.execPath, ['-e', observed, '--', '0', String(MAX_BROKER_REQUEST_BYTES), String(maxConnections)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  test.onTestFinished(async () => {
    child.kill()
    await exited
  })
  const [port] = await once(child.stderr, 'data') as [Buffer]
  return { port: Number(String(port).trim()), child, exited }
}

/** Start the relay script under local Node and pump it into the gateway. */
async function relay(test: TestContext, target: { socketPath: string; maxConnections: number }) {
  const { port, child } = await guestRelay(test, target.maxConnections)
  const reports: RelayProtocolError[] = []
  const streams = { input: child.stdout, output: child.stdin, stop: () => { child.kill() } }
  const pump = pumpRelay(streams, target, (error) => { reports.push(error) })
  await pump.ready
  return { port, pump, reports, child }
}

function send(port: number, options: { token?: string; body?: string | Buffer; method?: string; path?: string }) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const body = options.body ?? '{}'
    request({
      host: '127.0.0.1', port, agent: false, method: options.method ?? 'POST', path: options.path ?? '/business',
      headers: { 'content-length': Buffer.byteLength(body), ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` } },
    }, (response) => {
      void text(response).then((received) => { resolve({ status: response.statusCode, body: received }) }, reject)
    }).on('error', reject).end(body)
  })
}

it.skipIf(process.platform === 'win32')('carries a large request and a response at the byte limit through the gateway', async (test) => {
  const response = 'r'.repeat(MAX_BROKER_RESPONSE_BYTES - 2)
  const broker = vi.fn(async () => response)
  const target = await gateway(test, broker)
  const { port } = await relay(test, target)
  const payload = { data: 'é'.repeat(100 * 1024) }
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(200 * 1024)
  expect(await send(port, { token: target.token, body: JSON.stringify(payload) })).toEqual({ status: 200, body: JSON.stringify(response) })
  expect(broker).toHaveBeenCalledExactlyOnceWith(payload, expect.any(AbortSignal))
})

it.skipIf(process.platform === 'win32')('returns the gateway refusal for a wrong credential and the gateway statuses for bad requests', async (test) => {
  const broker = vi.fn(async () => null)
  const target = await gateway(test, broker)
  const { port, reports } = await relay(test, target)
  expect(await send(port, { token: 'wrong' })).toEqual({ status: 403, body: '{"error":"No active business request credential."}' })
  expect(await send(port, {})).toMatchObject({ status: 403 })
  expect(await send(port, { token: `${target.token}${'x'.repeat(200)}` })).toMatchObject({ status: 403 })
  expect(await send(port, { token: target.token, method: 'PUT' })).toMatchObject({ status: 405 })
  expect(await send(port, { token: target.token, path: '/other' })).toMatchObject({ status: 405 })
  expect(await send(port, { token: target.token, body: ' '.repeat(MAX_BROKER_REQUEST_BYTES + 1) })).toMatchObject({ status: 413 })
  expect(await send(port, { token: target.token, body: Buffer.from([0xff]) })).toMatchObject({ status: 400 })
  expect(broker).not.toHaveBeenCalled()
  expect(reports).toEqual([])
})

it.skipIf(process.platform === 'win32')('bounds concurrent requests by the gateway connection limit', async (test) => {
  const entered: number[] = []
  const released = Promise.withResolvers<null>()
  test.onTestFinished(() => { released.resolve(null) })
  const target = await gateway(test, async (input) => {
    entered.push(Number(input))
    return released.promise
  }, 3)
  const { port, reports } = await relay(test, target)
  let resets = 0
  const results = Array.from({ length: 8 }, (_, index) => send(port, { token: target.token, body: String(index) })
    .then(({ status }) => status, () => {
      resets += 1
      return 'reset'
    }))
  await vi.waitFor(() => {
    expect(entered).toHaveLength(3)
    expect(resets).toBe(5)
  })
  released.resolve(null)
  const statuses = await Promise.all(results)
  expect(statuses.filter(status => status === 200)).toHaveLength(3)
  expect(statuses.filter(status => status === 'reset')).toHaveLength(5)
  expect(entered).toHaveLength(3)
  expect(reports).toEqual([])
})

it.skipIf(process.platform === 'win32')('cancels requests in flight when the relay ends', async (test) => {
  const signals = Promise.withResolvers<AbortSignal>()
  const target = await gateway(test, (_input, signal) => {
    signals.resolve(signal)
    return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve(null) }, { once: true }) })
  })
  const { port, pump, child } = await relay(test, target)
  const pending = send(port, { token: target.token }).catch((error: unknown) => error)
  const signal = await signals.promise
  child.kill()
  await pump.done
  await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
  expect(await pending).toBeInstanceOf(Error)
  await expect(send(port, { token: target.token })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
})

it.skipIf(process.platform === 'win32')('answers pending requests with an error and exits when its stdin ends', async (test) => {
  const { port, child, exited } = await guestRelay(test, 4)
  let output = ''
  const lines = (count: number) => vi.waitFor(() => { expect(output.split('\n').length).toBeGreaterThan(count) })
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  await lines(1)
  const pending = send(port, { token: 'any' })
  await lines(2)
  child.stdin.end()
  expect(await pending).toEqual({ status: 502, body: '{"error":"Business request could not be completed."}' })
  expect(await exited).toEqual([0, null])
})

/** A relay the guest controls: the test writes its lines directly. */
async function hostileRelay(test: TestContext, maxConnections = 64) {
  const broker = vi.fn<ExecutionBroker>((_input, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve(null) }, { once: true })
  }))
  const target = await gateway(test, broker, maxConnections)
  const input = new PassThrough()
  const output = new PassThrough()
  const stop = vi.fn(() => { input.end() })
  const reports: RelayProtocolError[] = []
  const pump = pumpRelay({ input, output, stop }, target, (error) => { reports.push(error) })
  return { input, output, stop, reports, pump, broker, token: target.token }
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`

it.for([
  ['malformed', 'not json\n'],
  ['non-object', '[1]\n'],
  ['unknown field', line({ id: 1, authorization: null, body: '', extra: 1 })],
  ['invalid id', line({ id: -1, authorization: null, body: '' })],
  ['invalid base64', line({ id: 1, authorization: null, body: 'not base64!' })],
  ['oversized body', line({ id: 1, authorization: null, body: Buffer.alloc(MAX_BROKER_REQUEST_BYTES + 1).toString('base64') })],
  ['control characters in the credential', line({ id: 1, authorization: 'Bearer a\r\nx: y', body: '' })],
  ['repeated readiness', line({ ready: true })],
  ['oversized line', 'x'.repeat(Math.ceil(MAX_BROKER_REQUEST_BYTES / 3) * 4 + 2048)],
] as const)('stops a relay that sends a %s line before replaying anything', async ([, sent], test) => {
  const { input, stop, reports, pump, broker } = await hostileRelay(test)
  input.write(line({ ready: true }))
  await pump.ready
  input.write(sent)
  await pump.done
  expect(stop).toHaveBeenCalledOnce()
  expect(reports).toHaveLength(1)
  expect(reports[0]).toBeInstanceOf(RelayProtocolError)
  expect(broker).not.toHaveBeenCalled()
})

it('fails readiness for a relay that sends a request first', async (test) => {
  const { input, reports, pump } = await hostileRelay(test)
  input.write(line({ id: 0, authorization: null, body: '' }))
  await expect(pump.ready).rejects.toBeInstanceOf(RelayProtocolError)
  await pump.done
  expect(reports).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')('stops a relay that exceeds the request limit or reuses an id, and cancels its replays', async (test) => {
  for (const extra of [{ id: 0 }, { id: 2 }]) {
    const { input, stop, reports, pump, broker, token } = await hostileRelay(test, 2)
    input.write(line({ ready: true }))
    await pump.ready
    const request = (id: number) => line({ id, authorization: `Bearer ${token}`, body: Buffer.from('{}').toString('base64') })
    input.write(request(0) + request(1))
    await vi.waitFor(() => { expect(broker).toHaveBeenCalledTimes(2) })
    input.write(request(extra.id))
    await pump.done
    expect(stop).toHaveBeenCalledOnce()
    expect(reports).toHaveLength(1)
    await vi.waitFor(() => { for (const [, signal] of broker.mock.calls) expect(signal.aborted).toBe(true) })
  }
})

it.skipIf(process.platform === 'win32')('reads no further requests while the relay does not accept a reply', async (test) => {
  const broker = vi.fn(async () => 'reply')
  const target = await gateway(test, broker)
  const input = new PassThrough()
  const held: (() => void)[] = []
  const replies: string[] = []
  // A relay stdin that accepts nothing until the test releases it.
  const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    replies.push(chunk.toString())
    held.push(callback)
  } })
  const reports: RelayProtocolError[] = []
  const pump = pumpRelay({ input, output, stop: () => { input.end() } }, target, (error) => { reports.push(error) })
  const request = (id: number) => line({ id, authorization: `Bearer ${target.token}`, body: Buffer.from(String(id)).toString('base64') })
  input.write(line({ ready: true }))
  await pump.ready
  input.write(request(0))
  await vi.waitFor(() => { expect(replies).toHaveLength(1) })
  const consumed = vi.fn()
  input.on('data', consumed)
  input.write(request(1) + request(2))
  expect(consumed).not.toHaveBeenCalled()
  expect(broker).toHaveBeenCalledOnce()
  // Each accepted reply lets the pump read on; this stdin accepts one reply at a time.
  await vi.waitFor(() => {
    for (const release of held.splice(0)) release()
    expect(replies).toHaveLength(3)
  })
  for (const release of held.splice(0)) release()
  expect(replies.map((reply): unknown => JSON.parse(reply))).toEqual([0, 1, 2].map(id => ({ id, status: 200, body: '"reply"' })))
  input.end()
  await pump.done
  expect(reports).toEqual([])
})

/** A relay the test drives directly, pumped into a shared gateway. */
async function drivenRelay(test: TestContext, target: { socketPath: string; maxConnections: number }) {
  const input = new PassThrough()
  const output = new PassThrough()
  const pump = pumpRelay({ input, output, stop: () => { input.end() } }, target, () => {})
  test.onTestFinished(async () => {
    input.end()
    await pump.done
  })
  input.write(line({ ready: true }))
  await pump.ready
  return { input, output }
}

it.skipIf(process.platform === 'win32')('refuses another relay\'s request while one relay holds every gateway connection', async (test) => {
  const released = Promise.withResolvers<null>()
  test.onTestFinished(() => { released.resolve(null) })
  const broker = vi.fn<ExecutionBroker>(async () => released.promise)
  const target = await gateway(test, broker, 2)
  const first = await drivenRelay(test, target)
  const second = await drivenRelay(test, target)
  const request = (id: number) => line({ id, authorization: `Bearer ${target.token}`, body: Buffer.from('{}').toString('base64') })
  first.input.write(request(0) + request(1))
  await vi.waitFor(() => { expect(broker).toHaveBeenCalledTimes(2) })
  const reply = once(second.output, 'data')
  second.input.write(request(0))
  expect(JSON.parse(String((await reply)[0]))).toEqual({ id: 0, status: null, body: '' })
  expect(broker).toHaveBeenCalledTimes(2)
  released.resolve(null)
})

it.skipIf(process.platform === 'win32')('cancels only the named replay', async (test) => {
  const { input, reports, pump, broker, token } = await hostileRelay(test)
  input.write(line({ ready: true }))
  await pump.ready
  const request = (id: number) => line({ id, authorization: `Bearer ${token}`, body: Buffer.from(String(id)).toString('base64') })
  input.write(request(0) + request(1))
  await vi.waitFor(() => { expect(broker).toHaveBeenCalledTimes(2) })
  const signals = new Map(broker.mock.calls.map(([body, signal]) => [body, signal]))
  input.write(line({ id: 0, cancel: true }))
  await vi.waitFor(() => { expect(signals.get(0)?.aborted).toBe(true) })
  expect(signals.get(1)?.aborted).toBe(false)
  expect(reports).toEqual([])
  input.end()
  await pump.done
})

it.skipIf(process.platform === 'win32')('keeps a cancelled request charged until its replay closes for a fresh replacement id', async (test) => {
  const broker = vi.fn<ExecutionBroker>((_input, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve(null) }, { once: true })
  }))
  const target = await gateway(test, broker, 1)
  const counted = { open: 0, most: 0 }
  const proxy = createServer((socket) => {
    counted.open += 1
    counted.most = Math.max(counted.most, counted.open)
    const upstream = connect(target.socketPath)
    socket.pipe(upstream).pipe(socket)
    socket.on('error', () => { upstream.destroy() })
    upstream.on('error', () => { socket.destroy() })
    socket.once('close', () => {
      counted.open -= 1
      upstream.destroy()
    })
  })
  const socketPath = `${target.socketPath}.counted`
  proxy.listen(socketPath)
  await once(proxy, 'listening')
  test.onTestFinished(async () => {
    proxy.close()
    await once(proxy, 'close')
  })
  const input = new PassThrough()
  const stop = vi.fn(() => { input.end() })
  const reports: RelayProtocolError[] = []
  const pump = pumpRelay({ input, output: new PassThrough(), stop }, { ...target, socketPath }, (error) => { reports.push(error) })
  input.write(line({ ready: true }))
  await pump.ready
  const request = (id: number) => line({ id, authorization: `Bearer ${target.token}`, body: Buffer.from('{}').toString('base64') })
  input.write(request(0))
  await vi.waitFor(() => { expect(broker).toHaveBeenCalledOnce() })
  input.write(line({ id: 0, cancel: true }) + request(1))
  await pump.done
  expect(stop).toHaveBeenCalledOnce()
  expect(reports).toHaveLength(1)
  expect(counted.most).toBe(1)
  expect(broker).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === 'win32')('frees a cancelled slot only after the Host answers it', async (test) => {
  const { port, child } = await guestRelay(test, 1)
  const lines: string[] = []
  const unexpected = Promise.withResolvers<string>()
  createInterface({ input: child.stdout }).on('line', (value) => {
    lines.push(value)
    if (lines.length > 3) unexpected.resolve('replacement forwarded before acknowledgment')
  })
  await vi.waitFor(() => { expect(lines).toHaveLength(1) })
  const client = request({
    host: '127.0.0.1', port, agent: false, method: 'POST', path: '/business', headers: { 'content-length': 2 },
  })
  client.on('error', () => {})
  client.end('{}')
  await vi.waitFor(() => { expect(lines).toHaveLength(2) })
  client.destroy()
  await vi.waitFor(() => { expect(lines).toHaveLength(3) })
  const replacing = send(port, { token: 'replacement' }).catch((error: unknown) => error)
  expect(await Promise.race([replacing, unexpected.promise])).toBeInstanceOf(Error)
  const first = JSON.parse(lines[1] ?? '') as { id: number }
  child.stdin.write(line({ id: first.id, status: null, body: '' }))
  const admitted = send(port, { token: 'after' })
  await vi.waitFor(() => { expect(lines).toHaveLength(4) })
  const next = JSON.parse(lines[3] ?? '') as { id: number }
  child.stdin.write(line({ id: next.id, status: 403, body: 'denied' }))
  expect(await admitted).toEqual({ status: 403, body: 'denied' })
})
