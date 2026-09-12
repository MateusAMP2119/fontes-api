export async function defaultUsername(name: string, email: string, exists: (value: string) => Promise<boolean>) {
  const compact = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const base = (compact(name) || compact(email.split('@')[0]) || 'user').padEnd(3, '0').slice(0, 30)
  let candidate = base
  for (let suffix = 2; await exists(candidate); suffix++) {
    const number = String(suffix)
    candidate = base.slice(0, 30 - number.length) + number
  }
  return candidate
}
