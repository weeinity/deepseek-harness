/** English and Chinese copy for configured MCP connector controls. */

/** Copy keys used by the Connectors page and its navigation label. */
export type ConnectorsKey =
  | 'title' | 'intro' | 'search' | 'toggle'
  | 'loading' | 'loadFailed' | 'retry' | 'refresh' | 'empty' | 'noMatches'
  | 'saving' | 'saveFailed' | 'conflict' | 'restartRequired'
  | 'blocked.unsupported-context' | 'blocked.unsupported-target' | 'blocked.higher-precedence' | 'blocked.local-only'
  | 'stdio' | 'http' | 'unknownTransport'
  | 'phase.pending' | 'phase.loading' | 'phase.active' | 'phase.failed'
  | 'phase.unloading' | 'phase.unobserved' | 'phase.disabled'

/** English copy. */
export const en: Record<ConnectorsKey, string> = {
  title: 'Connectors',
  intro: 'Manage the MCP servers configured for this DSH profile. Enabled servers may still be connecting.',
  search: 'Search connectors',
  toggle: 'Enable {name}',
  loading: 'Loading connectors...',
  loadFailed: 'Connectors could not be loaded.',
  retry: 'Retry',
  refresh: 'Refresh connectors',
  empty: 'No MCP connectors are configured for this profile.',
  noMatches: 'No connectors match your search.',
  saving: 'Saving connector settings...',
  saveFailed: 'The connector change could not be completed. Refresh the list and try again.',
  conflict: 'Connector configuration changed elsewhere. Refresh the list before trying again.',
  restartRequired: 'The change was saved but could not be applied. Check the configuration and restart DSH to apply it.',
  'blocked.unsupported-context': 'This Host cannot persist connector changes from Settings.',
  'blocked.unsupported-target': 'This connector must be managed in its configuration file.',
  'blocked.higher-precedence': 'A higher-priority configuration overrides this connector.',
  'blocked.local-only': 'Connector changes require DSH to listen on localhost only.',
  stdio: 'Local process',
  http: 'HTTP',
  unknownTransport: 'MCP',
  'phase.pending': 'Waiting for dependencies',
  'phase.loading': 'Starting',
  'phase.active': 'Enabled',
  'phase.failed': 'Plugin failed',
  'phase.unloading': 'Stopping',
  'phase.unobserved': 'Not running',
  'phase.disabled': 'Disabled',
}

/** Chinese copy. */
export const zh: Record<ConnectorsKey, string> = {
  title: '连接器',
  intro: '管理此 DSH 配置方案中的 MCP 服务器。已启用的服务器仍可能正在连接。',
  search: '搜索连接器',
  toggle: '启用 {name}',
  loading: '正在加载连接器...',
  loadFailed: '无法加载连接器。',
  retry: '重试',
  refresh: '刷新连接器',
  empty: '此配置方案未配置 MCP 连接器。',
  noMatches: '没有匹配的连接器。',
  saving: '正在保存连接器设置...',
  saveFailed: '无法完成连接器更改。请刷新列表后重试。',
  conflict: '连接器配置已在其他位置更改。请刷新列表后重试。',
  restartRequired: '更改已保存，但未能应用。请检查配置并重启 DSH 以应用更改。',
  'blocked.unsupported-context': '此 Host 无法从设置页面持久保存连接器更改。',
  'blocked.unsupported-target': '此连接器必须在其配置文件中管理。',
  'blocked.higher-precedence': '更高优先级的配置覆盖了此连接器。',
  'blocked.local-only': '连接器更改要求 DSH 仅监听本机地址。',
  stdio: '本地进程',
  http: 'HTTP',
  unknownTransport: 'MCP',
  'phase.pending': '正在等待依赖',
  'phase.loading': '正在启动',
  'phase.active': '已启用',
  'phase.failed': '插件启动失败',
  'phase.unloading': '正在停止',
  'phase.unobserved': '未运行',
  'phase.disabled': '已禁用',
}
