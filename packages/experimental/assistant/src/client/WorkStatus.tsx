/** Work and authority status in the Assistant's existing composer dock. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { OperationGrantBudget, OperationGrantUpdate } from '../status-types.ts'
import { WorkArtifacts } from './Artifacts.tsx'
import { GrantSettings } from './GrantSettings.tsx'
import { SAMPLE_CSV, SAMPLE_FILE_NAME } from './sample.ts'
import { WORK_STATUS_ADDRESS, type WorkStatusFrame } from './status-source.ts'
import css from './WorkStatus.module.css'

type Status = WorkStatusFrame['status']
type Work = Status['work'][number]
type WorkOperations = Extract<NonNullable<Work['operations']>, { kind: 'available' }>['value']
type Effect = WorkOperations['business'][number]
type Labels = PropsLocale<'assistant'>
type T = Labels['t']
type PreviewReader = Pick<PropsRuntime<'conversation.input.status'>, 'useResource'>

/** Browser observations and owner actions for one entrance view. */
export interface WorkStatusInjected {
  readonly hooks: {
    entrance: { getSnapshot(): SessionId | undefined; subscribe(listener: () => void): () => void }
    generation: ConnectionGenerationState
  }
  readonly openSession: (id: SessionId) => void
  readonly refresh: () => void
  readonly stopWork: (sessionId: SessionId, workId: Work['id'], signal: AbortSignal) => Promise<RemoteResult<object>>
  readonly checkOutcome: (sessionId: SessionId, workId: Work['id'], operationId: Effect['id'], signal: AbortSignal) => Promise<RemoteResult<object>>
  readonly grantSettings: (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<OperationGrantBudget>>
  readonly updateGrant: (
    sessionId: SessionId, input: OperationGrantUpdate, signal: AbortSignal,
  ) => Promise<RemoteResult<OperationGrantBudget>>
  readonly prepareDraft: (sessionId: SessionId, text: string, files?: readonly File[]) => boolean
  readonly formatExpiry: (timestamp: number) => string
}

type Props = PropsRuntime<'conversation.input.status'> & InjectFace<WorkStatusInjected> & Labels

const workLabels = {
  queued: 'work.queued', running: 'work.running', completed: 'work.completed',
  needs_input: 'work.needsInput', failed: 'work.failed', unknown: 'work.unknown', canceled: 'work.stopped',
} as const satisfies Record<Work['status'], string>

function effectLabel(effect: Effect): Parameters<T>[0] {
  if (effect.completion === 'succeeded') return 'work.externalSucceeded'
  if (effect.completion === 'failed') return 'work.externalFailed'
  if (effect.completion === 'pending') return 'work.externalPending'
  if (effect.dispatch === 'pending-approval') return 'work.approval'
  if (effect.dispatch === 'running') return 'work.running'
  if (effect.dispatch === 'queued') return 'work.queued'
  if (effect.dispatch === 'not-sent') return 'work.externalNotSent'
  return 'work.externalUnknown'
}

function issueLabel(t: T, code: string): string {
  switch (code) {
    case 'approval-rejected': return t('work.approvalDenied')
    case 'operation-canceled':
    case 'ABORTED':
    case 'EXEC_CANCELLED': return t('work.operationCanceled')
    case 'grant-expired': return t('work.grantExpired')
    case 'budget-exhausted': return t('work.exhausted')
    case 'authority-interrupted': return t('work.authorityInterrupted')
    case 'revision-mismatch': return t('work.grantChanged')
    default: return t('work.lastIssue', { code })
  }
}

function workLabel(work: Work): Parameters<T>[0] {
  const operations = work.operations?.kind === 'available' ? work.operations.value : undefined
  const completion = operations?.businessCompletion
  const confirmed = operations?.unknown === 0 && completion !== undefined && completion.succeeded + completion.failed > 0
    && completion.unconfirmed === 0 && completion.pending === 0
  if (confirmed && (work.status === 'unknown' || (work.status === 'failed' && operations.lastFailure === undefined))) {
    return completion.failed > 0 ? 'work.externalFailed' : 'work.externalSucceeded'
  }
  return workLabels[work.status]
}

function hasUncertainty(work: Work): boolean {
  const completion = work.operations?.kind === 'available' ? work.operations.value.businessCompletion : undefined
  return workLabel(work) === 'work.unknown' || (completion?.unconfirmed ?? 0) > 0 || (completion?.pending ?? 0) > 0
}

function WorkRow({
  work, t, active, busy, expired, canDraft, useResource, openSession, stop, check, continueWork,
}: Labels & PreviewReader & {
  work: Work
  active: boolean
  busy: boolean
  expired: boolean
  canDraft: boolean
  openSession: WorkStatusInjected['openSession']
  stop: (id: Work['id']) => void
  check: (workId: Work['id'], operationId: Effect['id']) => void
  continueWork: (work: Work) => void
}) {
  const observed = work.operations?.kind === 'available' ? work.operations.value : undefined
  const label = workLabel(work)
  const checked = label === 'work.externalSucceeded' || label === 'work.externalFailed'
  const marker = '\n\nWorker report (completed): '
  const reportAt = work.status === 'unknown' ? work.result?.indexOf(marker) ?? -1 : -1
  const result = reportAt < 0 ? work.result : work.result?.slice(reportAt + marker.length)
  const continuable = work.inspectable && (work.status === 'needs_input' || work.status === 'unknown')
  return <li className={css.row} data-assistant-work-id={work.id} data-work-status={work.status}>
    <p className={css.prompt}>{work.prompt}</p>
    <div className={css.facts}>
      <span>{t(label)}</span>
      {(observed?.pendingApprovals ?? 0) > 0 && <span>{t('work.approval')}</span>}
      {(observed?.unknown ?? 0) > 0 && <span>{t('work.dispatchUnknown')}</span>}
      {work.operations?.kind === 'unavailable' && <span title={work.operations.code}>{work.operations.code === 'configuration-evidence-unavailable'
        ? t('work.witnessWaiting') : t('work.authorityUnavailable', { code: work.operations.code })}</span>}
      {observed?.lastFailure !== undefined && <span>{issueLabel(t, observed.lastFailure.code)}</span>}
    </div>
    {work.result !== null && <div>
      <p className={css.groupLabel}>
        {t(checked ? 'work.reportBeforeCheck' : 'work.report')}{checked && work.status === 'failed' && <> · {t('work.failed')}</>}
      </p>
      <p className={css.result}>{result}</p>
    </div>}
    {work.artifacts !== undefined && work.artifacts.length > 0 && <WorkArtifacts
      workId={work.id} files={work.artifacts} useResource={useResource} t={t} />}
    <div className={css.actions}>
      {work.inspectable && <Button size="sm" variant="outline" disabled={!active} onClick={() => { openSession(work.sessionId) }}>
        {t('work.inspect')}
      </Button>}
      {(work.status === 'queued' || work.status === 'running') &&
        <Button size="sm" variant="outline" disabled={!active || busy} onClick={() => { stop(work.id) }}>{t('work.stop')}</Button>}
      {continuable && <Button size="sm" variant="outline" disabled={!canDraft || busy}
        onClick={() => { continueWork(work) }}>{t('work.continue')}</Button>}
    </div>
    {continuable && hasUncertainty(work) && <p className={css.result}>{t('work.continueCaution')}</p>}
    {observed !== undefined && observed.business.length > 0 && <p className={css.groupLabel}>{t('work.external')}</p>}
    {observed !== undefined && observed.business.length > 0 && <ul className={css.effects} aria-label={t('work.external')}>
      {observed.business.map(effect => <li
        className={css.effect} key={effect.id} data-assistant-operation-id={effect.id} data-business-status={effect.completion}
      >
        <p>{effect.action}</p>
        <div className={css.facts}>
          <span>{t(effectLabel(effect))}</span>
          {effect.unattended && <span>{t('work.unattended')}</span>}
          {effect.receiptId !== undefined && <span>{t('work.receipt', { id: effect.receiptId })}</span>}
        </div>
        {effect.canReconcile && <Button size="sm" variant="outline" disabled={!active || busy || expired}
          onClick={() => { check(work.id, effect.id) }}>{t('work.check')}</Button>}
      </li>)}
    </ul>}
    {observed?.truncated === true && <p className={css.result}>{t('work.moreOperations')}</p>}
  </li>
}

/**
 * Render the compact status dock only in the configured entrance Session.
 * @param props - Session seats and the injected owner status and actions.
 * @returns The entrance dock or no contribution in other Sessions.
 */
export function WorkStatusDock(props: Props) {
  return props.useEntrance(id => id === props.sessionId) ? <EntranceStatus {...props} /> : null
}

function EntranceStatus({
  sessionId, input, useAccess, useGeneration, useResource, useSessionStatus, t, openSession, refresh, stopWork, checkOutcome,
  grantSettings, updateGrant, prepareDraft, formatExpiry,
}: Props) {
  const resource = useResource<'assistant-work'>(WORK_STATUS_ADDRESS)
  const generation = useGeneration(value => value?.id)
  const pendingApproval = useSessionStatus(value => value.get(sessionId)?.pendingInteraction?.kind === 'approval')
  const running = useSessionStatus(value => value.get(sessionId)?.running)
  useEffect(() => { refresh() }, [pendingApproval, running, refresh])
  const canPrompt = useAccess('session/prompt')
  const canUpload = useAccess('fileUploads/upload')
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<'work.stopFailed' | 'work.checkFailed' | 'work.draftFailed'>()
  const action = useRef<AbortController>()
  useEffect(() => () => { action.current?.abort(); action.current = undefined }, [])

  const status = resource.value?.status
  const active = generation !== undefined && resource.status === 'live' && resource.value?.generation === generation
  const stale = !active && (status !== undefined || resource.status === 'failed')
  const authority = status?.authority.kind === 'available' ? status.authority.value : undefined
  const work = status?.work ?? []
  const latest = work[0]
  const approvals = (authority?.pendingApprovals ?? 0) + work.reduce((count, item) => count +
    (item.operations?.kind === 'available' ? item.operations.value.pendingApprovals : 0), 0)
  const uncertain = work.filter(hasUncertainty).length
  const expires = authority === undefined ? undefined : new Date(authority.expiresAt)
  const canDraft = active && canPrompt && !pendingApproval && input.phase === 'plain'
    && input.draft === '' && input.attachmentIds.length === 0

  const stage = (text: string, files?: readonly File[]): void => {
    setActionError(prepareDraft(sessionId, text, files) ? undefined : 'work.draftFailed')
  }

  const run = async (
    perform: (signal: AbortSignal) => Promise<RemoteResult<object>>, failure: NonNullable<typeof actionError>,
  ): Promise<void> => {
    if (!active || action.current !== undefined) return
    const controller = new AbortController()
    action.current = controller
    setBusy(true)
    setActionError(undefined)
    try {
      if (!(await perform(controller.signal)).ok && !controller.signal.aborted) setActionError(failure)
    } catch (_error: unknown) {
      if (!controller.signal.aborted) setActionError(failure)
    } finally {
      if (action.current === controller) {
        action.current = undefined
        setBusy(false)
        refresh()
      }
    }
  }

  return <section className={css.root} aria-label={t('work.title')} data-assistant-work="" data-status-stale={stale}>
    <header className={css.header}>
      <Button className={css.title} size="sm" aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>
        {t('work.title')}
        {expanded ? <IconChevronUpOutlineRegular size={14} aria-hidden="true" /> : <IconChevronDownOutlineRegular size={14} aria-hidden="true" />}
      </Button>
      <div className={css.facts}>
        {stale && <span role="status">{t(status === undefined ? 'work.unavailable' : 'work.stale')}</span>}
        {!stale && status === undefined && <span role="status" aria-label={t('work.loading')}><StateDot state="ongoing" /></span>}
        {latest !== undefined && <span>{t(workLabel(latest))}</span>}
        {(approvals > 0 || pendingApproval) && <span data-assistant-approval="">{t('work.approvalCount', { count: Math.max(approvals, Number(pendingApproval)) })}</span>}
        {(uncertain > 0 || (authority?.unknown ?? 0) > 0) && <span data-assistant-attention="">{t('work.attention', { count: uncertain + (authority?.unknown ?? 0) })}</span>}
        {authority !== undefined && <span data-assistant-budget="">{t('work.budget', {
          remaining: authority.remaining, reserved: authority.reserved, maxOperations: authority.maxOperations,
        })}</span>}
        {authority?.remaining === 0 && <span>{t('work.exhausted')}</span>}
        {authority !== undefined && expires !== undefined && <time dateTime={Number.isNaN(expires.valueOf()) ? undefined : expires.toISOString()}>{t(authority.expired ? 'work.expired' : 'work.expires', { time: formatExpiry(authority.expiresAt) })}</time>}
        {status?.authority.kind === 'unavailable' && <span role="status" title={status.authority.code}>{status.authority.code === 'configuration-evidence-unavailable'
          ? t('work.witnessWaiting') : t('work.authorityUnavailable', { code: status.authority.code })}</span>}
        {authority?.lastFailure !== undefined && <span>{issueLabel(t, authority.lastFailure.code)}</span>}
      </div>
      {status !== undefined && work.length === 0 && canPrompt && canUpload && <Button
        size="sm" variant="outline" disabled={!canDraft || busy} onClick={() => {
          stage(t('sample.prompt', { name: SAMPLE_FILE_NAME }), [new File([SAMPLE_CSV], SAMPLE_FILE_NAME, { type: 'text/csv' })])
        }}>{t('sample.try')}</Button>}
      <GrantSettings active={active} read={signal => grantSettings(sessionId, signal)}
        update={(value, signal) => updateGrant(sessionId, value, signal)} refresh={refresh} t={t} />
      <Button size="sm" disabled={generation === undefined || busy} onClick={refresh}>{t('work.refresh')}</Button>
    </header>
    {actionError !== undefined && <p className={css.notice} role="alert">{t(actionError)}</p>}
    {busy && <p className={css.notice} role="status">{t('work.checking')}</p>}
    {expanded && status !== undefined && (work.length > 0 ? <ul className={css.rows}>
      {work.map(item => <WorkRow key={item.id} work={item} t={t} active={active} busy={busy} expired={authority?.expired !== false}
        canDraft={canDraft} useResource={useResource}
        openSession={openSession} stop={(id) => { void run(signal => stopWork(sessionId, id, signal), 'work.stopFailed') }}
        check={(id, operation) => { void run(signal => checkOutcome(sessionId, id, operation, signal), 'work.checkFailed') }}
        continueWork={(work) => { stage(t(hasUncertainty(work) ? 'work.continueUncertainPrompt' : 'work.continuePrompt', { id: work.id })) }} />)}
    </ul> : <p className={css.notice}>{t('work.empty')}</p>)}
  </section>
}
