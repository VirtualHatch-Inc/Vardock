/** Owner-authenticated downloads of witnessed work artifacts. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { OperationControlError } from '@deepseek-ai/dsh-operation-control/handoff'
import { WorkId } from './state.ts'
import { ASSISTANT_ARTIFACT_PATH } from './artifact-url.ts'

/**
 * Register downloads using the connection service's owner-only Fetch route.
 * @param ctx - Connection registration owner.
 * @param runtime - Work-owned artifact reader, including current authority checks.
 */
export function registerAssistantArtifacts(ctx: Context, runtime: {
  readArtifact(workId: WorkId, index: number, signal: AbortSignal): Promise<{ name: string; data: Uint8Array }>
}): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: ASSISTANT_ARTIFACT_PATH, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const headers = {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      }
      const params = new URL(request.url).searchParams
      const id = params.get('workId')
      const index = params.get('index')
      if (id === null || !/^[a-f0-9]{64}$/u.test(id) || index === null || !/^(0|[1-9][0-9]*)$/u.test(index)
        || !Number.isSafeInteger(Number(index))) {
        return new Response('Invalid artifact coordinates.', { status: 400, headers })
      }
      try {
        const artifact = await runtime.readArtifact(WorkId(id), Number(index), request.signal)
        const filename = encodeURIComponent(artifact.name).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        return new Response(artifact.data.slice(), {
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
            'Content-Length': String(artifact.data.byteLength),
          },
        })
      } catch (error: unknown) {
        if (!(error instanceof OperationControlError)) throw error
        return new Response('This artifact is unavailable. Return to Assistant to inspect the work.', {
          status: error.code === 'artifact-unavailable' ? 404 : 403, headers,
        })
      }
    },
  }), 'assistant: artifact downloads')
}
