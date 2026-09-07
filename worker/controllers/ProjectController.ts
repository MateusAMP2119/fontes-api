import type { AuthController } from './AuthController'
import type { ProjectModel } from '../models/ProjectModel'

export class ProjectController {
  private model: ProjectModel
  private auth: AuthController
  constructor(model: ProjectModel, auth: AuthController) { this.model = model; this.auth = auth }

  async handle(request: Request, trusted: boolean): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405 })
    if (request.method === 'POST' && !trusted) return new Response(null, { status: 403 })
    const session = await this.auth.session(request)
    if (!session) return new Response(null, { status: 401 })
    const organizationId = session.session.activeOrganizationId
    if (!organizationId) return Response.json({ message: 'Seleciona uma organização.' }, { status: 409 })
    if (request.method === 'GET') {
      const projects = await this.model.visibleTo(session.user.id, organizationId)
      return projects === null ? new Response(null, { status: 403 })
        : Response.json(projects, { headers: { 'cache-control': 'no-store' } })
    }
    if (!await this.model.isMember(session.user.id, organizationId)) return new Response(null, { status: 403 })
    const body = await request.json().catch(() => null) as { name?: unknown; visibility?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 80) return Response.json({ message: 'Nome inválido.' }, { status: 400 })
    const visibility = body?.visibility ?? 'private'
    if (visibility !== 'private' && visibility !== 'public') return Response.json({ message: 'Visibilidade inválida.' }, { status: 400 })
    return Response.json(await this.model.create(session.user.id, organizationId, name, visibility), { status: 201 })
  }
}
