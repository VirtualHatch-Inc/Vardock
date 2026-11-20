/** Work file transfers through the Assistant's tools and durable Session log. */
import { createHash } from 'node:crypto'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  OperationControlError, workInputPath, WorkPrincipalId, type FileProposal, type FileTransferReceipt, type OperationId,
} from '@deepseek-ai/dsh-operation-control/handoff'
import { expect, it, vi } from 'vitest'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { hostFixture, stored } from './harness.ts'
import { workExecutionProjection } from '../src/state.ts'

const permitted = {
  exec: true, brokerActions: [],
  data: { import: true, export: true, discloseToModel: true, discloseToUser: true, returnResponses: false },
}
const operationId = brandString<OperationId>('03820331-87b0-45d7-aa23-86a80cd36c98')
const receipt = { id: `${operationId}-outcome`, digest: 'a'.repeat(64) }
const requestText = ({ messages }: GenerateOptions) => messages.flatMap(message =>
  message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')

it('refuses omitted work inputs for the triggering owner attachment before granting or starting work', async (test) => {
  const { boot, handoff, transferFile } = await hostFixture(test)
  const { ctx, main, model } = await boot()
  const signal = new AbortController().signal
  const { receiptId } = await ctx.fileUploads.upload(main, {
    name: 'sample-sales.csv', data: Buffer.from('region,orders,revenue_usd\nWest,20,800\nEast,10,400\nSouth,5,200\n').toString('base64'),
  }, signal)
  await ctx.sessionController.prompt({
    sessionId: main.id, requestId: brandString<SessionRequestId>('sample-file'), mode: 'queue',
    content: [{ type: 'file', receiptId }, { type: 'text', text: 'Delegate a summary of sample-sales.csv.' }],
  }, signal)
  const entrance = await model.next(main.id)
  const [input] = ctx.assistant.listInputs(main)
  if (input === undefined) throw new Error('Expected the uploaded file')
  const before = handoff.mock.calls.length
  entrance.tools({ name: 'delegate_work', args: {
    request_key: 'delegate-sales-summary-20261113-232705',
    prompt: 'You are processing a user-provided CSV attachment saved at /home/owner/.vardock/web/attachments/v1/files/9d/9d333f437e3afa1f622d9b1f2eb0f444d027968f4ef6ea86275672bfba2bc46d/sample-sales.csv. Work only from this CSV\'s data. In the current workspace, read that CSV, compute: 1) total of the orders column, 2) total of the revenue_usd column, 3) the region with the highest revenue_usd total. Then create a Markdown file named sales-summary.md in the workspace summarizing exactly these items in Japanese: 注文件数, 売上合計, 売上が最大の地域. Return the file as a downloadable result. Do not use any external data or assumptions beyond the CSV.',
    permissions: { ...permitted, data: { ...permitted.data, import: false } },
  } })
  const refused = await model.next(main.id)
  expect(refused.options.messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
  expect(requestText(refused.options)).toContain(
    `Fresh work must state inputs for the attachments in this owner request. Select "sample-sales.csv" with inputs: [{"seq":${input.seq},"index":0}]. Pass inputs: [] if this work needs no files. Selected inputs require permissions.data.import: true and both disclosure permissions.`,
  )
  expect(handoff.mock.calls.slice(before).some(([request]) => request.kind === 'delegation')).toBe(false)
  expect(transferFile).not.toHaveBeenCalled()
  expect(ctx.assistant.list()).toEqual([])
  expect(model.observed.some(request => request.options.sessionId !== main.id)).toBe(false)
  refused.text('I will select the attachment before delegating.')
  await main.whenIdle()
})

it('imports the selected owner attachment before sampling and publishes a witnessed artifact', async (test) => {
  const { boot, transferFile, readExportedFile } = await hostFixture(test)
  const { ctx, main, model } = await boot(2, 'assistant-test', async (ctx) => {
    await ctx.plugin(WorkingDirectory)
    ctx.systemPrompt.context({ name: 'sandbox:policy', order: 1, text: 'Host file policy: workspace-write.' })
  })
  const signal = new AbortController().signal
  const attachment = Buffer.from([0, 255, 5, 140])
  const { receiptId } = await ctx.fileUploads.upload(main, { name: 'input.bin', data: attachment.toString('base64') }, signal)
  await ctx.sessionController.prompt({ sessionId: main.id, requestId: brandString<SessionRequestId>('file-request'), mode: 'queue',
    content: [{ type: 'text', text: 'Process this binary file' }, { type: 'file', receiptId }] }, signal)
  const first = await model.next(main.id)
  expect(requestText(first.options)).toContain('do not automatically delegate another attempt')
  expect(first.options.tools?.map(tool => tool.name)).toContain('list_work_inputs')
  first.tools({ name: 'list_work_inputs', args: {} })
  const intake = await model.next(main.id)
  const [input] = ctx.assistant.listInputs(main)
  if (input === undefined) throw new Error('Expected the uploaded file')
  expect(input).toMatchObject({ index: 1, name: 'input.bin', bytes: 4 })
  expect(intake.options.messages.some(message => message.role === 'tool' && message.content.some(block =>
    block.type === 'text' && block.text === JSON.stringify([input])))).toBe(true)

  const proposed = Promise.withResolvers<FileProposal>()
  const imported = Promise.withResolvers<FileTransferReceipt>()
  transferFile.mockImplementationOnce(async (proposal) => {
    proposed.resolve(proposal)
    return imported.promise
  })
  intake.tools({ name: 'delegate_work', args: { request_key: 'process-file', prompt: 'Transform the file.',
    permissions: permitted, inputs: [{ seq: input.seq, index: input.index }] } })
  const proposal = await proposed.promise
  if (proposal.file.kind !== 'import') throw new Error('Expected an import proposal')
  const { source, workId, contentBase64 } = proposal.file
  expect(Buffer.from(contentBase64, 'base64')).toEqual(attachment)
  expect(source).toEqual({ messageSeq: input.seq, contentIndex: input.index, bytes: 4, name: 'input.bin',
    attachmentId: createHash('sha256').update(attachment).digest('hex') })
  try {
    expect(model.observed.some(request => request.options.sessionId === proposal.sessionId)).toBe(false)
    expect(ctx.agents.get(proposal.sessionId)).toBeUndefined()
  } finally {
    imported.resolve({ operationId, receipt, outcome: { kind: 'file-imported', workId, path: workInputPath(source),
      source, bytes: source.bytes, digest: source.attachmentId } })
  }
  const accepted = await model.next(main.id)
  accepted.text('The worker is processing the attachment.')
  await main.whenIdle()
  let worker = await model.next(proposal.sessionId)
  expect(requestText(worker.options)).toContain(`/workspace/${workInputPath(source)}`)
  expect(requestText(worker.options)).toContain('Host Session metadata (not the exec workspace)')
  expect(requestText(worker.options)).not.toContain('Host file policy: workspace-write.')
  expect(JSON.stringify(worker.options.messages)).not.toContain(contentBase64)
  worker.tools({ name: 'exec', args: {} })
  worker = await model.next(proposal.sessionId)

  const exported = Buffer.from([0, 3, 254])
  const outcome = { kind: 'file-exported' as const, workId, path: 'result.bin', targetSessionId: main.id,
    bytes: exported.byteLength, digest: createHash('sha256').update(exported).digest('hex') }
  transferFile.mockRejectedValueOnce(new OperationControlError('file-not-released', 'The witness did not release the artifact.'))
  worker.tools({ name: 'report_work', args: { status: 'completed', result: 'Processed the attachment.', artifacts: ['result.bin'] } })
  const retry = await model.next(proposal.sessionId)
  expect(ctx.assistant.list().find(work => work.id === workId)).toMatchObject({ status: 'running' })
  await expect(ctx.assistant.readArtifact(workId, 0, signal)).rejects.toMatchObject({ code: 'artifact-unavailable' })
  expect(readExportedFile).not.toHaveBeenCalled()
  transferFile.mockResolvedValueOnce({ operationId, receipt, outcome })
  retry.tools({ name: 'report_work', args: { status: 'completed', result: 'Processed the attachment.', artifacts: ['result.bin'] } })
  const notice = await model.next(main.id)
  notice.text('The processed artifact is ready.')
  await main.whenIdle()
  const report = (await stored(ctx, main.id)).find(event => event.type === 'user/message'
    && event.data.source.kind === 'assistant-work' && event.data.source.direction === 'result')
  expect(report).toMatchObject({ data: { source: { artifacts: [{ name: 'result.bin', bytes: 3, digest: outcome.digest }] } } })
  readExportedFile.mockResolvedValueOnce({ operationId, receipt, outcome, contentBase64: exported.toString('base64') })
  await expect(ctx.assistant.readArtifact(workId, 0, signal)).resolves.toEqual({ name: 'result.bin', data: exported })
  const session = ctx.agents.get(proposal.sessionId)?.session
  if (session === undefined) throw new Error('Expected the worker Session')
  const events = await stored(ctx, session.id)
  const initial = workExecutionProjection.init(session.header, session.inheritedEventCount)
  const cut = events.findIndex(event => event.type === 'tool/result')
  const prefix = events.slice(0, cut).reduce((state, event) => workExecutionProjection.apply(state, event), initial)
  const restored = workExecutionProjection.stateSchema.parse(JSON.parse(JSON.stringify(prefix)))
  expect(events.slice(cut).reduce((state, event) => workExecutionProjection.apply(state, event), restored))
    .toEqual(events.reduce((state, event) => workExecutionProjection.apply(state, event), initial))
  expect(events.reduce((state, event) => workExecutionProjection.apply(state, event), initial)).toMatchObject({ workId, executed: true })
  await expect(ctx.assistant.delegate(main, 'changed-inputs', 'Continue with an empty input set.', workId, signal, permitted, []))
    .rejects.toMatchObject({ code: 'work-file-denied' })
  const continuation = await ctx.assistant.delegate(main, 'continue-inputs', 'Inspect the previous files.', workId, signal,
    { ...permitted, data: { ...permitted.data, import: false } })
  expect(continuation.sessionId).toBe(proposal.sessionId)
  const continued = await model.next(continuation.sessionId)
  expect(JSON.stringify(continued.options.messages)).toContain('Inspect the previous files.')
  expect(transferFile).toHaveBeenCalledTimes(3)
  continued.tools({ name: 'report_work', args: { status: 'completed', result: 'Invented totals from an earlier attempt.' } })
  const unexecuted = await model.next(main.id)
  expect(ctx.assistant.list().find(work => work.id === continuation.id)?.status).toBe('failed')
  expect(requestText(unexecuted.options)).not.toContain('Invented totals')
  unexecuted.text('The continuation did not execute.')
  await main.whenIdle()
})

it('refuses to import an attachment without both disclosure permissions', async (test) => {
  const { boot, transferFile } = await hostFixture(test)
  const { ctx, main, model } = await boot()
  const signal = new AbortController().signal
  const { receiptId } = await ctx.fileUploads.upload(main, { name: 'report.txt', data: 'YQ==' }, signal)
  await ctx.sessionController.prompt({ sessionId: main.id, requestId: brandString<SessionRequestId>('restricted-file'), mode: 'queue',
    content: [{ type: 'file', receiptId }] }, signal)
  const intake = await model.next(main.id)
  const [input] = ctx.assistant.listInputs(main)
  if (input === undefined) throw new Error('Expected the uploaded file')
  await expect(ctx.assistant.delegate(main, 'denied', 'Use the file', null, signal,
    { ...permitted, data: { ...permitted.data, discloseToModel: false } }, [{ seq: input.seq, index: input.index }]))
    .rejects.toMatchObject({ code: 'work-file-denied' })
  expect(ctx.assistant.list()).toEqual([])
  expect(transferFile).not.toHaveBeenCalled()
  intake.text('File use requires permission.')
  await main.whenIdle()
})

it.for([
  { exec: true, executed: true }, { exec: true, executed: false }, { exec: false, executed: false },
])('withholds file data or rejects an unexecuted file result (%j)', async ({ exec, executed }, test) => {
  const { boot, transferFile, overview } = await hostFixture(test)
  const { ctx, main, model } = await boot()
  const signal = new AbortController().signal
  const withheld = 'The result is withheld by the current data permissions.'
  const secret = 'The file lists revenue 4711.'
  const { receiptId } = await ctx.fileUploads.upload(main, { name: 'revenue.csv', data: 'NDcxMQ==' }, signal)
  await ctx.sessionController.prompt({ sessionId: main.id, requestId: brandString<SessionRequestId>('revenue-file'), mode: 'queue',
    content: [{ type: 'text', text: 'Summarize this file' }, { type: 'file', receiptId }] }, signal)
  ;(await model.next(main.id)).text('Delegating.')
  await main.whenIdle()
  const [input] = ctx.assistant.listInputs(main)
  if (input === undefined) throw new Error('Expected the uploaded file')
  transferFile.mockImplementationOnce(async ({ file }) => {
    if (file.kind !== 'import') throw new Error('Expected an import proposal')
    const { workId, source } = file
    return { operationId, receipt, outcome: { kind: 'file-imported', workId, path: workInputPath(source), source, bytes: source.bytes, digest: source.attachmentId } }
  })
  const fileWork = await ctx.assistant.delegate(main, 'summarize-file', 'Summarize the file.', null, signal, { ...permitted, exec }, [{ seq: input.seq, index: input.index }])
  let worker = await model.next(fileWork.sessionId)
  expect(requestText(worker.options)).toContain(`"exec":${exec}`)
  expect(JSON.stringify(worker.options.tools)).toContain('Imported-file work cannot be reported complete unless a nonerror exec result was observed in this work')
  if (!executed) {
    worker.tools({ name: 'report_work', args: { status: 'completed', result: secret } })
    const failed = await model.next(main.id)
    expect(ctx.assistant.list().find(work => work.id === fileWork.id)).toMatchObject({
      status: 'failed', result: `${exec ? 'This work has no observed nonerror exec result for its imported files.'
        : 'This work lacks exec permission to read its imported files.'} Imported-file work cannot be reported complete without that observation. Ask the owner before delegating new work with the required permission.`,
    })
    expect(requestText(failed.options)).not.toContain(secret)
    failed.text('Reading the file needs exec permission.')
    await main.whenIdle()
    return
  }
  worker.tools({ name: 'exec', args: {} })
  worker = await model.next(fileWork.sessionId)
  const narrowed = vi.fn((sessionId: string) => sessionId === fileWork.sessionId)
  overview.mockImplementation(async (sessionId, _signal, workId) => ({
    sessionId, ...(workId === undefined ? {} : { workId }), principalId: WorkPrincipalId('fixture-owner'),
    scopeId: 'fixture-scope', expiresAt: 1, expired: true, maxOperations: 4, reserved: 7, remaining: 0,
    pendingApprovals: 0, running: 0, unknown: 0, businessCompletion: { pending: 0, unconfirmed: 0, succeeded: 0, failed: 0 },
    disclosesImportedData: !narrowed(sessionId),
  }))
  worker.tools({ name: 'report_work', args: { status: 'completed', result: secret } })
  const notice = await model.next(main.id)
  expect(requestText(notice.options)).toContain(JSON.stringify({ work_id: fileWork.id, session_id: fileWork.sessionId, status: 'completed', result: withheld }))
  expect(requestText(notice.options)).not.toContain(secret)
  notice.text('Noted.')
  await main.whenIdle()

  const plainWork = await ctx.assistant.delegate(main, 'plain', 'Write a greeting.', null, signal, { exec: false, brokerActions: [] })
  ;(await model.next(plainWork.sessionId)).tools({ name: 'report_work', args: { status: 'completed', result: 'Hello.' } })
  const plainNotice = await model.next(main.id)
  plainNotice.tools({ name: 'list_work', args: {} })
  const listed = await model.next(main.id)
  const listing: unknown = JSON.parse(listed.options.messages.at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '[]')
  expect(listing).toEqual([
    expect.objectContaining({ id: fileWork.id, status: 'completed', result: withheld }),
    expect.objectContaining({ id: plainWork.id, status: 'completed', result: 'Hello.' }),
  ])
  expect(requestText(listed.options)).not.toContain(secret)

  narrowed.mockReturnValue(false)
  listed.tools({ name: 'list_work', args: {} })
  const restored = await model.next(main.id)
  expect(requestText(restored.options)).toContain(JSON.stringify(secret))
  restored.text('Both results are available.')
  await main.whenIdle()
})
