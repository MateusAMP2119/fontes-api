import type { Auth, WorkerEnv } from './auth'

/**
 * Projects of the session's active organization. Lives here rather than in a Pages
 * Function because the project table shares APP_DB with the organization tables and
 * the cookie session is validated by the same Better Auth instance.
 */
export async function projects(request: Request, env: WorkerEnv, auth: Auth, trusted: boolean): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 })
  if (request.method === 'POST' && !trusted) {
    return new Response(null, { status: 403 })
  }
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return new Response(null, { status: 401 })
  const organizationId = session.session.activeOrganizationId
  if (!organizationId) return Response.json({ message: 'Seleciona uma organização.' }, { status: 409 })
  const member = await env.APP_DB.prepare('SELECT 1 FROM member WHERE userId = ? AND organizationId = ?')
    .bind(session.user.id, organizationId)
    .first()
  if (!member) return new Response(null, { status: 403 })
  if (request.method === 'GET') {
    const { results } = await env.APP_DB.prepare(
      "SELECT id, organizationId, name, createdAt, ownerId, visibility FROM project WHERE organizationId = ? AND (visibility = 'public' OR ownerId = ?) ORDER BY createdAt, id",
    ).bind(organizationId, session.user.id).all()
    return Response.json(results, { headers: { 'cache-control': 'no-store' } })
  }
  const body = (await request.json().catch(() => null)) as { name?: unknown; visibility?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 80) return Response.json({ message: 'Nome inválido.' }, { status: 400 })
  const visibility = body?.visibility ?? 'private'
  if (visibility !== 'private' && visibility !== 'public') return Response.json({ message: 'Visibilidade inválida.' }, { status: 400 })
  const project = { ownerId: session.user.id, visibility, id: crypto.randomUUID(), organizationId, name, createdAt: new Date().toISOString() }
  await env.APP_DB.prepare('INSERT INTO project (id, organizationId, name, createdAt, ownerId, visibility) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(project.id, project.organizationId, project.name, project.createdAt, project.ownerId, project.visibility)
    .run()
  return Response.json(project, { status: 201 })
}
