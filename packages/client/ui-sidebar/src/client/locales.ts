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
} satisfies Record<SidebarKey, string>
