/** Localized controls for owner-managed usage limits. */
const en = {
  'grant.title': 'Usage settings',
  'grant.description': 'Change the shared reservation limit and expiry. Tool and data permissions stay the same.',
  'grant.reserved': '{count} reservations already used; they remain counted.',
  'grant.limit': 'Total reservation limit',
  'grant.expiry': 'Expires at (local time)',
  'grant.effect': 'Saving invalidates pending approvals and unused permits. Running operations and recorded outcomes remain. Continue work explicitly after reviewing its status.',
  'grant.reload': 'Read current settings',
  'grant.save': 'Save limits',
  'grant.waiting': 'Waiting for confirmation…',
  'grant.readFailed': 'Usage settings are unavailable. Check that the authority and its owner connection are running, then read again.',
  'grant.saveFailed': 'The update is unconfirmed or the settings changed. Read current settings before saving again.',
  'grant.saved': 'Limits saved. Work has not been restarted.',
}
type Dictionary = Record<keyof typeof en, string>
const zh: Dictionary = {
  'grant.title': '用量设置', 'grant.description': '修改共享预留额度和有效期。工具和数据权限保持不变',
  'grant.reserved': '已使用 {count} 次预留，仍计入用量', 'grant.limit': '预留总额度', 'grant.expiry': '到期时间（本地时间）',
  'grant.effect': '保存会使待批准请求和未使用的许可失效。运行中的操作与已有结果保留。查看状态后，明确继续任务',
  'grant.reload': '读取当前设置', 'grant.save': '保存额度', 'grant.waiting': '等待确认…',
  'grant.readFailed': '用量设置不可用。检查控制服务及其所有者连接是否运行，再次读取',
  'grant.saveFailed': '无法确认更新，或设置已更改。再次保存前，请读取当前设置', 'grant.saved': '额度已保存，尚未重新启动任务',
}
const ja: Dictionary = {
  'grant.title': '利用設定', 'grant.description': '共有の実行枠と期限を変更します。ツール・データへの権限は変わりません。',
  'grant.reserved': '使用済みの {count} 回は引き続き計上されます。', 'grant.limit': '実行枠の総上限', 'grant.expiry': '有効期限（ローカル時刻）',
  'grant.effect': '保存すると承認待ちの要求と未使用の実行許可は失効します。実行中の操作と記録済みの結果は保持されます。状況を確認し、明示的に作業を続けてください。',
  'grant.reload': '現在の設定を読み込む', 'grant.save': '上限と期限を保存', 'grant.waiting': '確認を待っています…',
  'grant.readFailed': '利用設定を取得できません。制御部と利用者用の接続を確認し、再度読み込んでください。',
  'grant.saveFailed': '更新を確認できないか、設定が変更されています。再度保存する前に現在の設定を読み込んでください。', 'grant.saved': '保存しました。作業は再開していません。',
}
const de: Dictionary = {
  'grant.title': 'Nutzungseinstellungen', 'grant.description': 'Gemeinsames Reservierungslimit und Ablauf ändern. Werkzeug- und Datenrechte bleiben gleich.',
  'grant.reserved': '{count} Reservierungen sind bereits verbraucht und bleiben gezählt.', 'grant.limit': 'Gesamtes Reservierungslimit', 'grant.expiry': 'Ablauf (Ortszeit)',
  'grant.effect': 'Speichern macht ausstehende Genehmigungen und ungenutzte Freigaben ungültig. Laufende Vorgänge und Ergebnisse bleiben erhalten. Prüfe den Status vor dem Fortsetzen.',
  'grant.reload': 'Aktuelle Einstellungen lesen', 'grant.save': 'Limits speichern', 'grant.waiting': 'Warte auf Bestätigung…',
  'grant.readFailed': 'Einstellungen nicht verfügbar. Prüfe den Steuerungsdienst und die Eigentümerverbindung und lies erneut.',
  'grant.saveFailed': 'Änderung unbestätigt oder Einstellungen geändert. Lies die aktuellen Einstellungen vor dem erneuten Speichern.', 'grant.saved': 'Limits gespeichert. Arbeit wurde nicht neu gestartet.',
}
const es: Dictionary = {
  'grant.title': 'Ajustes de uso', 'grant.description': 'Cambia el límite compartido de reservas y su vencimiento. Los permisos de herramientas y datos se mantienen.',
  'grant.reserved': 'Ya se han usado {count} reservas y siguen contando.', 'grant.limit': 'Límite total de reservas', 'grant.expiry': 'Vence (hora local)',
  'grant.effect': 'Guardar invalida las aprobaciones pendientes y los permisos sin usar. Conserva las operaciones en curso y los resultados. Revisa el estado antes de continuar.',
  'grant.reload': 'Leer ajustes actuales', 'grant.save': 'Guardar límites', 'grant.waiting': 'Esperando confirmación…',
  'grant.readFailed': 'Ajustes no disponibles. Comprueba el servicio de control y la conexión del propietario antes de volver a leer.',
  'grant.saveFailed': 'Actualización sin confirmar o ajustes modificados. Lee los ajustes actuales antes de guardar de nuevo.', 'grant.saved': 'Límites guardados. El trabajo no se ha reiniciado.',
}
const fr: Dictionary = {
  'grant.title': 'Paramètres d’utilisation', 'grant.description': 'Modifier la limite partagée de réservations et son expiration. Les droits sur les outils et données restent identiques.',
  'grant.reserved': '{count} réservations déjà utilisées restent comptabilisées.', 'grant.limit': 'Limite totale de réservations', 'grant.expiry': 'Expiration (heure locale)',
  'grant.effect': 'L’enregistrement invalide les approbations en attente et les autorisations inutilisées. Les opérations en cours et résultats sont conservés. Vérifiez l’état avant de continuer.',
  'grant.reload': 'Lire les paramètres actuels', 'grant.save': 'Enregistrer les limites', 'grant.waiting': 'En attente de confirmation…',
  'grant.readFailed': 'Paramètres indisponibles. Vérifiez le service de contrôle et la connexion du propriétaire, puis relisez.',
  'grant.saveFailed': 'Mise à jour non confirmée ou paramètres modifiés. Relisez les paramètres actuels avant d’enregistrer à nouveau.', 'grant.saved': 'Limites enregistrées. Le travail n’a pas redémarré.',
}
const pt: Dictionary = {
  'grant.title': 'Configurações de uso', 'grant.description': 'Altere o limite compartilhado de reservas e a validade. As permissões de ferramentas e dados permanecem iguais.',
  'grant.reserved': '{count} reservas já usadas continuam contabilizadas.', 'grant.limit': 'Limite total de reservas', 'grant.expiry': 'Validade (hora local)',
  'grant.effect': 'Salvar invalida aprovações pendentes e permissões não usadas. Operações em andamento e resultados são mantidos. Confira o estado antes de continuar.',
  'grant.reload': 'Ler configurações atuais', 'grant.save': 'Salvar limites', 'grant.waiting': 'Aguardando confirmação…',
  'grant.readFailed': 'Configurações indisponíveis. Confira o serviço de controle e a conexão do proprietário e leia novamente.',
  'grant.saveFailed': 'Atualização não confirmada ou configurações alteradas. Leia os valores atuais antes de salvar novamente.', 'grant.saved': 'Limites salvos. O trabalho não foi reiniciado.',
}
const ru: Dictionary = {
  'grant.title': 'Настройки использования', 'grant.description': 'Измените общий лимит резервирований и срок. Права на инструменты и данные сохраняются.',
  'grant.reserved': 'Уже использовано {count} резервирований; они остаются учтёнными.', 'grant.limit': 'Общий лимит резервирований', 'grant.expiry': 'Срок действия (местное время)',
  'grant.effect': 'Сохранение отменяет ожидающие одобрения и неиспользованные разрешения. Текущие операции и результаты сохраняются. Проверьте состояние перед продолжением.',
  'grant.reload': 'Прочитать текущие настройки', 'grant.save': 'Сохранить лимиты', 'grant.waiting': 'Ожидание подтверждения…',
  'grant.readFailed': 'Настройки недоступны. Проверьте службу управления и соединение владельца, затем прочитайте снова.',
  'grant.saveFailed': 'Обновление не подтверждено или настройки изменились. Прочитайте текущие значения перед повторным сохранением.', 'grant.saved': 'Лимиты сохранены. Работа не перезапущена.',
}

/** Usage settings labels in the supported interface locales. */
export const grantDictionaries = { en, zh, ja, de, es, fr, pt, ru }
