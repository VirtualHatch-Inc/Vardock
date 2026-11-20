/** Owner-entered credentials for the external actions the operation authority permits. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, SettingsSecretField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { BrokerConnections, BrokerConnectionUpdate } from '../status-types.ts'
import css from './Connections.module.css'

/** Privileged requests supplied by the Assistant client plugin. */
export interface ConnectionsInjected {
  /** Read the permitted actions and their credential state through the owner connection. */
  readonly read: (signal: AbortSignal) => Promise<RemoteResult<BrokerConnections>>
  /** Store one action's token or replace its unattended rules in the authority and return the connections after the change. */
  readonly save: (update: BrokerConnectionUpdate, signal: AbortSignal) => Promise<RemoteResult<BrokerConnections>>
}

interface Props extends ConnectionsInjected, PropsLocale<'assistant'> {
  readonly view: 'summary' | 'page'
}

/** Draft key of the model route's API key; broker action IDs are never empty. */
const MODEL = ''

type Notice = 'connections.readFailed' | 'connections.saveFailed' | 'connections.saved' | 'connections.removed'
  | 'connections.rulesSaved' | 'connections.rulesFailed' | 'connections.ruleInvalid' | 'work.witnessWaiting'

type Rule = BrokerConnections['connections'][number]['unattended'][number]

/** The owner's typed conditions and other allowed fields of one rule not yet saved. */
interface RuleDraft {
  readonly conditions: string
  readonly allow: string
}

const emptyDraft: RuleDraft = { conditions: '', allow: '' }

/**
 * Read the rule an owner typed.
 * @param draft - Conditions: empty, or a JSON object of top-level body fields and their required values. Allowed fields:
 * empty, or up to 64 comma-separated names of other top-level fields the body may contain.
 * @returns The rule, or undefined when either text is invalid.
 */
