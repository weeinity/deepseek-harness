import { defineStore } from '@deepseek-ai/dsh-client-store'

import { ASSISTANT_TABS, type AssistantTab } from '../config.ts'
export { ASSISTANT_TABS, type AssistantTab } from '../config.ts'

/** Pick a supported assistant section, falling back to Timeline for invalid config. */
export function assistantTabOrDefault(value: string | undefined): AssistantTab {
  return ASSISTANT_TABS.includes(value as AssistantTab) ? value as AssistantTab : 'timeline'
}

/** Root-scoped assistant panel state shared by its panel and sidebar toggle. */
export interface AssistantPanelState {
  /** Whether the assistant panel should be visible when the Conversation is selected. */
  expanded: boolean
  /** Section retained while the panel is hidden. */
  tab: AssistantTab
}

/** Create the shared root store used by the panel and its reopen control. */
export function createAssistantPanelStore(defaultTab: AssistantTab = 'timeline') {
  return defineStore({
    init: (): AssistantPanelState => ({ expanded: true, tab: defaultTab }),
    actions: {
      open: draft => { draft.expanded = true },
      close: draft => { draft.expanded = false },
      toggle: draft => { draft.expanded = !draft.expanded },
      selectTab: (draft, tab: AssistantTab) => { draft.tab = tab },
    },
  })
}

/** Store handle type for the personal-assistant panel. */
export type AssistantPanelStore = ReturnType<typeof createAssistantPanelStore>
