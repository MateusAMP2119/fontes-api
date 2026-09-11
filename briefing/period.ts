export type Period = { from: number; until: number; previous_from: number }
export const MAX_INTERVAL_SECONDS = 31 * 86400

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('INVALID_BRIEFING_INTERVAL')
  const millis = Date.parse(value)
  const offset = value.endsWith('Z') ? 0 : (Number(value.slice(-5, -3)) * 60 + Number(value.slice(-2))) * (value.at(-6) === '+' ? 1 : -1)
  // Date.parse normalizes invalid calendar dates; reject them instead.
  if (!Number.isFinite(millis) || new Date(millis + offset * 60000).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('INVALID_BRIEFING_INTERVAL')
  return millis / 1000
}

export function parsePeriod(value: unknown, now: number): Period {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some(k => k !== 'from' && k !== 'until')) throw new Error('INVALID_BRIEFING_INTERVAL')
  const input = value as Record<string, unknown>
  const from = timestamp(input.from), until = timestamp(input.until), duration = until - from
  if (duration <= 0 || duration > MAX_INTERVAL_SECONDS || from < duration || until > now) throw new Error('INVALID_BRIEFING_INTERVAL')
  return { from, until, previous_from: from - duration }
}
