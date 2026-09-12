import { AuthController, type WorkerEnv } from './AuthController'
import { ProjectModel } from '../models/ProjectModel'
import { sendTransactionalEmail, INVITE_SECONDS } from '../email/send'

const tokenPattern = /^[a-f0-9]{64}$/
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export async function tokenHash(token: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('')
}
export function validSetup(body: Record<string, unknown>) {
  return typeof body.operationId === 'string' && /^[\w-]{10,80}$/.test(body.operationId)
    && Number.isSafeInteger(body.revision) && Number(body.revision) > 0
    && typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80
    && typeof body.slug === 'string' && /^[a-z0-9][a-z0-9-]{2,47}$/.test(body.slug)
    && typeof body.profileName === 'string' && body.profileName.trim().length > 0 && body.profileName.length <= 80
    && typeof body.completed === 'boolean' && typeof body.changelog === 'boolean' && typeof body.daily === 'boolean'
}
type State = { organizationId: string; revision: number; operationId: string; completed: number; changelog: number; daily: number }

export class OnboardingController {
  private env: WorkerEnv
  private auth: AuthController
  constructor(env: WorkerEnv, auth: AuthController) { this.env = env; this.auth = auth }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (!['/api/onboarding', '/api/onboarding/invite', '/api/onboarding/join'].includes(path)) return new Response(null, { status: 404 })
    if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 })
    if (request.method === 'POST' && !AuthController.isTrustedOrigin(request.headers.get('origin'), this.env)) return new Response(null, { status: 403 })
    const session = await this.auth.session(request)
    if (!session?.user.emailVerified) return Response.json({ message: 'Confirmação de email necessária.' }, { status: 401 })
    const userId = session.user.id
    const db = this.env.APP_DB
    if (request.method === 'GET') {
      if (path !== '/api/onboarding') return new Response(null, { status: 405 })
      return Response.json(await this.bootstrap(userId, session.session.activeOrganizationId))
    }
    let body: Record<string, unknown>
    try {
      const raw = await request.text()
      if (raw.length > 40000) return new Response(null, { status: 413 })
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body')
      body = parsed as Record<string, unknown>
    } catch { return Response.json({ message: 'Pedido inválido.' }, { status: 400 }) }
    if (path === '/api/onboarding/join') {
      if (typeof body.token !== 'string' || !tokenPattern.test(body.token)) return new Response(null, { status: 400 })
      const hash = await tokenHash(body.token)
      const invite = await db.prepare("SELECT i.organizationId, o.name FROM onboardingInvite i JOIN organization o ON o.id = i.organizationId WHERE i.tokenHash = ? AND i.expiresAt > ? AND (i.email IS NULL OR i.email = ?) AND EXISTS (SELECT 1 FROM member m WHERE m.organizationId = i.organizationId AND m.userId = i.creatorId AND m.role IN ('owner', 'admin'))")
        .bind(hash, Date.now(), session.user.email.toLowerCase()).first<{ organizationId: string; name: string }>()
      if (!invite) return Response.json({ message: 'O convite expirou ou pertence a outro email.' }, { status: 403 })
      const credentials = await this.credentials(userId)
      if (credentials.passwordRequired) return Response.json({ message: 'Palavra-passe por definir.', step: 'password' }, { status: 400 })
      await db.batch([
        db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) SELECT ?, ?, ?, 'member', ? WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`)
          .bind(`invite_${invite.organizationId}_${userId}`, invite.organizationId, userId, Date.now(), invite.organizationId, userId),
        // Persist selection even when an existing account needs no further setup.
        // Changing workspace invalidates queued snapshots; retrying the same join does not.
        db.prepare(`INSERT INTO onboarding (userId, organizationId, operationId) VALUES (?, ?, ?)
          ON CONFLICT(userId) DO UPDATE SET organizationId = excluded.organizationId,
            revision = onboarding.revision + 1, operationId = excluded.operationId
          WHERE onboarding.organizationId != excluded.organizationId`)
          .bind(userId, invite.organizationId, crypto.randomUUID()),
        db.prepare('UPDATE session SET activeOrganizationId = ? WHERE id = ? AND userId = ?').bind(invite.organizationId, session.session.id, userId),
      ])
      return Response.json(await this.bootstrap(userId, invite.organizationId))
    }
    if (path === '/api/onboarding/invite') {
      if (typeof body.token !== 'string' || !tokenPattern.test(body.token) || typeof body.organizationId !== 'string'
        || (body.email !== null && (typeof body.email !== 'string' || body.email.length > 254 || !emailPattern.test(body.email)))) return new Response(null, { status: 400 })
      const member = await db.prepare("SELECT id FROM member WHERE userId = ? AND organizationId = ? AND role IN ('owner', 'admin')").bind(userId, body.organizationId).first()
      if (!member) return new Response(null, { status: 403 })
      const hash = await tokenHash(body.token)
      const email = typeof body.email === 'string' ? body.email.toLowerCase() : null
      const count = await db.prepare('SELECT COUNT(*) AS n FROM onboardingInvite WHERE creatorId = ? AND expiresAt > ?').bind(userId, Date.now()).first<{ n: number }>()
      const existing = await db.prepare('SELECT creatorId, organizationId, email, expiresAt FROM onboardingInvite WHERE tokenHash = ?').bind(hash).first<{ creatorId: string; organizationId: string; email: string | null; expiresAt: number }>()
      if (existing && (existing.creatorId !== userId || existing.organizationId !== body.organizationId || existing.email !== email)) return new Response(null, { status: 409 })
      if (existing && existing.expiresAt <= Date.now()) return Response.json({ message: 'O link de convite expirou. É necessário criar um novo link.' }, { status: 410 })
      if (!existing && (count?.n ?? 0) >= 50) return Response.json({ message: 'Limite de convites atingido.' }, { status: 429 })
      await db.prepare('INSERT OR IGNORE INTO onboardingInvite (tokenHash, organizationId, creatorId, email, expiresAt) VALUES (?, ?, ?, ?, ?)')
        .bind(hash, body.organizationId, userId, email, Date.now() + INVITE_SECONDS * 1000).run()
      if (email) {
        const claimed = await db.prepare('UPDATE onboardingInvite SET leaseUntil = ? WHERE tokenHash = ? AND sentAt IS NULL AND leaseUntil < ? RETURNING tokenHash').bind(Date.now() + 60000, hash, Date.now()).first()
        if (claimed) {
          try {
            await sendTransactionalEmail(this.env, email, { kind: 'invite', url: `https://app.fonteslabs.com/?invite=${body.token}` })
            await db.prepare('UPDATE onboardingInvite SET sentAt = ?, leaseUntil = 0 WHERE tokenHash = ?').bind(Date.now(), hash).run()
          } catch (error) {
            await db.prepare('UPDATE onboardingInvite SET leaseUntil = 0 WHERE tokenHash = ?').bind(hash).run()
            throw error
          }
        } else {
          const sent = await db.prepare('SELECT sentAt FROM onboardingInvite WHERE tokenHash = ?').bind(hash).first<{ sentAt: number | null }>()
          if (!sent?.sentAt) return Response.json({ message: 'Convite em processamento.' }, { status: 503 })
        }
      }
      return Response.json({ ready: true })
    }
    if (!validSetup(body)) return Response.json({ message: 'Nome, URL ou perfil inválido.', step: 'workspace' }, { status: 400 })
    if (body.profileImage !== undefined && (typeof body.profileImage !== 'string' || body.profileImage.length > 32000 || (body.profileImage !== '' && !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(body.profileImage) && !(URL.canParse(body.profileImage) && new URL(body.profileImage).protocol === 'https:')))) return Response.json({ message: 'Imagem de perfil inválida.', step: 'profile' }, { status: 400 })
    if ((await this.credentials(userId)).passwordRequired) return Response.json({ message: 'Palavra-passe por definir.', step: 'password' }, { status: 400 })
    const previous = await db.prepare('SELECT * FROM onboarding WHERE userId = ?').bind(userId).first<State>()
    if (previous && previous.revision >= Number(body.revision)) {
      if (previous.operationId === body.operationId) return Response.json(await this.bootstrap(userId, previous.organizationId))
      return Response.json({ message: 'A configuração foi alterada noutra janela. É necessário recuperar o estado guardado.', conflict: true }, { status: 409 })
    }
    const existingOrg = await db.prepare('SELECT o.id FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? ORDER BY (o.id = ?) DESC, o.createdAt LIMIT 1').bind(userId, session.session.activeOrganizationId ?? previous?.organizationId ?? '').first<{ id: string }>()
    const orgId = existingOrg?.id ?? previous?.organizationId ?? `onboarding_${userId}`
    if (body.organizationId !== undefined && body.organizationId !== orgId) return Response.json({ message: 'O ambiente ativo foi alterado. Configuração por recuperar.', conflict: true }, { status: 409 })
    if (previous && !await db.prepare('SELECT id FROM member WHERE userId = ? AND organizationId = ?').bind(userId, orgId).first()) return new Response(null, { status: 403 })
    const owned = !existingOrg || !!await db.prepare("SELECT id FROM member WHERE userId = ? AND organizationId = ? AND role IN ('owner', 'admin')").bind(userId, orgId).first()
    const collision = owned && await db.prepare('SELECT id FROM organization WHERE slug = ? AND id != ?').bind(body.slug, orgId).first()
    if (collision) return Response.json({ message: 'Este URL já está em uso. É necessário outro URL.', step: 'workspace' }, { status: 409 })
    // D1 batch is atomic. Every write is conditional on the revision; a delayed
    // request cannot overwrite a newer snapshot. IDs are stable across retries.
    const guard = 'EXISTS (SELECT 1 FROM onboarding WHERE userId = ? AND revision < ?)'
    const now = Date.now()
    const statements = [db.prepare('INSERT OR IGNORE INTO onboarding (userId, organizationId) VALUES (?, ?)').bind(userId, orgId)]
    if (owned) statements.push(
      db.prepare(`INSERT INTO organization (id, name, slug, createdAt) SELECT ?, ?, ?, ? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug`).bind(orgId, body.name, body.slug, now, userId, body.revision),
    )
    if (!existingOrg) statements.push(db.prepare(`INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt) SELECT ?, ?, ?, 'owner', ? WHERE ${guard}`).bind(`owner_${userId}`, orgId, userId, now, userId, body.revision))
    if (body.profileImage !== undefined) statements.push(db.prepare(`UPDATE user SET image = ? WHERE id = ? AND ${guard}`).bind(body.profileImage || null, userId, userId, body.revision))
    statements.push(
      db.prepare(`INSERT OR IGNORE INTO project (id, organizationId, name, createdAt, ownerId, visibility) SELECT ?, ?, 'O meu projeto', ?, ?, 'private' WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM project WHERE organizationId = ? AND (visibility = 'public' OR ownerId = ?))`).bind(`onboarding_project_${orgId}_${userId}`, orgId, new Date(now).toISOString(), userId, userId, body.revision, orgId, userId),
      db.prepare(`UPDATE user SET name = ?, updatedAt = ? WHERE id = ? AND ${guard}`).bind(body.profileName, now, userId, userId, body.revision),
      db.prepare(`UPDATE session SET activeOrganizationId = ? WHERE id = ? AND userId = ? AND ${guard}`).bind(orgId, session.session.id, userId, userId, body.revision),
      db.prepare('UPDATE onboarding SET organizationId = ?, revision = ?, operationId = ?, completed = ?, changelog = ?, daily = ? WHERE userId = ? AND revision < ?').bind(orgId, body.revision, body.operationId, Number(body.completed), Number(body.changelog), Number(body.daily), userId, body.revision),
    )
    try { await db.batch(statements) } catch (error) {
      if (String(error).includes('UNIQUE')) return Response.json({ message: 'Este URL já está em uso. É necessário outro URL.', step: 'workspace' }, { status: 409 })
      throw error
    }
    const saved = await db.prepare('SELECT operationId FROM onboarding WHERE userId = ?').bind(userId).first<{ operationId: string }>()
    if (saved?.operationId !== body.operationId) return Response.json({ message: 'A configuração foi alterada noutra janela.', conflict: true }, { status: 409 })
    return Response.json(await this.bootstrap(userId, orgId))
  }

  private async credentials(userId: string) {
    const password = await this.env.APP_DB.prepare("SELECT id FROM account WHERE userId = ? AND providerId = 'credential' AND password IS NOT NULL AND password != ''").bind(userId).first()
    const google = await this.env.APP_DB.prepare("SELECT id FROM account WHERE userId = ? AND providerId = 'google'").bind(userId).first()
    return { hasPassword: !!password, passwordRequired: !password && !google }
  }

  private async bootstrap(userId: string, activeId?: string | null) {
    const db = this.env.APP_DB
    const state = await db.prepare('SELECT * FROM onboarding WHERE userId = ?').bind(userId).first<State>()
    const organization = await db.prepare('SELECT o.id, o.name, o.slug, m.role FROM organization o JOIN member m ON m.organizationId = o.id WHERE m.userId = ? ORDER BY (o.id = ?) DESC, o.createdAt LIMIT 1')
      .bind(userId, activeId ?? state?.organizationId ?? '').first<{ id: string; name: string; slug: string; role: string }>()
    const projects = organization ? await new ProjectModel(db).visibleTo(userId, organization.id) : []
    const profile = await db.prepare('SELECT name, image FROM user WHERE id = ?').bind(userId).first()
    return { ...await this.credentials(userId), canInvite: !!organization && ['owner', 'admin'].includes(organization.role), canEditWorkspace: !!organization && ['owner', 'admin'].includes(organization.role), accessLost: !!state && !organization, organization, project: projects?.[0] ?? null, profile, revision: state?.revision ?? 0, operationId: state?.operationId,
      completed: state ? !!state.completed : !!organization && !!projects?.length,
      changelog: !!state?.changelog, daily: !!state?.daily }
  }
}
