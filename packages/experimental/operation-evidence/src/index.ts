/** Start the append-only execution witness under its own OS service account. */
import { chmodSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_REQUEST_BYTES, DEFAULT_TIMEOUT_MS, EVIDENCE_PAGE_SIZE, EvidenceError, MAX_REQUEST_BYTES, MAX_SOCKET_BYTES, MIN_REQUEST_BYTES,
  MessageLimitError, encodeEvent, eventOf, evidenceDigest, readJson, recordOf, validId, type EvidenceEvent,
} from './protocol.ts'
import { prepareOperationSocket } from './socket.ts'

export {
  EvidenceError, type EvidenceEvent, type EvidenceJson, type EvidencePage, type EvidenceReceipt, type EvidenceRecord,
} from './protocol.ts'

/** Stable Cordis entry name. */
export const name = 'operation-evidence'

/** Operator-controlled paths and limits for the witness service. */
export interface Config {
  /** Absolute Unix socket path in a directory controlled by the witness account. */
  socketPath: string
  /** Absolute database path in a witness-owned directory inaccessible to other accounts. */
  databasePath: string
  /** Socket permissions. Group access is for the dedicated broker group. */
  socketMode?: '0600' | '0660'
  /** Maximum time to send the request, including headers and body. */
  timeoutMs?: number
  /** Maximum bytes in the UTF-8 append request body. */
  maxRequestBytes?: number
}

/** Validate required paths and finite protocol limits before opening resources. */
export const Config: z<Config> = z.object({
  socketPath: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
  databasePath: z.string().pattern(/^\/[^\u0000\r\n]+$/u).required(),
  socketMode: z.union(['0600', '0660'] as const).default('0600'),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
  maxRequestBytes: z.number().step(1).min(MIN_REQUEST_BYTES).max(MAX_REQUEST_BYTES).default(DEFAULT_REQUEST_BYTES),
})

const SCHEMA_VERSION = 1

async function openDatabase(path: string, uid: number): Promise<DatabaseSync> {
  const directoryPath = dirname(path)
  const directory = await lstat(directoryPath)
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
    throw new Error(`operation-evidence: secure the witness directory at ${directoryPath} before startup`)
  }
  try {
    const file = await open(path, 'wx', 0o600)
    await file.close()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
  }
  const file = await lstat(path)
  if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0) {
    throw new Error(`operation-evidence: the database at ${path} must be a witness-owned private file`)
  }
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;')
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`operation-evidence: unsupported SQLite schema version ${String(version)}`)
    if (version === 0) {
      db.exec(`
        CREATE TABLE evidence_events (
          id TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          digest TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
    }
    db.exec('COMMIT;')
    return db
  } catch (cause) {
    db.close()
    throw cause
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
  response.end(payload)
}

function createHandler(ctx: Context, db: DatabaseSync, config: Required<Config>) {
  const find = db.prepare('SELECT event, digest FROM evidence_events WHERE id = ?')
  const page = db.prepare(`SELECT rowid, id, event, digest FROM evidence_events WHERE rowid > ? ORDER BY rowid LIMIT ${EVIDENCE_PAGE_SIZE}`)
  const insert = db.prepare('INSERT INTO evidence_events (id, event, digest) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const timer = setTimeout(() => { request.destroy() }, config.timeoutMs)
    try {
      if (request.method === 'POST' && request.url === '/events') {
        if (Number(request.headers['content-length']) > config.maxRequestBytes) {
          send(response, 413)
          return
        }
        const event = eventOf(await readJson(request, config.maxRequestBytes))
        const text = encodeEvent(event)
        if (Buffer.byteLength(text) > config.maxRequestBytes) {
          send(response, 413)
          return
        }
        const digest = evidenceDigest(text)
        const result = insert.run(event.id, text, digest)
        if (result.changes === 0) {
          const stored = find.get(event.id)
          if (stored === undefined) throw new Error('operation-evidence: conflicting event was not found')
          if (stored.event !== text) {
            send(response, 409)
            return
          }
          if (stored.digest !== digest) throw new Error('operation-evidence: stored digest does not match its event')
        }
        send(response, 200, { id: event.id, digest })
        return
      }

      const after = request.url?.match(/^\/events\?after=(\d{1,15})$/u)?.[1]
      if (request.method === 'GET' && after !== undefined) {
        const rows = page.all(Number(after))
        send(response, 200, {
          records: rows.map(({ id, event, digest }) => ({ event: JSON.parse(String(event)) as EvidenceEvent, receipt: { id, digest } })),
          ...rows.length < EVIDENCE_PAGE_SIZE ? {} : { next: rows.at(-1)?.rowid },
        })
        return
      }
      const id = request.url?.startsWith('/events/') ? request.url.slice('/events/'.length) : undefined
      if (request.method !== 'GET' || !validId(id)) {
        send(response, 400)
        return
      }
      const row = find.get(id)
      if (row === undefined) {
        send(response, 404)
        return
      }
      if (typeof row.event !== 'string') throw new Error('operation-evidence: invalid stored event')
      const event: unknown = JSON.parse(row.event)
      try {
        send(response, 200, recordOf({ event, receipt: { id, digest: row.digest } }, id))
      } catch (cause) {
        throw new Error('operation-evidence: invalid stored record', { cause })
      }
    } catch (cause) {
      if (response.destroyed) return
      if (cause instanceof MessageLimitError) {
        send(response, 413)
      } else if (cause instanceof EvidenceError && cause.code === 'invalid') {
        send(response, 400)
      } else {
        ctx.logger.error(cause)
        send(response, 503)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  server.closeAllConnections()
  await closed
}

/**
 * Listen for authorized broker requests and release the socket and database on disposal.
 * @param ctx - lifecycle and diagnostics owner.
 * @param config - operator-owned witness paths and protocol limits.
 * @returns Completion of database and socket readiness.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = Config(config) as Required<Config>
  if (resolved.socketPath === resolved.databasePath || Buffer.byteLength(resolved.socketPath) > MAX_SOCKET_BYTES) {
    throw new Error('operation-evidence: configure a distinct, short Unix socket path')
  }
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('operation-evidence: a POSIX service account is required')
  await ctx.effect(async () => {
    const db = await openDatabase(resolved.databasePath, uid)
    const socket = await prepareOperationSocket(resolved.socketPath, resolved.timeoutMs).catch((cause: unknown) => {
      db.close()
      throw cause
    })
    const requests = new Set<Promise<void>>()
    const server = createServer({
      headersTimeout: resolved.timeoutMs,
      requestTimeout: resolved.timeoutMs,
      connectionsCheckingInterval: Math.min(resolved.timeoutMs, 1_000),
    })
    const close = async () => {
      try {
        await closeServer(server)
        await Promise.allSettled(requests)
      } finally {
        try {
          db.close()
        } finally {
          await socket.close()
        }
      }
    }
    try {
      const handle = createHandler(ctx, db, resolved)
      server.on('request', (request, response) => {
        const running = handle(request, response)
        requests.add(running)
        void running.then(
          () => { requests.delete(running) },
          (error: unknown) => {
            requests.delete(running)
            ctx.logger.error(error)
            response.destroy()
          },
        )
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(resolved.socketPath, () => {
          server.off('error', reject)
          server.on('error', (error) => { ctx.logger.error(error) })
          try {
            chmodSync(resolved.socketPath, Number.parseInt(resolved.socketMode, 8))
            resolve()
          } catch (cause) {
            reject(new Error('operation-evidence: could not set socket permissions', { cause }))
          }
        })
      })
    } catch (cause) {
      await close()
      throw cause
    }
    return close
  }, 'operation-evidence.listen')
}
