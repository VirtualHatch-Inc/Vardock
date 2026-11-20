// @vitest-environment jsdom
/** Artifact download rendering keeps file names out of executable destinations. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { previewAddress, readArtifactPreview } from '../src/client/artifact-preview.ts'
import { Artifacts, WorkArtifacts } from '../src/client/Artifacts.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('downloads by work coordinates and renders the exact filename as text', () => {
  const workId = 'a'.repeat(64)
  const name = '報告書 <script>.txt'
  const node: ChatNode<'assistant-artifacts'> = {
    key: 'artifacts', id: '1', kind: 'assistant-artifacts', target: 'chat',
    anchorSeq: 1, location: { kind: 'unresolved' }, visibility: 'visible',
    data: { kind: 'assistant-work', direction: 'result', workId, artifacts: [
      { name, bytes: 15, digest: 'b'.repeat(64) },
      { name: 'second.bin', bytes: 0, digest: 'c'.repeat(64) },
    ] },
  }
  render(<Artifacts node={node} t={() => 'Download'} />)
  const links = screen.getAllByRole('link')
  expect(links[0]?.getAttribute('href')).toBe(`./api/assistant-artifact?workId=${workId}&index=0`)
  expect(links[1]?.getAttribute('href')).toBe(`./api/assistant-artifact?workId=${workId}&index=1`)
  expect(links[0]?.getAttribute('download')).toBe(name)
  expect(links[0]?.textContent).toBe(`${name}Download`)
  expect(document.querySelector('script')).toBeNull()
})

it('opens only small text previews and renders their content literally', () => {
  const workId = 'a'.repeat(64)
  const files = [
    { name: 'report.md', bytes: 24, digest: 'b'.repeat(64) },
    { name: 'archive.txt', bytes: 80_000, digest: 'c'.repeat(64) },
    { name: 'diagram.svg', bytes: 100, digest: 'd'.repeat(64) },
  ]
  const content = '# Result\n<script>alert(1)</script>'
  const useResource = vi.fn().mockReturnValue({ status: 'live', value: content, failure: undefined })
  render(<WorkArtifacts workId={workId} files={files} useResource={useResource}
    t={key => key === 'artifact.previewName' ? 'Preview report.md' : key} />)
  expect(useResource).not.toHaveBeenCalled()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Preview report.md' }))
  expect(useResource).toHaveBeenCalledWith(`dsh-resource://assistant-artifact-text/${workId}/0`)
  expect(document.querySelector('pre')?.textContent).toBe(content)
  expect(document.querySelector('script')).toBeNull()
  expect(screen.getAllByRole('link')).toHaveLength(3)
})

it('refuses preview bodies that exceed the byte limit or are not UTF-8', async () => {
  const address = previewAddress('a'.repeat(64), 0, { name: 'preview.csv', bytes: 10 })!
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(new Uint8Array(64 * 1024 + 1)))
    .mockResolvedValueOnce(new Response(Uint8Array.of(255)))
    .mockResolvedValueOnce(new Response('region,orders\nWest,15\n'))
  const { signal } = new AbortController()
  expect(await readArtifactPreview(address, signal)).toMatchObject({ ok: false })
  expect(await readArtifactPreview(address, signal)).toMatchObject({ ok: false })
  expect(await readArtifactPreview(address, signal)).toEqual({ ok: true, value: 'region,orders\nWest,15\n' })
})
