/** Browser navigation and composer guidance for the persistent Assistant Session. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import remote from '@deepseek-ai/dsh-assistant/remote'
import { readArtifactPreview } from './artifact-preview.ts'
import { artifactDefinition, Artifacts } from './Artifacts.tsx'
import { connectionDictionaries } from './connection-locales.ts'
import { Connections, type ConnectionsInjected } from './Connections.tsx'
import { grantDictionaries } from './grant-locales.ts'
import { recordDictionaries } from './record-locales.ts'
import { Records, type RecordsInjected } from './Records.tsx'
import { WorkStatusDock, type WorkStatusInjected } from './WorkStatus.tsx'
import { createStatusSource, WORK_STATUS_ADDRESS } from './status-source.ts'
import { workDictionaries } from './work-locales.ts'

const dictionaries = {
  en: { download: 'Download', open: 'Assistant', retry: 'Couldn’t open Assistant. Select Assistant to retry.', readOnly: 'Open Assistant to send messages.', preset: 'Assistant uses its configured preset.' },
  zh: { download: '下载', open: '助手', retry: '无法打开助手，请选择“助手”重试', readOnly: '打开助手即可发送消息', preset: '助手使用其已配置的预设' },
  ja: { download: 'ダウンロード', open: 'アシスタント', retry: 'アシスタントを開けませんでした。アシスタントを選択して再試行してください。', readOnly: 'メッセージを送信するにはアシスタントを開いてください。', preset: 'アシスタントは設定済みのプリセットを使用します。' },
  de: { download: 'Herunterladen', open: 'Assistent', retry: 'Der Assistent konnte nicht geöffnet werden. Wähle ihn erneut aus.', readOnly: 'Öffne den Assistenten, um Nachrichten zu senden.', preset: 'Der Assistent verwendet seine konfigurierte Voreinstellung.' },
  es: { download: 'Descargar', open: 'Asistente', retry: 'No se pudo abrir el asistente. Selecciónalo para volver a intentarlo.', readOnly: 'Abre el asistente para enviar mensajes.', preset: 'El asistente usa su configuración preestablecida.' },
  fr: { download: 'Télécharger', open: 'Assistant', retry: 'Impossible d’ouvrir l’assistant. Sélectionnez-le pour réessayer.', readOnly: 'Ouvrez l’assistant pour envoyer des messages.', preset: 'L’assistant utilise son préréglage configuré.' },
  pt: { download: 'Baixar', open: 'Assistente', retry: 'Não foi possível abrir o assistente. Selecione-o para tentar de novo.', readOnly: 'Abra o assistente para enviar mensagens.', preset: 'O assistente usa a predefinição configurada.' },
  ru: { download: 'Скачать', open: 'Ассистент', retry: 'Не удалось открыть ассистента. Выберите его, чтобы повторить попытку.', readOnly: 'Откройте ассистента, чтобы отправить сообщение.', preset: 'Ассистент использует настроенный набор параметров.' },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Assistant navigation, failure, and read-only composer labels. */
    assistant: keyof typeof dictionaries.en | keyof typeof workDictionaries.en | keyof typeof grantDictionaries.en
      | keyof typeof connectionDictionaries.en | keyof typeof recordDictionaries.en
  }
}

/** Services required to register the entrance and its Remote contribution. */
export const inject = ['remote', 'locale', 'uiWorkspace']

