/** Final answers allow text formatting only; neither model links nor resource URLs become active DOM. */
import { memo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { IconCopyOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DashboardText } from './locale.ts'
import styles from './dsh-dashboard.module.css'

const components: Components = {
  a: ({ children }) => <>{children}</>,
  img: ({ alt }) => <>{alt}</>,
}
const allowedElements = ['p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img']

/** Keep parsing off the streaming path and reuse completed answers across unrelated updates. */
export const FinalAnswer = memo(function FinalAnswer({ text }: { text: string }) {
  return <div className={styles.answerText}>
    <Markdown skipHtml allowedElements={allowedElements} components={components} urlTransform={() => ''}>{text}</Markdown>
  </div>
})

export function AnswerCopy({ text, t }: { text: string; t: DashboardText }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null)
  return <div className={styles.answerActions}>
    {result !== null && <span role={result === 'failed' ? 'alert' : 'status'}>{t(`chat.copy.${result}`)}</span>}
    <button type="button" aria-label={t('chat.copy')} title={t('chat.copy')} onClick={() => {
      void writeClipboard(text).then(success => { setResult(success ? 'copied' : 'failed') }, () => { setResult('failed') })
    }}><span aria-hidden="true"><IconCopyOutlineRegular size={14} /></span></button>
  </div>
}

/** A suggestion edits the current draft; submitting is always a separate user action. */
export function QuestionSuggestions({ questions, enabled, maxChars, fill, t }: {
  questions: readonly string[]; enabled: boolean; maxChars: number; fill: (text: string) => void; t: DashboardText
}) {
  return <div className={styles.suggestions} role="group" aria-label={t('chat.suggestions')}>
    {questions.map(question => <button type="button" key={question} disabled={!enabled || question.length > maxChars}
      onClick={() => { fill(question) }}>{question}</button>)}
  </div>
}
