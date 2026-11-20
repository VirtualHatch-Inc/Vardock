// @vitest-environment jsdom
/** Owner settings retain usage and require rereading after an unconfirmed save. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { GrantSettings } from '../src/client/GrantSettings.tsx'
import { grantDictionaries } from '../src/client/grant-locales.ts'
import type { OperationGrantBudget, OperationGrantUpdate } from '../src/status-types.ts'

afterEach(cleanup)

const budget: OperationGrantBudget = {
  principalId: brandString<OperationGrantBudget['principalId']>('owner'), scopeId: 'scope', revision: 'a'.repeat(64),
  configuration: { id: `configuration-${'b'.repeat(64)}`, digest: 'c'.repeat(64) }, maxOperations: 100, reserved: 70, remaining: 30, expiresAt: Date.UTC(2026, 10, 20, 12, 0, 0, 123), expired: false,
}
const t: PropsLocale<'assistant'>['t'] = (key, parameters) => {
  let value = Object.entries(grantDictionaries.en).find(([name]) => name === key)?.[1] ?? key
  for (const [name, replacement] of Object.entries(parameters ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}
const failure = { ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) } as const

it('saves the reviewed revision and absolute total without resetting reservations', async () => {
  const read = vi.fn(async () => ({ ok: true, value: budget } as const))
  const update = vi.fn(async (input: OperationGrantUpdate) => ({ ok: true, value: {
    ...budget, ...input, revision: 'b'.repeat(64), remaining: input.maxOperations - budget.reserved,
  } } as const))
  render(<GrantSettings active read={read} update={update} refresh={vi.fn()} t={t} />)
  expect(read).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Usage settings' })) })
  expect(screen.getByText('70 reservations already used; they remain counted.')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Total reservation limit'), { target: { value: '150' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save limits' })) })
  expect(update).toHaveBeenCalledWith(
    { revision: budget.revision, maxOperations: 150, expiresAt: budget.expiresAt }, expect.any(AbortSignal),
  )
  expect(screen.getByRole('status').textContent).toBe('Limits saved. Work has not been restarted.')
  expect(screen.getByText('70 reservations already used; they remain counted.')).toBeTruthy()
})

it('retains edits after a refused save and requires current settings before another attempt', async () => {
  const read = vi.fn(async () => ({ ok: true, value: budget } as const))
  const update = vi.fn(async () => failure)
  render(<GrantSettings active read={read} update={update} refresh={vi.fn()} t={t} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Usage settings' })) })
  fireEvent.change(screen.getByLabelText('Total reservation limit'), { target: { value: '150' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save limits' })) })
  expect(screen.getByRole('alert').textContent).toContain('Read current settings')
  expect(screen.getByLabelText('Total reservation limit').getAttribute('value')).toBe('150')
  expect(screen.getByRole('button', { name: 'Save limits' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read current settings' })) })
  expect(screen.getByLabelText('Total reservation limit').getAttribute('value')).toBe('100')
  expect(screen.getByRole('button', { name: 'Save limits' }).hasAttribute('disabled')).toBe(false)
  expect(update).toHaveBeenCalledTimes(1)
})

it('does not accept a late save response after disconnect or retry it on reconnect', async () => {
  const answer = Promise.withResolvers<RemoteResult<OperationGrantBudget>>()
  const read = vi.fn(async () => ({ ok: true, value: budget } as const))
  const update = vi.fn((_input: OperationGrantUpdate, _signal: AbortSignal) => answer.promise)
  const refresh = vi.fn()
  const view = render(<GrantSettings active read={read} update={update} refresh={refresh} t={t} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Usage settings' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save limits' })) })
  view.rerender(<GrantSettings active={false} read={read} update={update} refresh={refresh} t={t} />)
  expect(update.mock.calls[0]?.[1].aborted).toBe(true)
  await act(async () => { answer.resolve({ ok: true, value: budget }) })
  view.rerender(<GrantSettings active read={read} update={update} refresh={refresh} t={t} />)
  expect(update).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('alert').textContent).toContain('Read current settings')
  expect(screen.getByRole('button', { name: 'Save limits' }).hasAttribute('disabled')).toBe(true)
})