/**
 * Open the persistent Assistant by default and mark other conversations read-only.
 * @param ctx - Client services and registration lifetime.
 * @returns disposer that withdraws the UI contributions before their Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(remote)
  const ui = ctx.inject([...inject, 'remote.assistant'], (scope) => {
    scope.effect(() => scope.locale.register('assistant', {
      en: { ...dictionaries.en, ...workDictionaries.en, ...grantDictionaries.en, ...connectionDictionaries.en, ...recordDictionaries.en },
      zh: { ...dictionaries.zh, ...workDictionaries.zh, ...grantDictionaries.zh, ...connectionDictionaries.zh, ...recordDictionaries.zh },
      ja: { ...dictionaries.ja, ...workDictionaries.ja, ...grantDictionaries.ja, ...connectionDictionaries.ja, ...recordDictionaries.ja },
      de: { ...dictionaries.de, ...workDictionaries.de, ...grantDictionaries.de, ...connectionDictionaries.de, ...recordDictionaries.de },
      es: { ...dictionaries.es, ...workDictionaries.es, ...grantDictionaries.es, ...connectionDictionaries.es, ...recordDictionaries.es },
      fr: { ...dictionaries.fr, ...workDictionaries.fr, ...grantDictionaries.fr, ...connectionDictionaries.fr, ...recordDictionaries.fr },
      pt: { ...dictionaries.pt, ...workDictionaries.pt, ...grantDictionaries.pt, ...connectionDictionaries.pt, ...recordDictionaries.pt },
      ru: { ...dictionaries.ru, ...workDictionaries.ru, ...grantDictionaries.ru, ...connectionDictionaries.ru, ...recordDictionaries.ru },
    }))
    const t = scope.locale.bind('assistant')
    let entrance: SessionId | undefined
    const entranceListeners = new Set<() => void>()
    const entranceSource: WorkStatusInjected['hooks']['entrance'] = {
      getSnapshot: () => entrance,
      subscribe(listener) {
        entranceListeners.add(listener)
        return () => { entranceListeners.delete(listener) }
      },
    }
    scope.inject(['uiConversation', 'slots'], (view) => {
      view.uiConversation.registerVerbatimAttachmentPolicy(sessionId => sessionId === entrance)
      view.uiConversation.events.register(artifactDefinition)
      view.slots.inject('conversation.chat.node', () => view.slots.register({
        name: 'conversation.chat.node', key: 'assistant-artifacts', locale: 'assistant',
      }, Artifacts))
    })
    const lifetime = new AbortController()
    scope.effect(() => () => { lifetime.abort() })
    let refreshComposer: (() => void) | undefined
    let reading: Promise<SessionId> | undefined
    const readEntrance = (): Promise<SessionId> => {
      if (entrance !== undefined) return Promise.resolve(entrance)
      reading ??= scope.remote.assistant.entrance(lifetime.signal).then((result) => {
        if (!result.ok) throw result.error
        lifetime.signal.throwIfAborted()
        entrance = result.value.sessionId
        for (const listener of entranceListeners) listener()
        refreshComposer?.()
        return entrance
      }).finally(() => { reading = undefined })
      return reading
    }
    scope.inject(['slots', 'resources', 'connection', 'sessions'], (view) => {
      const connection = (view.get('connection') as ConnectionHandle).generation
      const status = createStatusSource({
        connection,
        visibility: document,
        read: async signal => view.remote.assistant.workStatus(await readEntrance(), signal),
      })
      view.effect(() => view.resources.register({
        protocol: 'assistant-work',
        async *open(address, { signal }) {
          if (address === WORK_STATUS_ADDRESS) yield* status.open(signal)
        },
      }))
      view.effect(() => view.resources.register({
        protocol: 'assistant-artifact-text',
        async *open(address, { signal }) { yield await readArtifactPreview(address, signal) },
      }))
      const injected: WorkStatusInjected = {
        hooks: { entrance: entranceSource, generation: connection },
        openSession: (id) => { view.uiWorkspace.openSession(id) },
        refresh: status.refresh,
        stopWork: (...args) => view.remote.assistant.stopWork(...args),
        checkOutcome: (...args) => view.remote.assistant.checkOutcome(...args),
        grantSettings: (...args) => view.remote.assistant.grantSettings(...args),
        updateGrant: (...args) => view.remote.assistant.updateGrant(...args),
        prepareDraft: (id, text, files) => view.sessions.scope(id)?.get('conversation')?.prepareEmptyDraft(text, files) ?? false,
        formatExpiry: (timestamp) => {
          const date = new Date(timestamp)
          const locale = view.locale.getSnapshot().active
          return Number.isNaN(date.valueOf()) ? String(timestamp) : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
        },
      }
      view.slots.inject('conversation.input.status', () => view.slots.register({
        name: 'conversation.input.status', id: 'assistant-work', locale: 'assistant', inject: () => injected,
      }, WorkStatusDock))
    })
    scope.inject(['slots'], (view) => {
      const connections: ConnectionsInjected = {
        read: async signal => view.remote.assistant.connections(await readEntrance(), signal),
        save: async (update, signal) => view.remote.assistant.setConnection(await readEntrance(), update, signal),
      }
      view.slots.inject('plugins.item', () => view.slots.register({
        name: 'plugins.item', id: 'assistant-connections', order: 10, label: () => t('connections.title'), locale: 'assistant',
        inject: () => connections,
      }, Connections))
      const records: RecordsInjected = {
        read: async (after, signal) => view.remote.assistant.records(await readEntrance(), after, signal),
        resolve: async (resolution, signal) => view.remote.assistant.resolveBusiness(await readEntrance(), resolution, signal),
      }
      view.slots.inject('plugins.item', () => view.slots.register({
        name: 'plugins.item', id: 'assistant-records', order: 11, label: () => t('records.title'), locale: 'assistant',
        inject: () => records,
      }, Records))
    })
    const unsupportedPreset = new Error('Assistant entrance uses its configured preset')
    scope.effect(() => scope.uiWorkspace.registerConversationEntrance({
      action: 'assistant/entrance',
      label: () => t('open'),
      async resolve(signal, agentPreset) {
        if (agentPreset !== undefined) throw unsupportedPreset
        const id = await readEntrance()
        signal.throwIfAborted()
        return id
      },
      failureMessage: error => t(error === unsupportedPreset ? 'preset' : 'retry'),
    }))
    scope.inject(['conversation', 'uiSession'], (support) => {
      const blocks = support.conversation.blocks
      const selection = support.uiSession.adapter.current
      support.effect(() => {
        let raised: { id: SessionId; block: ComposerBlock } | undefined
        const clear = (): void => {
          if (raised !== undefined && blocks.storeFor(raised.id).getSnapshot() === raised.block) {
            blocks.set(raised.id, undefined)
          }
          raised = undefined
        }
        refreshComposer = () => {
          const selected = selection.getSnapshot().key as SessionId | undefined
          const id = selected === entrance ? undefined : selected
          const reason = t('readOnly')
          if (raised?.id === id && raised?.block.reason === reason) return
          clear()
          if (id === undefined || blocks.storeFor(id).getSnapshot() !== undefined) return
          const block = { reason }
          blocks.set(id, block)
          raised = { id, block }
        }
        const stopSelection = selection.subscribe(refreshComposer)
        const stopLocale = support.on('locale/change', refreshComposer)
        refreshComposer()
        void readEntrance().catch((_error: unknown) => {
          // A refused lookup keeps the composer blocked until the user retries the entrance.
        })
        return () => {
          stopSelection()
          stopLocale()
          refreshComposer = undefined
          clear()
        }
      }, 'assistant: read-only Session composer')
    })
  })
  try { await ui } catch (error: unknown) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
