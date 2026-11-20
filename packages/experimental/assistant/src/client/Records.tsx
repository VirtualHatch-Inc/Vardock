/** The owner's read of the business requests the operation authority recorded. */
import { useEffect, useRef, useState } from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { BusinessRecords, BusinessResolution, OperationId } from '../status-types.ts'
import css from './Records.module.css'

/** Privileged owner access supplied by the Assistant client plugin. */
export interface RecordsInjected {
  /** Read the newest page of records, or the page older than `after`, through the owner connection. */
  readonly read: (after: OperationId | undefined, signal: AbortSignal) => Promise<RemoteResult<BusinessRecords>>
  /** Record an owner-checked outcome, effective only after witness confirmation. */
  readonly resolve: (resolution: BusinessResolution, signal: AbortSignal) => Promise<RemoteResult<{ confirmed: boolean }>>
}

interface Props extends RecordsInjected, PropsLocale<'assistant'> {
  readonly view: 'summary' | 'page'
}

type Row = BusinessRecords['records'][number]
type T = Props['t']

function decisionOf({ approval, state }: Row, t: T): string {
  switch (approval) {
    case 'approved': return t('records.approved')
    case 'denied': return t('records.denied')
    case 'unattended': return t('records.unattended')
    case undefined: return t(state === 'pending-approval' ? 'records.pending' : 'records.undecided')
  }
}

function outcomeOf({ outcome, state }: Row, t: T): string | undefined {
  switch (outcome?.kind) {
    case 'business-response': return outcome.statusCode === undefined
      ? t(outcome.toolError === true ? 'records.toolError' : 'records.toolOk') : t('records.status', { status: outcome.statusCode })
    case 'business-not-sent': return t('records.notSentCode', { code: outcome.code })
    case 'unknown': return t('records.unknown', { code: outcome.code })
    case undefined: return state === 'canceled' ? t('records.notSent') : undefined
  }
}

function dotOf({ outcome, state }: Row): StateDotState {
  if (outcome?.kind === 'business-response') return outcome.toolError === true || (outcome.statusCode ?? 0) >= 400 ? 'error' : 'done'
  if (outcome !== undefined) return 'warning'
  return state === 'canceled' ? 'idle' : 'ongoing'
}

/**
 * List the recorded business requests of every work Session, newest first, and record owner-checked outcomes.
 * @param props - Page view, privileged owner access, and localized labels.
 * @returns The one-line summary, or the list with controls to read older and current records.
 */
export function Records({ view, read, resolve, t }: Props) {
  const [page, setPage] = useState<BusinessRecords>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [resolutionFailed, setResolutionFailed] = useState(false)
  const request = useRef<AbortController>()

  const load = async (after?: OperationId): Promise<void> => {
    if (request.current !== undefined) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setFailed(false)
    setResolutionFailed(false)
    try {
      const result = await read(after, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) {
        setFailed(true)
        return
      }
      const { records, next } = result.value
      setPage(current => ({
        records: after === undefined || current === undefined ? records : [...current.records, ...records],
        ...(next === undefined ? {} : { next }),
      }))
    } catch (_error: unknown) {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setBusy(false)
      }
    }
  }
  const determine = async (id: OperationId, kind: BusinessResolution['kind']): Promise<void> => {
    if (request.current !== undefined) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setResolutionFailed(false)
    let confirmed = false
    try {
      const result = await resolve({ id, kind }, controller.signal)
      if (controller.signal.aborted) return
      confirmed = result.ok && result.value.confirmed
      setResolutionFailed(!confirmed)
    } catch (_error: unknown) {
      if (!controller.signal.aborted) setResolutionFailed(true)
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setBusy(false)
      }
    }
    if (confirmed) await load()
  }
  const open = view === 'page'
  useEffect(() => {
    if (open) void load()
    return () => { request.current?.abort(); request.current = undefined }
  // The first read belongs to opening the page; later reads are explicit.
  }, [open])

  if (!open) return t('records.description')
  return <div className={css.root} data-assistant-records="">
    <p>{t('records.detail')}</p>
    {page?.records.length === 0 && <p>{t('records.empty')}</p>}
    {page !== undefined && page.records.length > 0 && <ul className={css.rows}>
      {page.records.map((row) => {
        const outcome = outcomeOf(row, t)
        const { businessCompletion: completion } = row
        return <li key={row.id} className={css.row} data-assistant-record={row.id}>
          <h3><StateDot state={dotOf(row)} /> {row.action}</h3>
          <div className={css.facts}>
            {row.tool !== undefined && <span>{t('records.tool', { tool: row.tool })}</span>}
            <span>{decisionOf(row, t)}</span>
            {outcome !== undefined && <span>{outcome}</span>}
            <span>{t(row.receipt === undefined ? 'records.unwitnessed' : 'records.witnessed')}</span>
            {completion.kind === 'succeeded' && <span>{t('source' in completion ? 'records.ownerSucceeded' : 'records.succeeded')}</span>}
            {completion.kind === 'failed' && <span>{t('source' in completion ? 'records.ownerFailed' : 'records.failed')}</span>}
          </div>
          {(row.outcome?.kind === 'unknown' || row.outcome?.kind === 'business-response')
            && completion.kind !== 'succeeded' && completion.kind !== 'failed' && <div className={css.actions}>
            <Button size="sm" type="button" variant="outline" disabled={busy}
              onClick={() => { void determine(row.id, 'succeeded') }}>{t('records.happened')}</Button>
            <Button size="sm" type="button" variant="outline" disabled={busy}
              onClick={() => { void determine(row.id, 'failed') }}>{t('records.didNotHappen')}</Button>
          </div>}
          <details className={css.request}>
            <summary>{t('records.body')}</summary>
            <pre>{`${row.method} ${row.endpoint}\n\n${row.body}`}</pre>
          </details>
        </li>
      })}
    </ul>}
    <div className={css.actions}>
      <Button size="sm" type="button" disabled={busy} onClick={() => { void load() }}>{t('records.reload')}</Button>
      {page?.next !== undefined && <Button size="sm" type="button" variant="outline" disabled={busy}
        onClick={() => { void load(page.next) }}>{t('records.older')}</Button>}
    </div>
    {busy && <p role="status">{t('records.waiting')}</p>}
    {failed && <p role="alert">{t('records.readFailed')}</p>}
    {resolutionFailed && <p role="alert">{t('records.resolutionFailed')}</p>}
  </div>
}
