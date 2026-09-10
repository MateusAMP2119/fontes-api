export class OrganizationModel {
  private db: D1Database
  constructor(db: D1Database) { this.db = db }

  resumeFor(userId: string) {
    // A saved selection is usable only while the account remains a member.
    return this.db.prepare(`SELECT m.organizationId FROM member m
      LEFT JOIN onboarding o ON o.userId = m.userId
      WHERE m.userId = ?
      ORDER BY (m.organizationId = o.organizationId) DESC, m.createdAt, m.organizationId LIMIT 1`)
      .bind(userId).first<{ organizationId: string }>()
  }

  managedBy(userId: string, organizationId: string) {
    return this.db.prepare(`
      SELECT o.id, o.name, o.slug FROM organization o JOIN member m ON m.organizationId = o.id
      WHERE o.id = ? AND m.userId = ? AND m.role IN ('owner', 'admin')
    `).bind(organizationId, userId).first<{ id: string; name: string; slug: string }>()
  }

  async findUnambiguous(name: string) {
    const { results } = await this.db.prepare('SELECT id FROM organization WHERE slug = ? OR name = ? LIMIT 2')
      .bind(name, name).all<{ id: string }>()
    return results.length === 1 ? results[0].id : null
  }

  private attempt(key: string, window: number) {
    return this.db.prepare(`
      INSERT INTO organizationJoinAttempt (key, window, attempts) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        attempts = CASE WHEN window = excluded.window THEN attempts + 1 ELSE 1 END,
        window = excluded.window
      RETURNING attempts
    `).bind(key, window)
  }

  async allowUserAttempt(userId: string, ip: string | null, window: number) {
    const statements = [this.attempt(`user:${userId}`, window)]
    if (ip) statements.push(this.attempt(`ip:${ip}`, window))
    const results = await this.db.batch<{ attempts: number }>(statements)
    return results.every((result, i) => result.results[0]?.attempts <= (i === 0 ? 5 : 20))
  }

  async allowOrganizationAttempt(organizationId: string, window: number) {
    const row = await this.attempt(`org:${organizationId}`, window).first<{ attempts: number }>()
    return !!row && row.attempts <= 20
  }

  async join(userId: string, organizationId: string) {
    // One statement keeps retries idempotent and cannot upgrade an existing role.
    await this.db.prepare(`
      INSERT INTO member (id, organizationId, userId, role, createdAt)
      SELECT ?, ?, ?, 'member', ?
      WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)
    `).bind(crypto.randomUUID(), organizationId, userId, Date.now(), organizationId, userId).run()
  }
}
