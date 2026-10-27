/** Explicit Dashboard-zone deadlines; ambiguous or nonexistent local minutes require correction. */
import { DateTime } from 'luxon'

/** Parse a user-selected minute without falling back to the browser timezone.
 * @param input datetime-local value with minute precision.
 * @param zone Dashboard timezone displayed beside the input.
 * @param now Current instant in milliseconds.
 * @returns A unique future UTC deadline, or a localized correction key.
 */
export function attentionDeadline(input: string, zone: string, now: number):
  { ok: true; until: string } | { ok: false; error: 'invalid' | 'gap' | 'ambiguous' | 'past' } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return { ok: false, error: 'invalid' }
  const value = DateTime.fromISO(input, { zone })
  if (!value.isValid) return { ok: false, error: 'invalid' }
  if (value.toFormat("yyyy-MM-dd'T'HH:mm") !== input) return { ok: false, error: 'gap' }
  if (value.getPossibleOffsets().length !== 1) return { ok: false, error: 'ambiguous' }
  if (value.toMillis() <= now) return { ok: false, error: 'past' }
  return { ok: true, until: value.toUTC().toISO()! }
}
