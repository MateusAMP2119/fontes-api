export type Project = {
  id: string
  organizationId: string
  name: string
  createdAt: string
  ownerId: string | null
  visibility: 'private' | 'public'
}

export class ProjectModel {
  private db: D1Database
  constructor(db: D1Database) { this.db = db }

  async visibleTo(userId: string, organizationId: string): Promise<Project[] | null> {
    // A missing membership yields no rows; a member with no projects yields one
    // null project. This preserves the 403/empty-list distinction in one query.
    const { results } = await this.db.prepare(`
      SELECT p.id, p.organizationId, p.name, p.createdAt, p.ownerId, p.visibility FROM (
        SELECT organizationId FROM member WHERE userId = ? AND organizationId = ? LIMIT 1
      ) m LEFT JOIN project p ON p.organizationId = m.organizationId
        AND (p.visibility = 'public' OR p.ownerId = ?)
      ORDER BY p.createdAt, p.id
    `).bind(userId, organizationId, userId).all<Project>()
    return results.length ? results.filter(project => project.id !== null) : null
  }
}