function ruleOf({ conditions, allow: allowed }: RuleDraft): Rule | undefined {
  const allow = allowed.split(',').map(field => field.trim()).filter(field => field !== '')
  if (allow.length > 64 || allow.some(field => field.length > 256)) return undefined
  if (conditions.trim() === '') return allow.length === 0 ? {} : { allow }
  let match: unknown
  try {
    match = JSON.parse(conditions)
  } catch (_error: unknown) {
    // The owner's text is not JSON; the caller reports it.
    return undefined
  }
  if (typeof match !== 'object' || match === null || Array.isArray(match)) return undefined
  const entries = Object.entries(match).filter((entry): entry is [string, string | number | boolean] =>
    typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean')
  if (entries.length === 0 || entries.length !== Object.keys(match).length) return undefined
  return { match: Object.fromEntries(entries), allow }
}

/**
 * List the model route and permitted external actions; replace one token or one action's unattended rules at a time.
 * @param props - Page view, privileged requests, and localized labels.
 * @returns The one-line summary, or the list with a write-only token field and the rule controls per entry. A failed save is never retried.
 */
export function Connections({ view, read, save, t }: Props) {
  const [settings, setSettings] = useState<BrokerConnections>()
  const connections = settings?.connections
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [ruleDrafts, setRuleDrafts] = useState<Readonly<Record<string, RuleDraft>>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const request = useRef<AbortController>()

  const perform = async (update?: BrokerConnectionUpdate): Promise<void> => {
    if (request.current !== undefined) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setNotice(undefined)
    const failure = update === undefined ? 'connections.readFailed' : 'unattended' in update ? 'connections.rulesFailed' : 'connections.saveFailed'
    try {
      const result = update === undefined ? await read(controller.signal) : await save(update, controller.signal)
      if (controller.signal.aborted) return
      if (!result.ok) {
        setNotice(result.error.code === 'assistant/work-unavailable' && result.error.details.reason === 'configuration-evidence-unavailable'
          ? 'work.witnessWaiting' : failure)
        return
      }
      setSettings(result.value)
      if (update === undefined) return
      if ('unattended' in update) {
        setRuleDrafts(({ [update.action]: _saved, ...rest }) => rest)
        setNotice('connections.rulesSaved')
      } else {
        setDrafts(({ ['action' in update ? update.action : MODEL]: _saved, ...rest }) => rest)
        setNotice(update.value === null ? 'connections.removed' : 'connections.saved')
      }
    } catch (_error: unknown) {
      if (!controller.signal.aborted) setNotice(failure)
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setBusy(false)
      }
    }
  }
  const page = view === 'page'
  const modelDraft = drafts[MODEL] ?? ''
  useEffect(() => {
    if (page) void perform()
    return () => { request.current?.abort(); request.current = undefined }
  // The first read belongs to opening the page; later reads are explicit.
  }, [page])

  if (!page) return t('connections.description')
  const ruleText = ({ match, allow }: Rule) => allow === undefined
    ? <span>{t('connections.unattendedAlways')}</span>
    : <>
      <span>{match === undefined ? t('connections.unattendedFields') : t('connections.unattendedWhen', {
        conditions: Object.entries(match).map(([field, value]) => `${field} = ${JSON.stringify(value)}`).join(', '),
      })}</span> <span>{allow.length === 0 ? t('connections.ruleNoOtherFields')
        : `${t('connections.ruleAllowed', { fields: allow.join(', ') })} ${t('connections.ruleUnchecked')}`}</span>
      {' '}<span>{t('connections.ruleOthersWait')}</span>
    </>
  return <div className={css.root} data-assistant-connections="">
    <p>{t('connections.detail')}</p>
    {connections !== undefined && connections.length > 0 && <p>{t('connections.rulesProfile')}</p>}
    {settings?.model !== undefined && <form className={css.connection} data-assistant-connection-model="" onSubmit={(event) => {
      event.preventDefault()
      if (modelDraft !== '') void perform({ model: true, value: modelDraft })
    }}>
      <h3>{t('connections.model', { provider: settings.model.provider, model: settings.model.model })}</h3>
      <p>{t('connections.modelDetail')}</p>
      <SettingsSecretField id="assistant-connection-model" label={t('connections.token')}
        hint={t('connections.tokenHint', { ref: settings.model.credentialRef })} text={modelDraft} disabled={busy}
        configured={settings.model.configured}
        stateLabel={t(settings.model.configured ? 'connections.configured' : 'connections.missing')}
        onEdit={(text) => { setDrafts(current => ({ ...current, [MODEL]: text })) }} />
      <div className={css.actions}>
        <Button size="sm" type="submit" variant="outline" disabled={busy || modelDraft === ''}>{t('connections.save')}</Button>
        {settings.model.configured && <Button size="sm" type="button" disabled={busy}
          onClick={() => { void perform({ model: true, value: null }) }}>{t('connections.remove')}</Button>}
      </div>
    </form>}
    {connections?.length === 0 && <p>{t('connections.empty')}</p>}
    {settings?.unattendedShell === true && <p>{t('connections.shellUnattended')}</p>}
    {settings?.connections.map(({
      action, description, credentialRef, configured, returnsResponse, unattended, routeChangedSinceRulesSaved,
    }) => {
      const draft = drafts[action] ?? ''
      const ruleDraft = ruleDrafts[action] ?? emptyDraft
      const editRule = (change: Partial<RuleDraft>): void => {
        setRuleDrafts(current => ({ ...current, [action]: { ...current[action] ?? emptyDraft, ...change } }))
      }
      const replaceRules = (rules: readonly Rule[]): void => {
        void perform({ action, unattended: [...rules], revision: settings.revision })
      }
      return <form key={action} className={css.connection} data-assistant-connection={action} onSubmit={(event) => {
        event.preventDefault()
        if (draft !== '') void perform({ action, value: draft })
      }}>
        <h3>{action}</h3>
        {description !== undefined && <p>{description}</p>}
        {routeChangedSinceRulesSaved && <p>{t('connections.rulesRouteChanged')}</p>}
        <ul className={css.rules} aria-label={t('connections.rules')}>
          {unattended.length === 0 && <li>{t('connections.approvalRequired')}</li>}
          {unattended.map((rule, index) => <li key={index}>{ruleText(rule)} <Button size="sm" type="button" disabled={busy}
            onClick={() => { replaceRules(unattended.filter((_rule, other) => other !== index)) }}>{t('connections.ruleRemove')}</Button></li>)}
          {returnsResponse && <li>{t('connections.returnsResponse')}</li>}
        </ul>
        <label className={css.rule}>{t('connections.ruleConditions')}<Input value={ruleDraft.conditions} disabled={busy}
          placeholder={t('connections.ruleConditionsExample')}
          onChange={(event) => { editRule({ conditions: event.target.value }) }} /></label>
        <label className={css.rule}>{t('connections.ruleAllow')}<Input value={ruleDraft.allow} disabled={busy}
          placeholder={t('connections.ruleAllowExample')}
          onChange={(event) => { editRule({ allow: event.target.value }) }} /></label>
        <div className={css.actions}>
          <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => {
            const rule = ruleOf(ruleDraft)
            if (rule === undefined) setNotice('connections.ruleInvalid')
            else replaceRules([...unattended, rule])
          }}>{t('connections.ruleAdd')}</Button>
        </div>
        <SettingsSecretField id={`assistant-connection-${action}`} label={t('connections.token')}
          hint={t('connections.tokenHint', { ref: credentialRef })} text={draft} disabled={busy} configured={configured}
          stateLabel={t(configured ? 'connections.configured' : 'connections.missing')}
          onEdit={(text) => { setDrafts(current => ({ ...current, [action]: text })) }} />
        <div className={css.actions}>
          <Button size="sm" type="submit" variant="outline" disabled={busy || draft === ''}>{t('connections.save')}</Button>
          {configured && <Button size="sm" type="button" disabled={busy}
            onClick={() => { void perform({ action, value: null }) }}>{t('connections.remove')}</Button>}
        </div>
      </form>
    })}
    <div className={css.actions}>
      <Button size="sm" type="button" disabled={busy} onClick={() => { void perform() }}>{t('connections.reload')}</Button>
    </div>
    {busy && <p role="status">{t('connections.waiting')}</p>}
    {notice !== undefined && <p title={notice === 'work.witnessWaiting' ? 'configuration-evidence-unavailable' : undefined}
      role={notice === 'connections.saved' || notice === 'connections.removed' || notice === 'connections.rulesSaved'
        ? 'status' : 'alert'}>{t(notice)}</p>}
  </div>
}
