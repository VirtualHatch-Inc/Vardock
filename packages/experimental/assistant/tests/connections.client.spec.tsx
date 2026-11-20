// @vitest-environment jsdom
/** Connection settings show credential state and send one token without retrying a refused save. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { Connections } from '../src/client/Connections.tsx'
import { connectionDictionaries } from '../src/client/connection-locales.ts'
import { workDictionaries } from '../src/client/work-locales.ts'
import type { BrokerConnections, BrokerConnectionUpdate } from '../src/status-types.ts'

afterEach(cleanup)

const connection = {
  action: 'post-message', description: 'Post one message.', credentialRef: 'MESSAGE_TOKEN', configured: false,
  returnsResponse: true, unattended: [{ match: { channel: 'C1', urgent: false }, allow: [] }], routeChangedSinceRulesSaved: false,
}
const revision = 'a'.repeat(64)
const listed = (configured: boolean): BrokerConnections => ({
  unattendedShell: true, revision, connections: [
    { ...connection, configured },
    {
      action: 'read-record', credentialRef: 'RECORD_TOKEN', configured: true, returnsResponse: false, unattended: [],
      routeChangedSinceRulesSaved: false,
    },
  ],
})
const t: PropsLocale<'assistant'>['t'] = (key, parameters) => {
  let value = Object.entries({ ...workDictionaries.en, ...connectionDictionaries.en }).find(([name]) => name === key)?.[1] ?? key
  for (const [name, replacement] of Object.entries(parameters ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}
const failure = { ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) } as const

it('renders the summary without reading the authority', () => {
  const read = vi.fn(async () => ({ ok: true, value: listed(false) } as const))
  const view = render(<Connections view="summary" read={read} save={vi.fn()} t={t} />)
  expect(view.container.textContent).toBe(connectionDictionaries.en['connections.description'])
  expect(read).not.toHaveBeenCalled()
})

it('names witness recovery without replacing it with a connection error', async () => {
  const read = vi.fn(async () => ({ ok: false, error: new RemoteError('assistant/work-unavailable', 'Unavailable', {
    reason: 'configuration-evidence-unavailable',
  }) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={vi.fn()} t={t} />) })
  expect(screen.getByRole('alert').textContent).toBe(workDictionaries.en['work.witnessWaiting'])
  expect(screen.getByRole('alert').title).toBe('configuration-evidence-unavailable')
  expect(screen.queryByText(connectionDictionaries.en['connections.readFailed'])).toBeNull()
})

it('lists each permitted action with its credential state and saves one token', async () => {
  const read = vi.fn(async () => ({ ok: true, value: listed(false) } as const))
  const save = vi.fn(async (_update: BrokerConnectionUpdate) => ({ ok: true, value: listed(true) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  expect(read).toHaveBeenCalledTimes(1)
  expect(screen.getByText('Post one message.')).toBeTruthy()
  expect(screen.getByText('Not configured')).toBeTruthy()
  expect(screen.getByText('Scripts in the isolated work environment run without approval.')).toBeTruthy()
  expect(screen.getAllByRole('list', { name: 'Approval and data rules' })[0]?.firstElementChild?.textContent).toBe(
    'Sent without approval when channel = "C1", urgent = false. It may contain no other fields. Other requests wait for your approval. Stop sending without approval',
  )
  expect(screen.getByText(connectionDictionaries.en['connections.rulesProfile'])).toBeTruthy()
  expect(screen.queryByText(connectionDictionaries.en['connections.rulesRouteChanged'])).toBeNull()
  expect(screen.getAllByText('The service’s response is returned to work whose permissions allow it, and can then reach the model.')).toHaveLength(1)
  expect(screen.getAllByText('Every request waits for your approval.')).toHaveLength(1)
  expect(screen.getByText('Stored by the authority as MESSAGE_TOKEN. Entering a new value replaces the current one.')).toBeTruthy()
  const [first, second] = screen.getAllByRole('button', { name: 'Save token' })
  expect(first?.hasAttribute('disabled')).toBe(true)
  const field = document.getElementById('assistant-connection-post-message') as HTMLInputElement
  expect(field.type).toBe('password')
  fireEvent.change(field, { target: { value: 'fixture-token' } })
  expect(second?.hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.click(first!) })
  expect(save).toHaveBeenCalledExactlyOnceWith({ action: 'post-message', value: 'fixture-token' }, expect.any(AbortSignal))
  expect(screen.getByRole('status').textContent).toBe('Token saved. The next request uses it.')
  expect(screen.getAllByText('Configured')).toHaveLength(2)
  expect(field.value).toBe('')
})

it('keeps the entered token after a refused save and reports an unavailable read', async () => {
  const read = vi.fn(async () => ({ ok: true, value: listed(false) } as const))
  const save = vi.fn(async () => failure)
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  const field = document.getElementById('assistant-connection-post-message') as HTMLInputElement
  fireEvent.change(field, { target: { value: 'fixture-token' } })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Save token' })[0]!) })
  expect(screen.getByRole('alert').textContent).toContain('not confirmed as saved')
  expect(field.value).toBe('fixture-token')
  expect(save).toHaveBeenCalledTimes(1)
  read.mockResolvedValueOnce(failure as never)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read current connections' })) })
  expect(screen.getByRole('alert').textContent).toContain('Connections are unavailable')
})

it('removes a stored token and offers removal only for a configured action', async () => {
  const read = vi.fn(async () => ({ ok: true, value: listed(false) } as const))
  const save = vi.fn(async (_update: BrokerConnectionUpdate) => ({ ok: true, value: listed(false) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  const remove = screen.getAllByRole('button', { name: 'Remove token' })
  expect(remove).toHaveLength(1)
  await act(async () => { fireEvent.click(remove[0]!) })
  expect(save).toHaveBeenCalledExactlyOnceWith({ action: 'read-record', value: null }, expect.any(AbortSignal))
  expect(screen.getByRole('status').textContent).toBe('Token removed. Requests for this action fail until you save a token.')
})

it('explains an empty list', async () => {
  const empty: BrokerConnections = { unattendedShell: false, revision, connections: [] }
  const read = vi.fn(async () => ({ ok: true, value: empty } as const))
  await act(async () => { render(<Connections view="page" read={read} save={vi.fn()} t={t} />) })
  expect(screen.getByText(connectionDictionaries.en['connections.empty'])).toBeTruthy()
  expect(screen.queryByText(connectionDictionaries.en['connections.rulesProfile'])).toBeNull()
})

it('saves and removes the model key separately from the broker actions', async () => {
  const listed = (configured: boolean): BrokerConnections => ({
    unattendedShell: false, revision, connections: [],
    model: { provider: 'openai', model: 'fixture-model', credentialRef: 'MODEL_KEY', configured },
  })
  const read = vi.fn(async () => ({ ok: true, value: listed(false) } as const))
  const save = vi.fn(async (update: BrokerConnectionUpdate) => ({ ok: true, value: listed('value' in update && update.value !== null) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  expect(screen.getByText('Model: openai / fixture-model')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove token' })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })) })
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(document.querySelector('#assistant-connection-model')!, { target: { value: 'fixture-key' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })) })
  expect(save).toHaveBeenLastCalledWith({ model: true, value: 'fixture-key' }, expect.any(AbortSignal))
  expect(document.querySelector<HTMLInputElement>('#assistant-connection-model')!.value).toBe('')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove token' })) })
  expect(save).toHaveBeenLastCalledWith({ model: true, value: null }, expect.any(AbortSignal))
})

it('adds and removes an unattended rule with the revision it read and refuses conditions that are not a JSON object', async () => {
  const read = vi.fn(async () => ({ ok: true, value: listed(true) } as const))
  const save = vi.fn(async (_update: BrokerConnectionUpdate) => ({ ok: true, value: listed(true) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  const [conditions] = screen.getAllByLabelText('Send without approval when (optional)') as HTMLInputElement[]
  const [add] = screen.getAllByRole('button', { name: 'Send without approval' })
  for (const invalid of ['[1]', '{"channel":', '{"nested":{"a":1}}', '{}']) {
    fireEvent.change(conditions!, { target: { value: invalid } })
    await act(async () => { fireEvent.click(add!) })
    expect(screen.getByRole('alert').textContent).toContain('JSON object')
  }
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(conditions!, { target: { value: '{"channel":"C2"}' } })
  await act(async () => { fireEvent.click(add!) })
  expect(save).toHaveBeenLastCalledWith({
    action: 'post-message', unattended: [...connection.unattended, { match: { channel: 'C2' }, allow: [] }], revision,
  }, expect.any(AbortSignal))
  expect(screen.getByRole('status').textContent).toContain('Approval rules saved')
  expect(conditions!.value).toBe('')
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Send without approval' })[1]!) })
  expect(save).toHaveBeenLastCalledWith({ action: 'read-record', unattended: [{}], revision }, expect.any(AbortSignal))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop sending without approval' })) })
  expect(save).toHaveBeenLastCalledWith({ action: 'post-message', unattended: [], revision }, expect.any(AbortSignal))
})

it('adds a rule that limits the other fields a request may contain and lists those fields', async () => {
  const withAllow = (rules: BrokerConnections['connections'][number]['unattended']): BrokerConnections => ({
    ...listed(true), connections: [{ ...connection, configured: true, unattended: rules }],
  })
  const existing = [{}, { match: { channel: 'C1' }, allow: [] }]
  const read = vi.fn(async () => ({ ok: true, value: withAllow(existing) } as const))
  const save = vi.fn(async (update: BrokerConnectionUpdate) => ({ ok: true, value: withAllow('unattended' in update ? update.unattended : []) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  expect(screen.getByText('Every request is sent without approval.')).toBeTruthy()
  expect(screen.getByText('It may contain no other fields.')).toBeTruthy()
  const conditions = screen.getByLabelText('Send without approval when (optional)') as HTMLInputElement
  const allow = screen.getByLabelText('Other fields the request may contain (optional)') as HTMLInputElement
  fireEvent.change(allow, { target: { value: Array.from({ length: 65 }, (_, index) => `f${index}`).join(',') } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without approval' })) })
  expect(screen.getByRole('alert').textContent).toContain('up to 64 names')
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(conditions, { target: { value: '{"channel":"C2"}' } })
  fireEvent.change(allow, { target: { value: ' text, thread_ts ,' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without approval' })) })
  expect(save).toHaveBeenLastCalledWith({
    action: 'post-message', unattended: [...existing, { match: { channel: 'C2' }, allow: ['text', 'thread_ts'] }], revision,
  }, expect.any(AbortSignal))
  expect(screen.getByText('Other fields it may contain: text, thread_ts. Their values are not checked.').parentElement?.textContent).toBe(
    'Sent without approval when channel = "C2". Other fields it may contain: text, thread_ts. Their values are not checked. Other requests wait for your approval. Stop sending without approval',
  )
  expect([conditions.value, allow.value]).toEqual(['', ''])
  fireEvent.change(allow, { target: { value: 'text' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send without approval' })) })
  expect(save).toHaveBeenLastCalledWith({
    action: 'post-message', unattended: [...existing, { match: { channel: 'C2' }, allow: ['text', 'thread_ts'] }, { allow: ['text'] }], revision,
  }, expect.any(AbortSignal))
  expect(screen.getByText(connectionDictionaries.en['connections.unattendedFields'])).toBeTruthy()
})

it('states on the re-routed action only that its rules are off and saves its rule from an empty list', async () => {
  const [changed, unchanged] = listed(true).connections
  if (changed === undefined || unchanged === undefined) throw new Error('Expected two connections')
  const off: BrokerConnections = {
    ...listed(true), connections: [{ ...changed, unattended: [], routeChangedSinceRulesSaved: true }, unchanged],
  }
  const read = vi.fn(async () => ({ ok: true, value: off } as const))
  const save = vi.fn(async (_update: BrokerConnectionUpdate) => ({ ok: true, value: listed(true) } as const))
  await act(async () => { render(<Connections view="page" read={read} save={save} t={t} />) })
  const notice = screen.getByText('This action changed after you saved its rules, so they are off: every request for it waits for your approval until you save rules for it again, or until the action is again exactly as it was when you saved them. A new save starts from an empty list.')
  expect(notice.closest('[data-assistant-connection]')?.getAttribute('data-assistant-connection')).toBe('post-message')
  expect(screen.getAllByText(connectionDictionaries.en['connections.rulesRouteChanged'])).toHaveLength(1)
  expect(screen.getAllByText('Every request waits for your approval.')).toHaveLength(2)
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Send without approval' })[0]!) })
  expect(save).toHaveBeenLastCalledWith({ action: 'post-message', unattended: [{}], revision }, expect.any(AbortSignal))
  expect(screen.queryByText(connectionDictionaries.en['connections.rulesRouteChanged'])).toBeNull()
})
