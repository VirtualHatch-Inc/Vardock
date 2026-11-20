/** Resolve work inputs from owner messages and verify bytes before transfer. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { WorkInputFile } from '@deepseek-ai/dsh-operation-control/handoff'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { z } from 'zod'

/** Coordinates of one attachment block in the entrance Session. */
const inputCoordinatesSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
})

/** Coordinates of one attachment block in the entrance Session. */
export type InputCoordinates = z.infer<typeof inputCoordinatesSchema>

/** Model-visible attachment metadata. The sequence and index select one logged occurrence. */
export const availableInputSchema = inputCoordinatesSchema.extend({
  name: z.string(), bytes: z.number().int().nonnegative(),
})

/** Metadata for one attachment from the latest eligible owner message. */
export type AvailableInput = z.infer<typeof availableInputSchema>

type OwnerMessage = Extract<SessionEvent, { type: 'user/message' }>

function ownerMessage(event: SessionEvent): event is OwnerMessage {
  return event.type === 'user/message' && event.data.source.kind === 'user' && !('principal' in event.data.source)
}

const imageExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

function imageName(attachment: { name?: string; mediaType: keyof typeof imageExtensions }): string {
  return attachment.name || `image.${imageExtensions[attachment.mediaType]}`
}

/**
 * Extract attachment coordinates from one eligible owner message.
 * @param event - appended Session event.
 * @returns metadata for its file and image blocks in message order.
 */
export function inputsInEvent(event: SessionEvent): AvailableInput[] {
  if (!ownerMessage(event)) return []
  return event.data.content.flatMap((block, index) => {
    if (block.type === 'file') return [{ seq: event.seq, index, name: block.attachment.name, bytes: block.attachment.bytes }]
    if (block.type === 'image') return [{ seq: event.seq, index, name: imageName(block.attachment), bytes: block.attachment.bytes }]
    return []
  })
}

/** Expected refusal to resolve or verify a work attachment. */
export class WorkInputError extends Error {
  /** Stable reason for an unavailable input occurrence or invalid bytes. */
  readonly code = 'work-input-unavailable'
}

/**
 * Load and verify the exact bytes of an owner attachment before proposing a transfer.
 * @param ctx - Session query and attachment providers.
 * @param sessionId - configured entrance Session.
 * @param input - owner message and content position.
 * @param limit - maximum permitted byte length.
 * @param signal - cancellation of the read.
 * @returns verified bytes and their exact authority scope.
 */
export async function readWorkInput(
  ctx: Pick<Context, 'sessionQuery' | 'attachments'>, sessionId: SessionId, input: InputCoordinates, limit: number, signal: AbortSignal,
): Promise<{ source: WorkInputFile; data: Uint8Array }> {
  const invalid = (): WorkInputError => new WorkInputError('Select an attachment from an owner message in the Assistant conversation.')
  if (!inputCoordinatesSchema.safeParse(input).success || Object.is(input.seq, -0)) throw invalid()
  const seq = SessionSeq(input.seq)
  const { target, inheritedEventCount } = await ctx.sessionQuery.readEvent({ sessionId, seq }, signal).catch((error: unknown) => {
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_EVENT_NOT_FOUND') throw invalid()
    throw error
  })
  const block = seq >= inheritedEventCount && ownerMessage(target) ? target.data.content[input.index] : undefined
  if (block?.type !== 'file' && block?.type !== 'image') {
    throw invalid()
  }
  const { bytes } = block.attachment
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit) {
    throw new WorkInputError(`The attachment exceeds the work file limit of ${limit} bytes.`)
  }
  let name: string
  let data: Uint8Array
  if (block.type === 'file') {
    name = block.attachment.name
    data = new Uint8Array(bytes)
    let offset = 0
    for await (const chunk of ctx.attachments.readFileStream(block.attachment, signal)) {
      if (offset + chunk.byteLength > bytes) throw new WorkInputError('The attachment size changed during verification.')
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (offset !== bytes) throw new WorkInputError('The attachment size changed during verification.')
  } else {
    name = imageName(block.attachment)
    data = (await ctx.attachments.readImage(block.attachment, signal)).data
    if (data.byteLength !== bytes) throw new WorkInputError('The attachment size changed during verification.')
  }
  signal.throwIfAborted()
  const attachmentId = createHash('sha256').update(data).digest('hex')
  return { source: { attachmentId, name, bytes, messageSeq: seq, contentIndex: input.index }, data }
}
