/** Owner links and text previews for witnessed work artifacts. */
import { useState } from 'react'
import { z } from 'zod'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Artifacts.module.css'
import { artifactUrl, previewAddress } from './artifact-preview.ts'

const sourceSchema = z.object({
  kind: z.literal('assistant-work'), direction: z.literal('result'),
  workId: z.string().regex(/^[a-f0-9]{64}$/u),
  artifacts: z.array(z.object({
    name: z.string().min(1), bytes: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })).min(1),
})
type ArtifactSource = z.infer<typeof sourceSchema>
type FileMetadata = ArtifactSource['artifacts'][number]
type Labels = PropsLocale<'assistant'>
type PreviewReader = Pick<PropsRuntime<'conversation.input.status'>, 'useResource'>

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Witnessed work files delivered through the Assistant entrance. */
    'assistant-artifacts': ArtifactSource
  }
}

/** Artifact notices use their original event placement on history replay. */
export const artifactDefinition: ConversationNodeDefinition<ArtifactSource | null> = {
  kind: 'assistant-artifacts', target: 'chat',
  match: event => event.type === 'user/message' && 'artifacts' in event.data.source
    ? { id: String(event.seq), role: 'start' } : null,
  start(_context, match) {
    if (match.event.type !== 'user/message') return null
    const parsed = sourceSchema.safeParse(match.event.data.source)
    return parsed.success ? parsed.data : null
  },
  update: context => context.state,
  buildViewNode(context): ChatNode<'assistant-artifacts'> | null {
    if (context.state == null || context.start === undefined) return null
    return {
      key: context.key, kind: 'assistant-artifacts', id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: 'visible', groupTree: 'turn', data: context.state,
    }
  },
}

/**
 * Show immutable file downloads in the owning conversation.
 * @param props - Recorded artifact metadata and localized action label.
 * @returns File download links; the authority checks permission when each is opened.
 */
export function Artifacts({ node, t }: Pick<PropsRuntime<'conversation.chat.node', 'assistant-artifacts'>, 'node'> & Labels) {
  return <div className={css.files} data-assistant-artifacts={node.data.workId}>
    {node.data.artifacts.map((file, index) => <Download key={index} workId={node.data.workId} index={index} file={file} t={t} />)}
  </div>
}

function Download({ workId, index, file, t }: Labels & { workId: string; index: number; file: FileMetadata }) {
  return <a className={css.file} href={artifactUrl(workId, index)} download={file.name}>
    <span className={css.name}>{file.name}</span>
    <span className={css.action}>{t('download')}</span>
  </a>
}

/**
 * Show files inline on the retained work row.
 * @param props - Witnessed metadata, localization, and the preview resource reader.
 * @returns Download links and optional text previews.
 */
export function WorkArtifacts({ workId, files, useResource, t }: Labels & PreviewReader & {
  workId: string
  files: readonly FileMetadata[]
}) {
  return <ul className={css.workFiles} aria-label={t('artifact.files')} data-assistant-work-artifacts={workId}>
    {files.map((file, index) => <li key={index}>
      <div className={css.workFile}>
        <Download workId={workId} index={index} file={file} t={t} />
        <Preview name={file.name} address={previewAddress(workId, index, file)} useResource={useResource} t={t} />
      </div>
    </li>)}
  </ul>
}

function Preview({ name, address, useResource, t }: Labels & PreviewReader & { name: string; address: string | undefined }) {
  const [open, setOpen] = useState(false)
  if (address === undefined) return null
  return <>
    <Button size="sm" aria-expanded={open}
      aria-label={t(open ? 'artifact.hidePreviewName' : 'artifact.previewName', { name })}
      onClick={() => { setOpen(!open) }}>{t(open ? 'artifact.hidePreview' : 'artifact.preview')}</Button>
    {open && <PreviewText address={address} useResource={useResource} t={t} />}
  </>
}

function revealPreview(element: HTMLElement | null): void {
  if (element !== null && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' })
}

function PreviewText({ address, useResource, t }: Labels & PreviewReader & { address: string }) {
  const preview = useResource<'assistant-artifact-text'>(address)
  if (preview.status === 'loading') return <div ref={revealPreview} className={css.preview} role="status" aria-label={t('artifact.loading')}>
    <StateDot state="ongoing" />
  </div>
  if (preview.status !== 'live') return <div ref={revealPreview} className={css.preview} role="alert">{t('artifact.failed')}</div>
  return <pre ref={revealPreview} className={css.preview} data-assistant-artifact-preview="">{preview.value}</pre>
}
