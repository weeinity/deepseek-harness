/** Connector write outcomes displayed outside the Settings dialog. */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** A settled write outcome; sequence distinguishes repeated notices. */
export interface ConnectorNoticeState {
  kind: 'saved' | 'saveFailed' | 'restartRequired'
  sequence: number
}

/** Localized notice and its dismissal action. */
export type ConnectorNoticeProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'settings.connectors'>
  & InjectFace<{
    hooks: { notice: HostObservable<ConnectorNoticeState | null> }
    dismiss: () => void
  }>

/**
 * Render the last write outcome even when Settings has closed.
 * @param props - Framework notice hook, localized copy, and dismissal callback.
 * @returns A transient banner or no notice.
 */
export function ConnectorNotice({ useNotice, dismiss, t }: ConnectorNoticeProps) {
  const notice = useNotice(value => value)
  if (notice === null) return null
  return notice.kind === 'saved'
    ? <Toast key={notice.sequence} text={t('saved')} tone="success" onDone={dismiss} />
    : <Toast key={notice.sequence} text={t(notice.kind)} icon={<IconWarningOutlineRegular />} onDone={dismiss} />
}
