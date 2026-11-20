/** Owner-edited usage limits, read and committed by the operation authority. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { OperationGrantBudget, OperationGrantUpdate } from '../status-types.ts'
import css from './GrantSettings.module.css'

interface Props extends PropsLocale<'assistant'> {
  readonly active: boolean
  readonly read: (signal: AbortSignal) => Promise<RemoteResult<OperationGrantBudget>>
  readonly update: (input: OperationGrantUpdate, signal: AbortSignal) => Promise<RemoteResult<OperationGrantBudget>>
  readonly refresh: () => void
}

function localTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.valueOf())) return ''
  const day = [date.getFullYear().toString().padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')
  return [day, time].join('T')
}

/**
 * Edit only the total reservation limit and expiry through the owner connection.
 * @param props - Current connection state, privileged requests, and localized labels.
 * @returns Explicit read, edit, and save controls; disconnects never retry a write.
 */
export function GrantSettings({ active, read, update, refresh, t }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [current, setCurrent] = useState<OperationGrantBudget>()
  const [limit, setLimit] = useState('')
  const [expiry, setExpiry] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'grant.readFailed' | 'grant.saveFailed' | 'grant.saved'>()
  const request = useRef<AbortController>()

  useEffect(() => {
    if (!active && request.current !== undefined) {
      request.current.abort()
      request.current = undefined
      setBusy(false)
      setNotice('grant.saveFailed')
    }
  }, [active])
  useEffect(() => () => { request.current?.abort(); request.current = undefined }, [])

  const perform = async (write: boolean): Promise<void> => {
    if (!active || request.current !== undefined || (write && current === undefined)) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setNotice(undefined)
    try {
      const result = write && current !== undefined
        ? await update({ revision: current.revision, maxOperations: Number(limit),
          expiresAt: expiry === localTime(current.expiresAt) ? current.expiresAt : new Date(expiry).valueOf(),
        }, controller.signal)
        : await read(controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) {
        setNotice(write ? 'grant.saveFailed' : 'grant.readFailed')
        return
      }
      setCurrent(result.value)
      setLimit(String(result.value.maxOperations))
      setExpiry(localTime(result.value.expiresAt))
      if (write) setNotice('grant.saved')
    } catch (_error: unknown) {
      if (!controller.signal.aborted) setNotice(write ? 'grant.saveFailed' : 'grant.readFailed')
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setBusy(false)
        refresh()
      }
    }
  }
  const valid = Number.isSafeInteger(Number(limit)) && Number(limit) > 0
    && expiry !== '' && Number.isSafeInteger(new Date(expiry).valueOf()) && new Date(expiry).valueOf() > 0
  const needsRead = notice === 'grant.saveFailed' || notice === 'grant.readFailed'

  return <div className={css.root} data-assistant-grant="">
    <Button size="sm" aria-expanded={expanded} disabled={!active || busy} onClick={() => {
      setExpanded(!expanded)
      if (!expanded) void perform(false)
    }}>{t('grant.title')}</Button>
    {expanded && <form className={css.form} onSubmit={(event) => { event.preventDefault(); if (valid && !needsRead) void perform(true) }}>
      <p>{t('grant.description')}</p>
      {current !== undefined && <>
        <p>{t('grant.reserved', { count: current.reserved })}</p>
        <div className={css.fields}>
          <label>{t('grant.limit')}<Input type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1}
            value={limit} disabled={!active || busy} onChange={(event) => { setLimit(event.target.value) }} required /></label>
          <label>{t('grant.expiry')}<Input type="datetime-local" step={1}
            value={expiry} disabled={!active || busy} onChange={(event) => { setExpiry(event.target.value) }} required /></label>
        </div>
        <p>{t('grant.effect')}</p>
      </>}
      <div className={css.actions}>
        <Button size="sm" type="button" disabled={!active || busy} onClick={() => { void perform(false) }}>{t('grant.reload')}</Button>
        {current !== undefined && <Button size="sm" type="submit" variant="outline" disabled={!active || busy || !valid || needsRead}>{t('grant.save')}</Button>}
      </div>
      {busy && <p role="status">{t('grant.waiting')}</p>}
      {notice !== undefined && <p role={notice === 'grant.saved' ? 'status' : 'alert'}>{t(notice)}</p>}
    </form>}
  </div>
}
