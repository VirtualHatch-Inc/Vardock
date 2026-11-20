/** Evidence persistence and failure behavior through the Unix HTTP API. */
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, type TestContext } from 'vitest'
import type { Config, EvidenceEvent } from '../src/index.ts'
import { EvidenceClient } from '../src/library.ts'
import * as Witness from '../src/index.ts'

const admission: EvidenceEvent = {
  id: 'job-1-admission',
  operationId: 'job-1',
  kind: 'admission',
  body: { image: 'sha256:abc', authorization: { path: '/workspace', expiry: null } },
}

async function fixture(test: TestContext, config: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ev-'))
  const databaseDir = join(root, 'db')
  const socketPath = join(root, 'w.sock')
  const databasePath = join(databaseDir, 'e.sqlite')
  const contexts: Context[] = []
  test.onTestFinished(async () => {
    try {
      await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  await mkdir(databaseDir, { mode: 0o700 })
  return {
    root, socketPath, databasePath,
    client: new EvidenceClient({ socketPath }),
    start: async (overrides: Partial<Config> = {}) => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(Witness, { socketPath, databasePath, ...config, ...overrides })
      return () => ctx.fiber.dispose()
    },
  }
}

function rawRequest(socketPath: string, method: string, path: string, chunks: readonly (string | Buffer)[]): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, agent: false }, (response) => {
      response.once('end', () => { resolve(response.statusCode) })
      response.once('error', reject)
      response.resume()
    })
    req.once('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

async function listen(server: Server, socketPath: string): Promise<() => Promise<void>> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return () => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

describe.skipIf(process.platform === 'win32')('POSIX execution witness', () => {
  it('preserves a receipt after restart and refuses changed contents for that id', async (test) => {
    const { start, client, socketPath, databasePath } = await fixture(test)
    const stop = await start()
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600)
    expect(await client.get('absent')).toBeUndefined()
    const receipt = await client.append(admission)
    expect(receipt.id).toBe(admission.id)
    expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(await client.append({
      ...admission, body: { authorization: { expiry: null, path: '/workspace' }, image: 'sha256:abc' },
    })).toEqual(receipt)
    await expect(client.append({ ...admission, body: { image: 'other' } })).rejects.toMatchObject({ code: 'conflict' })
    await stop()
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await start()
    expect(await client.get(admission.id)).toEqual({ event: admission, receipt })
  })

  it('lists committed records in commit order across pages and restarts without changing them', async (test) => {
    const { client, start } = await fixture(test)
    const stop = await start()
    const events = Array.from({ length: 53 }, (_unused, index): EvidenceEvent => ({
      id: `job-${index}-admission`, operationId: `job-${index}`, kind: 'admission', body: { index },
    }))
    const receipts = []
    for (const event of events) receipts.push(await client.append(event))
    const first = await client.list(0)
    expect(first.records).toHaveLength(50)
    expect(first.records[0]).toEqual({ event: events[0], receipt: receipts[0] })
    await stop()
    await start()
    if (first.next === undefined) throw new Error('Expected a following page')
    const rest = await client.list(first.next)
    expect(rest.records.map(record => record.receipt)).toEqual(receipts.slice(50))
    expect(rest.next).toBeUndefined()
    expect(await client.list(first.next + 3)).toEqual({ records: [] })
  })

  it('refuses a listed page that is malformed or whose records do not match their receipts', async (test) => {
    const { start, client, root } = await fixture(test)
    await start()
    const receipt = await client.append(admission)
    const replies = [
      { records: {} },
      { records: [{ event: admission }] },
      { records: [{ event: { ...admission, body: 'changed' }, receipt }] },
    ]
    const socketPath = join(root, 'p.sock')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(replies.shift()))
    })
    test.onTestFinished(await listen(server, socketPath))
    const forged = new EvidenceClient({ socketPath })
    for (let index = 0; index < 3; index++) await expect(forged.list(0)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('refuses malformed, oversized, and mutation requests before storing anything', async (test) => {
    const { start, client, socketPath } = await fixture(test, { maxRequestBytes: 256 })
    await start()
    expect(await rawRequest(socketPath, 'POST', '/events', ['{invalid}'])).toBe(400)
    expect(await rawRequest(socketPath, 'POST', '/events', [Buffer.from([0xc0])])).toBe(400)
    expect(await rawRequest(socketPath, 'POST', '/events', [JSON.stringify({ ...admission, kind: 'arbitrary' })])).toBe(400)
    expect(await rawRequest(socketPath, 'POST', '/events', [' '.repeat(128), ' '.repeat(129)])).toBe(413)
    const compactNumbers = JSON.stringify({ ...admission, body: [] }).replace('[]', `[${'1e18,'.repeat(20)}1e18]`)
    expect(await rawRequest(socketPath, 'POST', '/events', [compactNumbers])).toBe(413)
    await expect(client.append({ ...admission, body: 'x'.repeat(256) })).rejects.toMatchObject({ code: 'invalid' })
    expect(await client.get(admission.id)).toBeUndefined()
    const receipt = await client.append(admission)
    expect(await rawRequest(socketPath, 'DELETE', `/events/${admission.id}`, [])).toBe(400)
    expect(await client.get(admission.id)).toEqual({ event: admission, receipt })
  })

  it('recovers an append whose reply was lost after durable commit', async (test) => {
    const { start, client, root } = await fixture(test)
    await start()
    const proxyPath = join(root, 'p.sock')
    const proxy = createServer((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        void client.append(admission).then(() => { response.destroy() }, (error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)))
        })
      })
    })
    test.onTestFinished(await listen(proxy, proxyPath))
    const disconnected = new EvidenceClient({ socketPath: proxyPath })
    await expect(disconnected.append(admission)).rejects.toMatchObject({ code: 'unknown' })
    const record = await client.get(admission.id)
    expect(record?.event).toEqual(admission)
    expect(await client.append(admission)).toEqual(record?.receipt)
  })

  it('retains exclusive database ownership across different socket paths', async (test) => {
    const { start, client, root } = await fixture(test)
    const stop = await start()
    const receipt = await client.append(admission)
    await stop()
    await start()
    const otherSocket = join(root, 'other.sock')
    await expect(start({ socketPath: otherSocket })).rejects.toMatchObject({ errcode: 5 })
    await expect(lstat(otherSocket)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await client.get(admission.id)).toEqual({ event: admission, receipt })
  })

  it('admits only one startup for a socket shared by different databases', async (test) => {
    const { start, client, databasePath } = await fixture(test)
    const contenders = await Promise.allSettled([start(), start({ databasePath: `${databasePath}.other` })])
    expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'EADDRINUSE' } })
    const receipt = await client.append(admission)
    expect(await client.get(admission.id)).toEqual({ event: admission, receipt })
  })

  it('leaves a live listener without a lease reachable', async (test) => {
    const { start, socketPath } = await fixture(test)
    const server = createServer((_request, response) => { response.writeHead(204).end() })
    test.onTestFinished(await listen(server, socketPath))
    await expect(start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(await rawRequest(socketPath, 'GET', '/', [])).toBe(204)
  })

  it('leaves regular files and symlinks at the configured socket path intact', async (test) => {
    const { start, root, socketPath } = await fixture(test)
    await writeFile(socketPath, 'keep')
    await expect(start()).rejects.toThrow('occupied by an entry')
    expect(await readFile(socketPath, 'utf8')).toBe('keep')
    await rm(socketPath)
    const target = join(root, 'target')
    await writeFile(target, 'also keep')
    await symlink(target, socketPath)
    await expect(start()).rejects.toThrow('occupied by an entry')
    expect((await lstat(socketPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('also keep')
  })

  it('exposes only the socket when the dedicated broker group has access', async (test) => {
    const { start, root, socketPath, databasePath } = await fixture(test, { socketMode: '0660' })
    await chmod(root, 0o750)
    await start()
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660)
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'db'))).mode & 0o777).toBe(0o700)
  })

  it('refuses a database readable by a non-owner and a socket directory writable by the broker group', async (test) => {
    const { start, root, databasePath } = await fixture(test)
    const stop = await start()
    await stop()
    await chmod(databasePath, 0o640)
    await expect(start()).rejects.toThrow('witness-owned private file')
    await chmod(databasePath, 0o600)
    await chmod(root, 0o770)
    await expect(start()).rejects.toThrow('Secure the operation socket directory')
  })
})
