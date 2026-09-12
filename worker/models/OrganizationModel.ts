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
}
