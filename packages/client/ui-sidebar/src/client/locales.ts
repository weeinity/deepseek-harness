/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'brand.localBuild': 'MIP Autolabeling',
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
  'extensions.label': '扩展',
  'cat.sleeping': '小猫休息中',
  'cat.working': '小猫工作中',
  'cat.active': '小猫提醒：会话已完成',
  'cat.preview.start': '播放小猫动画',
  'cat.preview.stop': '停止小猫动画预览',
  'cat.previewing': '小猫招手中',
  'panels.more': '更多',
  'version.copied': '版本号复制成功',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'brand.localBuild': 'MIP Autolabeling',
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'extensions.label': 'Extensions',
  'cat.sleeping': 'Cat sleeping',
  'cat.working': 'Cat working',
  'cat.active': 'Cat active: session completed',
  'cat.preview.start': 'Play cat animation',
  'cat.preview.stop': 'Stop cat animation preview',
  'cat.previewing': 'Cat waving',
  'panels.more': 'More',
  'version.copied': 'Version copied',
} satisfies Record<SidebarKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'brand.localBuild': 'MIP Autolabeling',
  'extensions.label': '拡張機能',
  'cat.sleeping': '猫はお休み中',
  'cat.working': '猫は作業中',
  'cat.active': '猫のお知らせ：セッションが完了しました',
  'cat.preview.start': '猫のアニメーションを再生',
  'cat.preview.stop': '猫のアニメーションのプレビューを停止',
  'cat.previewing': '猫が手を振っています',
  'session.new': '新規セッション',
  'session.new.label': '新規セッション',
  'toggle.open': 'サイドバーを開く',
  'toggle.collapse': 'サイドバーを折りたたむ',
  'panels.label': 'グローバルパネル',
  'panels.more': 'その他',
  'version.copied': 'バージョンをコピーしました',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'brand.localBuild': 'MIP Autolabeling',
  'extensions.label': 'Extensiones',
  'cat.sleeping': 'Gato durmiendo',
  'cat.working': 'Gato trabajando',
  'cat.active': 'Aviso del gato: sesión completada',
  'cat.preview.start': 'Reproducir animación del gato',
  'cat.preview.stop': 'Detener vista previa del gato',
  'cat.previewing': 'Gato saludando',
  'session.new': 'Nueva sesión',
  'session.new.label': 'Nueva sesión',
  'toggle.open': 'Abrir barra lateral',
  'toggle.collapse': 'Contraer barra lateral',
  'panels.label': 'Paneles globales',
  'panels.more': 'Más',
  'version.copied': 'Versión copiada',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'brand.localBuild': 'MIP Autolabeling',
  'extensions.label': 'Extensions',
  'cat.sleeping': 'Chat endormi',
  'cat.working': 'Chat au travail',
  'cat.active': 'Avis du chat : séance terminée',
  'cat.preview.start': 'Lire l’animation du chat',
  'cat.preview.stop': 'Arrêter l’aperçu du chat',
  'cat.previewing': 'Le chat fait un signe',
  'session.new': 'Nouvelle séance',
  'session.new.label': 'Nouvelle séance',
  'toggle.open': 'Ouvrir la barre latérale',
  'toggle.collapse': 'Réduire la barre latérale',
  'panels.label': 'Panneaux globaux',
  'panels.more': 'Plus',
  'version.copied': 'Version copiée',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'brand.localBuild': 'MIP Autolabeling',
  'extensions.label': 'Erweiterungen',
  'cat.sleeping': 'Katze schläft',
  'cat.working': 'Katze arbeitet',
  'cat.active': 'Katzenhinweis: Sitzung abgeschlossen',
  'cat.preview.start': 'Katzenanimation abspielen',
  'cat.preview.stop': 'Katzenvorschau stoppen',
  'cat.previewing': 'Katze winkt',
  'session.new': 'Neue Sitzung',
  'session.new.label': 'Neue Sitzung',
  'toggle.open': 'Seitenleiste öffnen',
  'toggle.collapse': 'Seitenleiste einklappen',
  'panels.label': 'Globale Bereiche',
  'panels.more': 'Mehr',
  'version.copied': 'Version kopiert',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'brand.localBuild': 'MIP Autolabeling',
  'extensions.label': 'Расширения',
  'cat.sleeping': 'Кот спит',
  'cat.working': 'Кот работает',
  'cat.active': 'Уведомление кота: сессия завершена',
  'cat.preview.start': 'Воспроизвести анимацию кота',
  'cat.preview.stop': 'Остановить предпросмотр кота',
  'cat.previewing': 'Кот машет лапой',
  'session.new': 'Новая сессия',
  'session.new.label': 'Новая сессия',
  'toggle.open': 'Открыть боковую панель',
  'toggle.collapse': 'Свернуть боковую панель',
  'panels.label': 'Глобальные панели',
  'panels.more': 'Ещё',
  'version.copied': 'Версия скопирована',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'brand.localBuild': 'MIP Autolabeling',
  'extensions.label': 'Extensões',
  'cat.sleeping': 'Gato dormindo',
  'cat.working': 'Gato trabalhando',
  'cat.active': 'Aviso do gato: sessão concluída',
  'cat.preview.start': 'Reproduzir animação do gato',
  'cat.preview.stop': 'Parar prévia do gato',
  'cat.previewing': 'Gato acenando',
  'session.new': 'Nova sessão',
  'session.new.label': 'Nova sessão',
  'toggle.open': 'Abrir barra lateral',
  'toggle.collapse': 'Recolher barra lateral',
  'panels.label': 'Painéis globais',
  'panels.more': 'Mais',
  'version.copied': 'Versão copiada',
} satisfies Record<keyof typeof en, string>
