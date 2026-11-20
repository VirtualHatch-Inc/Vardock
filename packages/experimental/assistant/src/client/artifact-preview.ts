/** Read a bounded UTF-8 preview from the owner-authenticated artifact route. */
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ASSISTANT_ARTIFACT_PATH } from '../artifact-url.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** UTF-8 text read from one witnessed artifact. */
    'assistant-artifact-text': string
  }
}

const MAX_PREVIEW_BYTES = 64 * 1024

/**
 * Build the same owner URL used for download and preview.
 * @param workId - Work report identifier.
 * @param index - Artifact index in the report.
 * @returns Artifact URL relative to the application mount.
 */
export function artifactUrl(workId: string, index: number): string {
  return `.${ASSISTANT_ARTIFACT_PATH}?${new URLSearchParams({ workId, index: String(index) })}`
}

/**
 * Address a small text artifact for an on-demand preview.
 * @param workId - Work report identifier.
 * @param index - Artifact index in the report.
 * @param file - Witnessed file metadata.
 * @returns The resource address when the file is eligible for preview.
 */
export function previewAddress(workId: string, index: number, file: { name: string; bytes: number }): string | undefined {
  if (file.bytes > MAX_PREVIEW_BYTES || !/\.(?:txt|md|markdown|csv)$/iu.test(file.name)) return undefined
  return `dsh-resource://assistant-artifact-text/${workId}/${index}`
}

/**
 * Retrieve preview text without interpreting markup or reading unbounded bytes.
 * @param address - Resource address of a single artifact.
 * @param signal - Lifetime of the preview holder.
 * @returns The text or a failure for an unavailable or invalid preview.
 */
export async function readArtifactPreview(address: string, signal: AbortSignal): Promise<RemoteResult<string>> {
  const failure = { ok: false, error: new RemoteError('gateway/internal', 'Artifact text could not be read.', {}) } as const
  const match = /^dsh-resource:\/\/assistant-artifact-text\/([a-f0-9]{64})\/(0|[1-9][0-9]*)$/u.exec(address)
  const workId = match?.[1]
  const index = match?.[2]
  if (workId === undefined || index === undefined) return failure
  try {
    const response = await fetch(artifactUrl(workId, Number(index)), { signal })
    if (!response.ok || response.body === null) return failure
    const reader = response.body.getReader()
    const buffer = new Uint8Array(MAX_PREVIEW_BYTES)
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value.byteLength > buffer.length - length) {
          await reader.cancel()
          return failure
        }
        buffer.set(chunk.value, length)
        length += chunk.value.byteLength
      }
    } finally {
      reader.releaseLock()
    }
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
  } catch (_error: unknown) {
    return failure
  }
}
