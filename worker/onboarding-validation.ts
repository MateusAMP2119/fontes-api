export const USERNAME_PATTERN = '[a-z0-9_]{3,30}'
export function validUsername(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_]{3,30}$/.test(value)
}
