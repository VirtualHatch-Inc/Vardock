/** Owner questions and attribution for execution and business approvals. */
const en = {
  script: 'Run this shell script in the isolated /workspace?',
  business: 'Send the external request {action}?',
  work: 'Work {id} (principal {principal}) requested it.',
  session: 'Work session {id} requested it.',
  repeat: 'An earlier request to this action, operation {id}, has an unresolved outcome. Approving may repeat its effect.',
}
type Dictionary = Record<keyof typeof en, string>

/** All supported owner locales share the English keys. */
export const approvalDictionaries: Record<'en' | 'zh' | 'ja' | 'de' | 'es' | 'fr' | 'pt' | 'ru', Dictionary> = {
  en,
  zh: {
    script: '在隔离的 /workspace 中运行此 shell 脚本？', business: '发送外部请求 {action}？',
    work: '请求来自工作 {id}（主体 {principal}）。', session: '请求来自工作会话 {id}。',
    repeat: '此操作的较早请求（操作 {id}）结果尚未确认。批准可能会重复其效果。',
  },
  ja: {
    script: '隔離された /workspace でこのシェルスクリプトを実行しますか？', business: '外部リクエスト {action} を送信しますか？',
    work: '作業 {id}（実行主体 {principal}）からのリクエストです。', session: '作業セッション {id} からのリクエストです。',
    repeat: 'この操作への以前のリクエスト（操作 {id}）の結果が未確認です。承認すると効果が重複する可能性があります。',
  },
  de: {
    script: 'Dieses Shell-Skript im isolierten /workspace ausführen?', business: 'Externe Anfrage {action} senden?',
    work: 'Angefordert von Auftrag {id} (Identität {principal}).', session: 'Angefordert von Auftragssitzung {id}.',
    repeat: 'Eine frühere Anfrage an diese Aktion, Vorgang {id}, hat ein ungeklärtes Ergebnis. Eine Freigabe könnte ihre Wirkung wiederholen.',
  },
  es: {
    script: '¿Ejecutar este script de shell en el /workspace aislado?', business: '¿Enviar la solicitud externa {action}?',
    work: 'Lo solicitó la tarea {id} (identidad {principal}).', session: 'Lo solicitó la sesión de trabajo {id}.',
    repeat: 'Una solicitud anterior a esta acción, operación {id}, tiene un resultado sin confirmar. Aprobarla puede repetir su efecto.',
  },
  fr: {
    script: 'Exécuter ce script shell dans le /workspace isolé ?', business: 'Envoyer la requête externe {action} ?',
    work: 'Demandé par la tâche {id} (identité {principal}).', session: 'Demandé par la session de travail {id}.',
    repeat: 'Une requête précédente pour cette action, opération {id}, a un résultat non confirmé. L’approuver peut répéter son effet.',
  },
  pt: {
    script: 'Executar este script de shell no /workspace isolado?', business: 'Enviar a solicitação externa {action}?',
    work: 'Solicitado pela tarefa {id} (identidade {principal}).', session: 'Solicitado pela sessão de trabalho {id}.',
    repeat: 'Uma solicitação anterior para esta ação, operação {id}, tem resultado não confirmado. Aprovar pode repetir seu efeito.',
  },
  ru: {
    script: 'Выполнить этот сценарий оболочки в изолированном /workspace?', business: 'Отправить внешний запрос {action}?',
    work: 'Запрошено задачей {id} (субъект {principal}).', session: 'Запрошено рабочей сессией {id}.',
    repeat: 'Результат предыдущего запроса к этому действию, операция {id}, не подтверждён. Одобрение может повторить его действие.',
  },
}
