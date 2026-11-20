/** Reserve a service-owned Unix socket path across concurrent starts and restarts. */
import { constants } from 'node:fs'
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function busy(path: string, cause?: unknown): Error {
  return Object.assign(new Error(`The operation socket at ${path} already has an owner`, { cause }), { code: 'EADDRINUSE' })
}

async function reclaim(path: string, uid: number, timeoutMs: number): Promise<void> {
  const socket = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (codeOf(error) === 'ENOENT') return undefined
    throw error
  })
  if (socket === undefined) return
  if (!socket.isSocket() || socket.uid !== BigInt(uid)) {
    throw new Error(`The operation socket path at ${path} is occupied by an entry the service cannot reclaim`)
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection({ path, signal: AbortSignal.timeout(timeoutMs) })
    probe.once('connect', () => {
      probe.destroy()
      reject(busy(path))
    })
    probe.once('error', (error) => {
      if (codeOf(error) === 'ECONNREFUSED') resolve()
      else reject(new Error(`Could not confirm that the operation socket at ${path} is inactive`, { cause: error }))
    })
  })
  const current = await lstat(path, { bigint: true })
  if (!current.isSocket() || current.uid !== socket.uid || current.ino !== socket.ino || current.dev !== socket.dev) {
    throw new Error(`The operation socket at ${path} changed during startup`)
  }
  await unlink(path)
}

/**
 * Claim a Unix socket path and reclaim an owned socket only after a refused connection.
 * @param path - configured socket path in a service-owned directory with no group write or other access.
 * @param timeoutMs - maximum time to confirm whether an existing socket accepts connections.
 * @returns The sidecar lock handle. Close it after the listener has closed. Keep the lock file in place across restarts.
 */
export async function prepareOperationSocket(path: string, timeoutMs: number): Promise<FileHandle> {
  const uid = process.getuid?.()
  const directory = await lstat(dirname(path))
  if (uid === undefined || !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o027) !== 0) {
    throw new Error(`Secure the operation socket directory at ${dirname(path)} before startup`)
  }

  const lockPath = `${path}.lock`
  const handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const lock = await handle.stat({ bigint: true })
    if (!lock.isFile() || lock.uid !== BigInt(uid) || (lock.mode & 0o077n) !== 0n) {
      throw new Error(`The socket lock at ${lockPath} must be a service-owned private regular file`)
    }
    try {
      await tryLockExclusive(handle.fd)
    } catch (error: unknown) {
      if (codeOf(error) === 'EAGAIN' || codeOf(error) === 'EWOULDBLOCK') throw busy(path, error)
      throw error
    }
    const current = await lstat(lockPath, { bigint: true })
    if (current.ino !== lock.ino || current.dev !== lock.dev) {
      throw new Error(`The socket lock at ${lockPath} changed during startup`)
    }
    await reclaim(path, uid, timeoutMs)
    return handle
  } catch (error: unknown) {
    await handle.close()
    throw error
  }
}
