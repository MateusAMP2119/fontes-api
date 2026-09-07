import { timingSafeEqual } from 'node:crypto'
import type { Auth, WorkerEnv } from './auth'

const WINDOW_MS = 20 * 60 * 1000
const encode = (value: string) => new TextEncoder().encode(value)

export async function accessCode(secret: string, organizationId: string, window: number) {
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encode(`organization-join:${organizationId}:${window}`))
  return String(new DataView(signature).getUint32(0) % 10000).padStart(4, '0')
}

async function attempt(env: WorkerEnv, key: string, window: number, max: number) {
  const row = await env.APP_DB.prepare(`
    INSERT INTO organizationJoinAttempt (key, window, attempts) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN window = excluded.window THEN attempts + 1 ELSE 1 END,
      window = excluded.window
    RETURNING attempts
  `).bind(key, window).first<{ attempts: number }>()
  return !!row && row.attempts <= max
}

export async function organizationAccess(request: Request, env: WorkerEnv, auth: Auth, trusted: boolean): Promise<Response> {
  const path = new URL(request.url).pathname
  const issuing = path === '/api/auth/organization-access/code'
  if (!issuing && path !== '/api/auth/organization-access/join') return new Response(null, { status: 404 })
  if (request.method !== (issuing ? 'GET' : 'POST')) return new Response(null, { status: 405 })
  if (!issuing && !trusted) return new Response(null, { status: 403 })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return new Response(null, { status: 401 })
  if (!session.user.emailVerified) return new Response(null, { status: 403 })
  const window = Math.floor(Date.now() / WINDOW_MS)
  const headers = { 'cache-control': 'no-store' }
  if (issuing) {
    const org = await env.APP_DB.prepare(`
      SELECT o.id, o.name, o.slug FROM organization o JOIN member m ON m.organizationId = o.id
      WHERE o.id = ? AND m.userId = ? AND m.role IN ('owner', 'admin')
    `).bind(session.session.activeOrganizationId ?? '', session.user.id).first<{ id: string; name: string; slug: string }>()
    if (!org) return Response.json({ message: 'Só os proprietários e administradores podem consultar o código.' }, { status: 403, headers })
    return Response.json({ ...org, code: await accessCode(env.BETTER_AUTH_SECRET, org.id, window), expiresAt: (window + 1) * WINDOW_MS }, { headers })
  }
  // Count every attempt, including malformed bodies and unknown organizations.
  const userAllowed = await attempt(env, `user:${session.user.id}`, window, 5)
  const ip = request.headers.get('cf-connecting-ip')
  const ipAllowed = ip ? await attempt(env, `ip:${ip}`, window, 20) : true
  const limited = () => Response.json({ message: 'Demasiadas tentativas. Tenta novamente quando o código mudar.' }, {
    status: 429, headers: { ...headers, 'retry-after': String(Math.ceil(((window + 1) * WINDOW_MS - Date.now()) / 1000)) },
  })
  if (!userAllowed || !ipAllowed) return limited()
  const body = await request.json().catch(() => null) as { name?: unknown; code?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const code = typeof body?.code === 'string' ? body.code : ''
  const invalid = () => Response.json({ message: 'Organização ou código inválido. Confirma o identificador com um administrador.' }, { status: 400, headers })
  if (!name || name.length > 160 || !/^\d{4}$/.test(code)) return invalid()
  // A slug is unambiguous. A display name is accepted only if it resolves to one organization.
  const { results } = await env.APP_DB.prepare('SELECT id FROM organization WHERE slug = ? OR name = ? LIMIT 2')
    .bind(name, name).all<{ id: string }>()
  if (results.length !== 1) return invalid()
  const organizationId = results[0].id
  if (!await attempt(env, `org:${organizationId}`, window, 20)) return limited()
  const expected = await accessCode(env.BETTER_AUTH_SECRET, organizationId, window)
  if (!timingSafeEqual(encode(code), encode(expected))) return invalid()
  // SQLite serializes this statement: retries cannot add duplicate memberships or elevate a role.
  await env.APP_DB.prepare(`
    INSERT INTO member (id, organizationId, userId, role, createdAt)
    SELECT ?, ?, ?, 'member', ?
    WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)
  `).bind(crypto.randomUUID(), organizationId, session.user.id, Date.now(), organizationId, session.user.id).run()
  return Response.json({ organizationId }, { headers })
}
