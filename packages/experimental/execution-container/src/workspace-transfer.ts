/** Bounded binary transfer over a fixed guest command while no workspace script is active. */
import { createHash } from 'node:crypto'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ExecutionCli } from './common.ts'
import type { WorkspaceTransferRequest, WorkspaceTransferResult } from './service.ts'
import { EXEC_WORKSPACE } from './tool.ts'

/** Maximum file size supported by one transfer. Callers supply their own limit up to this bound. */
export const MAX_WORKSPACE_TRANSFER_BYTES = 32 * 1024 * 1024

const exit = { file: 64, size: 65, conflict: 66 }

// The runtime starts this command in a stopped, exclusively reserved workspace.
const guestScript = String.raw`
const fs = require('node:fs')
const { join } = require('node:path')
const [root, kind, path, limit] = process.argv.slice(1)
const maxBytes = Number(limit)
const exit = ${JSON.stringify(exit)}

class TransferFailure extends Error {
  constructor(code) {
    super('Workspace transfer refused')
    this.code = code
  }
}

function openRegularFile(path) {
  const info = fs.lstatSync(path, { throwIfNoEntry: false })
  if (!info?.isFile() || info.nlink !== 1) throw new TransferFailure(exit.file)
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) throw new TransferFailure(exit.file)
    if (stat.size > maxBytes) throw new TransferFailure(exit.size)
    const data = Buffer.allocUnsafe(stat.size + 1)
    let bytes = 0
    while (bytes < data.length) {
      const count = fs.readSync(fd, data, bytes, data.length - bytes)
      if (count === 0) break
      bytes += count
    }
    if (bytes !== stat.size) throw new TransferFailure(exit.file)
    return data.subarray(0, bytes)
  } finally {
    fs.closeSync(fd)
  }
}

function destination() {
  const segments = path.split('/')
  const leaf = segments.pop()
  let parent = root
  for (const segment of segments) {
    parent = join(parent, segment)
    const info = fs.lstatSync(parent, { throwIfNoEntry: false })
    if (info === undefined && kind === 'import') fs.mkdirSync(parent, 0o700)
    else if (!info?.isDirectory()) throw new TransferFailure(exit.file)
  }
  return { parent, file: join(parent, leaf) }
}

function importFile(parent, file) {
  const data = Buffer.from(fs.readFileSync(0, 'utf8'), 'base64')
  if (data.length > maxBytes) throw new TransferFailure(exit.size)
  if (fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined) {
    if (!data.equals(openRegularFile(file))) throw new TransferFailure(exit.conflict)
    return
  }
  const stage = fs.mkdtempSync(join(parent, '.dsh-import-'))
  try {
    const stagedFile = join(stage, 'file')
    fs.writeFileSync(stagedFile, data, { flag: 'wx', mode: 0o600 })
    fs.renameSync(stagedFile, file)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

try {
  const { parent, file } = destination()
  if (kind === 'import') importFile(parent, file)
  else process.stdout.write(openRegularFile(file).toString('base64'))
} catch (error) {
  if (!(error instanceof TransferFailure)) throw error
  process.exitCode = error.code
}
`

/**
 * Check a canonical relative workspace path before it reaches the guest.
 * @param path - Requested POSIX path relative to the workspace root.
 * @returns Whether the path contains only bounded, non-traversing segments.
 */
export function isWorkspaceTransferPath(path: string): boolean {
  return path.isWellFormed() && Buffer.byteLength(path) <= 1024 && !/[\u0000-\u001f\u007f\\]/u.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && Buffer.byteLength(segment) <= 255)
}

/**
 * Validate a transfer and capture caller-owned import bytes before guest startup.
 * @param request - Workspace transfer parameters.
 * @returns The checked transfer with an owned copy of any import bytes.
 */
export function prepareWorkspaceTransfer(request: WorkspaceTransferRequest): WorkspaceTransferRequest {
  if (!isWorkspaceTransferPath(request.path) || (request.kind === 'import' && !request.path.startsWith('input/'))) {
    throw new HarnessError('Use a workspace-relative file path. Imports must be under input/.', 'EXEC_TRANSFER_PATH')
  }
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0 || request.maxBytes > MAX_WORKSPACE_TRANSFER_BYTES
    || (request.kind === 'import' && request.data.byteLength > request.maxBytes)) {
    throw new HarnessError('The workspace transfer exceeds its file byte limit.', 'EXEC_TRANSFER_SIZE')
  }
  return request.kind === 'import' ? { ...request, data: Buffer.from(request.data) } : { ...request }
}

/**
 * Run a file transfer inside an exclusive guest invocation with no running shell script.
 * @param cli - Local runtime CLI bound to the owned container or VM.
 * @param execArgs - CLI arguments for an interactive command in the running guest.
 * @param request - Validated transfer with captured import bytes.
 * @param signal - Cancellation for the transfer process.
 * @returns Observed bytes and digest. The caller must confirm guest stop before publishing them.
 */
export async function runWorkspaceTransfer(
  cli: Pick<ExecutionCli, 'run'>, execArgs: readonly string[], request: WorkspaceTransferRequest, signal: AbortSignal,
): Promise<WorkspaceTransferResult> {
  const input = request.kind === 'import' ? Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength) : undefined
  const { stdout, exitCode } = await cli.run([
    ...execArgs, '/usr/local/bin/node', '-e', guestScript, '--', EXEC_WORKSPACE, request.kind, request.path, String(request.maxBytes),
  ], signal, request.kind === 'import' ? 4096 : Math.max(4096, Math.ceil(request.maxBytes / 3) * 4),
  input === undefined ? 'ignore' : { data: input.toString('base64') })
  switch (exitCode) {
    case exit.file:
      throw new HarnessError('Select a regular workspace file with no symbolic or hard links.', 'EXEC_TRANSFER_FILE')
    case exit.size:
      throw new HarnessError('The workspace transfer exceeds its file byte limit.', 'EXEC_TRANSFER_SIZE')
    case exit.conflict:
      throw new HarnessError('The input path already contains different bytes.', 'EXEC_TRANSFER_CONFLICT')
    default:
      break
  }
  if (exitCode !== 0 || stdout.lossy || (input !== undefined && stdout.text !== '')) {
    throw new HarnessError('Could not confirm the workspace file transfer. Inspect the workspace before retrying.', 'EXEC_TRANSFER_UNAVAILABLE')
  }
  const data = input ?? Buffer.from(stdout.text, 'base64')
  if (input === undefined && (data.length > request.maxBytes || data.toString('base64') !== stdout.text)) {
    throw new HarnessError('The guest returned an invalid workspace file response.', 'EXEC_TRANSFER_UNAVAILABLE')
  }
  const observation = { bytes: data.length, digest: createHash('sha256').update(data).digest('hex') }
  return input === undefined ? { kind: 'exported', ...observation, data } : { kind: 'imported', ...observation }
}
