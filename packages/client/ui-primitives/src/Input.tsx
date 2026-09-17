// Input: single-line text input atom (search boxes, inline forms). Composer
// textareas are NOT this atom — they live with the conversation package.

import type { InputHTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import css from './Input.module.css'

/**
 * Render a text input with an optional leading icon.
 * @param props.icon - optional 16px leading icon node.
 * @param props.variant - `search` uses a spacious, filled capsule; `default` uses a compact bordered field.
 * @param props.className - optional classes for the wrapper.
 * @returns wrapper span containing the native input; input attributes pass through.
 */
export function Input({ icon, variant = 'default', className, ...rest }: {
  icon?: ReactNode
  variant?: 'default' | 'search'
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={clsx(css.wrap, variant === 'search' && css.search, className)}>
      {icon != null && <span className={css.icon}>{icon}</span>}
      <input className={css.input} {...rest} />
    </span>
  )
}
