/** Execute the fixed guest script against private files without a runtime daemon. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import type { WorkspaceTransferRequest } from '../src/service.ts'
import { MAX_WORKSPACE_TRANSFER_BYTES, prepareWorkspaceTransfer, runWorkspaceTransfer } from '../src/workspace-transfer.ts'

async function fixture(test: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-transfer-'))
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const signal = new AbortController().signal
  const transfer = (request: WorkspaceTransferRequest) => runWorkspaceTransfer({
    run(args, _signal, maxBytes, stdin) {
      const result = spawnSync(process.execPath, args.slice(1).map(arg => arg === '/workspace' ? workspace : arg), {
        input: typeof stdin === 'object' ? stdin.data : undefined, encoding: 'utf8', timeout: 5_000, maxBuffer: maxBytes,
      })
      if (result.error !== undefined) return Promise.reject(result.error)
      const output = (text: string) => ({ text, nextOffset: Buffer.byteLength(text), lossy: false })
      return Promise.resolve({
        exitCode: result.status, signal: result.signal, stdout: output(result.stdout), stderr: output(result.stderr),
      })
    },
  }, [], prepareWorkspaceTransfer(request), signal)
  return { directory, workspace, transfer }
}

it('copies exact binary bytes, accepts an identical input retry, and leaves differing bytes untouched', async (test) => {
  const { workspace, transfer } = await fixture(test)
  const data = Buffer.from([0, 10, 13, 128, 255])
  const digest = createHash('sha256').update(data).digest('hex')
  const path = `input/sha256:${digest}/入力.bin`
  const imported = { kind: 'import', path, data, maxBytes: data.length } as const
  await expect(transfer(imported)).resolves.toEqual({ kind: 'imported', bytes: data.length, digest })
  await expect(transfer(imported)).resolves.toEqual({ kind: 'imported', bytes: data.length, digest })
  await expect(transfer({ ...imported, data: Buffer.alloc(data.length, 1) })).rejects.toMatchObject({ code: 'EXEC_TRANSFER_CONFLICT' })
  await expect(readFile(join(workspace, path))).resolves.toEqual(data)
  await expect(transfer({ kind: 'export', path, maxBytes: data.length })).resolves.toEqual({
    kind: 'exported', bytes: data.length, digest, data,
  })
  await expect(transfer({ kind: 'export', path, maxBytes: data.length - 1 })).rejects.toMatchObject({ code: 'EXEC_TRANSFER_SIZE' })
  const emptyPath = 'input/empty.bin'
  await transfer({ kind: 'import', path: emptyPath, data: Buffer.alloc(0), maxBytes: 0 })
  await expect(transfer({ kind: 'export', path: emptyPath, maxBytes: 0 })).resolves.toMatchObject({ bytes: 0, data: Buffer.alloc(0) })
})

it.skipIf(process.platform === 'win32')('refuses symlinks, hard links, and pipes for workspace transfers', async (test) => {
  const { directory, workspace, transfer } = await fixture(test)
  const outside = join(directory, 'outside')
  await mkdir(outside)
  const target = join(outside, 'secret')
  await writeFile(target, 'private')
  await symlink(outside, join(workspace, 'input'))
  await symlink(target, join(workspace, 'symlink'))
  await link(target, join(workspace, 'hardlink'))
  execFileSync('mkfifo', [join(workspace, 'pipe')], { timeout: 5_000 })
  const data = Buffer.from('forbidden')
  await expect(transfer({ kind: 'import', path: 'input/secret', data, maxBytes: 100 })).rejects.toMatchObject({ code: 'EXEC_TRANSFER_FILE' })
  for (const path of ['input/secret', 'symlink', 'hardlink', 'pipe', 'missing']) {
    await expect(transfer({ kind: 'export', path, maxBytes: 100 })).rejects.toMatchObject({ code: 'EXEC_TRANSFER_FILE' })
  }
  await expect(readFile(target, 'utf8')).resolves.toBe('private')
})

it('rejects escaping paths and unbounded transfers before invoking the guest', () => {
  for (const path of ['../secret', '/secret', 'input//file', 'input/./file', 'input/../file', 'input\\file', 'input/\0file', 'input/\ud800', '界'.repeat(86)]) {
    expect(() => prepareWorkspaceTransfer({ kind: 'export', path, maxBytes: 1 })).toThrow(expect.objectContaining({ code: 'EXEC_TRANSFER_PATH' }))
  }
  const data = Buffer.from('ab')
  expect(() => prepareWorkspaceTransfer({ kind: 'import', path: 'outside', data, maxBytes: 2 }))
    .toThrow(expect.objectContaining({ code: 'EXEC_TRANSFER_PATH' }))
  expect(() => prepareWorkspaceTransfer({ kind: 'import', path: 'input/file', data, maxBytes: 1 }))
    .toThrow(expect.objectContaining({ code: 'EXEC_TRANSFER_SIZE' }))
  expect(() => prepareWorkspaceTransfer({ kind: 'export', path: 'file', maxBytes: MAX_WORKSPACE_TRANSFER_BYTES + 1 }))
    .toThrow(expect.objectContaining({ code: 'EXEC_TRANSFER_SIZE' }))
})
