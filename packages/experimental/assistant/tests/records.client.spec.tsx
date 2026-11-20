// @vitest-environment jsdom
/** Business records list each request's decision, outcome, and exact body and page through older records. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { Records } from '../src/client/Records.tsx'
import { recordDictionaries } from '../src/client/record-locales.ts'
import type { BusinessRecords, OperationId } from '../src/status-types.ts'

afterEach(cleanup)

type Row = BusinessRecords['records'][number]
type ReceiptId = Extract<Row['businessCompletion'], { receiptId: string }>['receiptId']
const resolve = async () => ({ ok: true, value: { confirmed: true } } as const)
const empty: BusinessRecords = { records: [] }

const id = (digit: string) => brandString<OperationId>(`${digit.repeat(8)}-0000-4000-8000-000000000000`)
const row = (digit: string, fields: Partial<Row>): Row => ({
  id: id(digit), sessionId: SessionId('worker-1'), action: 'post-message', state: 'settled', canReconcile: false,
  businessCompletion: { kind: 'unconfirmed' }, method: 'POST', endpoint: 'https://service.example/messages', body: `{"text":"${digit}"}`, ...fields,
})
const receipt = { id: 'r', digest: 'a'.repeat(64) }
const t: PropsLocale<'assistant'>['t'] = (key, parameters) => {
  let value = Object.entries(recordDictionaries.en).find(([name]) => name === key)?.[1] ?? key
  for (const [name, replacement] of Object.entries(parameters ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}
const failure = { ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) } as const
const facts = (operation: OperationId) => [...document.querySelectorAll(`[data-assistant-record="${operation}"] div > span`)].map(span => span.textContent)

it('renders the summary without reading the authority', () => {
  const read = vi.fn()
  const view = render(<Records view="summary" read={read} resolve={resolve} t={t} />)
  expect(view.container.textContent).toBe(recordDictionaries.en['records.description'])
  expect(read).not.toHaveBeenCalled()
})

it('lists the decision, outcome, receipt, confirmed completion, and exact request of each record', async () => {
  const records = [
    row('1', { approval: 'unattended', outcome: { kind: 'business-response', statusCode: 201 }, receipt }),
    row('2', { approval: 'denied', state: 'canceled', receipt }),
    row('3', { approval: 'approved', tool: 'send', outcome: { kind: 'business-response', toolError: true }, receipt,
      businessCompletion: { kind: 'succeeded', receiptId: brandString<ReceiptId>('x'), receipt } }),
    row('4', { state: 'pending-approval' }),
    row('5', { approval: 'approved', state: 'unknown', outcome: { kind: 'unknown', code: 'authority-interrupted' } }),
    row('6', { state: 'canceled' }),
  ]
  const read = vi.fn(async () => ({ ok: true, value: { records } } as const))
  await act(async () => { render(<Records view="page" read={read} resolve={resolve} t={t} />) })
  expect(read).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal))
  expect(records.map(({ id }) => facts(id))).toEqual([
    ['Sent without approval by a rule', 'HTTP 201', 'Witness receipt recorded'],
    ['Denied', 'Not sent', 'Witness receipt recorded'],
    ['Tool: send', 'Approved', 'The tool reported an error', 'Witness receipt recorded', 'A lookup confirmed it completed'],
    ['Waiting for approval', 'No witness receipt'],
    ['Approved', 'Outcome unknown (authority-interrupted)', 'No witness receipt'],
    ['Canceled before a decision', 'Not sent', 'No witness receipt'],
  ])
  const request = document.querySelector(`[data-assistant-record="${id('1')}"] details`)
  expect(request?.hasAttribute('open')).toBe(false)
  expect(request?.querySelector('pre')?.textContent).toBe('POST https://service.example/messages\n\n{"text":"1"}')
  expect(screen.queryByRole('button', { name: 'Read older records' })).toBeNull()
})

it('appends older records with the cursor and replaces them when reading current records', async () => {
  const read = vi.fn(async (after: OperationId | undefined) => ({ ok: true, value: after === undefined
    ? { records: [row('2', { approval: 'approved' })], next: id('2') }
    : { records: [row('1', { approval: 'approved' })] } } as const))
  await act(async () => { render(<Records view="page" read={read} resolve={resolve} t={t} />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read older records' })) })
  expect(read).toHaveBeenLastCalledWith(id('2'), expect.any(AbortSignal))
  expect(document.querySelectorAll('[data-assistant-record]')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Read older records' })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read current records' })) })
  expect(read).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  expect(document.querySelectorAll('[data-assistant-record]')).toHaveLength(1)
})

it('explains an empty list and keeps shown records after a failed read', async () => {
  const read = vi.fn(async () => ({ ok: true, value: empty } as const))
  await act(async () => { render(<Records view="page" read={read} resolve={resolve} t={t} />) })
  expect(screen.getByText(recordDictionaries.en['records.empty'])).toBeTruthy()
  read.mockResolvedValueOnce({ ok: true, value: { records: [row('1', { approval: 'approved' })] } } as never)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read current records' })) })
  read.mockResolvedValueOnce(failure as never)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read current records' })) })
  expect(screen.getByRole('alert').textContent).toBe(recordDictionaries.en['records.readFailed'])
  expect(document.querySelectorAll('[data-assistant-record]')).toHaveLength(1)
})

it.for(['succeeded', 'failed'] as const)('records the owner determination %s and names the owner in the row', async (kind) => {
  let record = row('1', { state: 'unknown', outcome: { kind: 'unknown', code: 'authority-interrupted' } })
  const read = vi.fn(async () => ({ ok: true as const, value: { records: [record] } }))
  const pending = Promise.withResolvers<{ ok: true; value: { confirmed: boolean } }>()
  const resolve = vi.fn(async () => pending.promise)
  await act(async () => { render(<Records view="page" read={read} resolve={resolve} t={t} />) })
  const label = kind === 'succeeded' ? 'I checked: it happened' : 'I checked: it did not happen'
  expect(screen.getByRole('button', { name: 'I checked: it happened' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'I checked: it did not happen' })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ id: record.id, kind }, expect.any(AbortSignal))
  expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe(recordDictionaries.en['records.waiting'])
  record = { ...record, businessCompletion: { kind, source: 'owner', receipt } }
  await act(async () => { pending.resolve({ ok: true, value: { confirmed: true } }) })
  expect(facts(record.id)).toContain(kind === 'succeeded' ? 'The owner checked: it happened' : 'The owner checked: it did not happen')
  expect(screen.queryByRole('button', { name: label })).toBeNull()
  expect(screen.queryByRole('button', { name: 'I checked: it did not happen' })).toBeNull()
})

it('keeps unresolved records and reports an unconfirmed determination or failed owner request', async () => {
  const read = vi.fn(async () => ({ ok: true as const, value: { records: [row('1', { outcome: { kind: 'unknown', code: 'lost' } })] } }))
  const resolve = vi.fn(async () => ({ ok: true, value: { confirmed: false } } as const))
  await act(async () => { render(<Records view="page" read={read} resolve={resolve} t={t} />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'I checked: it happened' })) })
  expect(screen.getByRole('alert').textContent).toBe(recordDictionaries.en['records.resolutionFailed'])
  expect(read).toHaveBeenCalledOnce()
  resolve.mockResolvedValueOnce(failure as never)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'I checked: it did not happen' })) })
  expect(screen.getByRole('alert').textContent).toBe(recordDictionaries.en['records.resolutionFailed'])
  resolve.mockRejectedValueOnce(new Error('Disconnected'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'I checked: it happened' })) })
  expect(screen.getByRole('alert').textContent).toBe(recordDictionaries.en['records.resolutionFailed'])
})
