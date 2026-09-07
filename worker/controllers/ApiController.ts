import { isTrustedOrigin, type WorkerEnv } from '../auth'
import { OrganizationModel } from '../models/OrganizationModel'
import { ProjectModel } from '../models/ProjectModel'
import { ApiDocsView } from '../views/ApiDocsView'
import { AuthController } from './AuthController'
import { OrganizationController } from './OrganizationController'
import { ProjectController } from './ProjectController'

export class ApiController {
  private env: WorkerEnv
  private context: ExecutionContext
  constructor(env: WorkerEnv, context: ExecutionContext) { this.env = env; this.context = context }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path.replace(/\/+$/, '') === '/api/auth/docs') return ApiDocsView.page(request)
    if (!path.startsWith('/api/auth/') && path !== '/api/projects') return new Response(null, { status: 404 })
    const env = this.env
    const base = URL.parse(env.BETTER_AUTH_URL ?? 'https://builder.fonteslabs.com')
    if (!base || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) || (env.BETTER_AUTH_SECRET?.length ?? 0) < 32) {
      return Response.json({ code: 'AUTH_NOT_CONFIGURED' }, { status: 503 })
    }
    try {
      if (path === '/api/auth/health') {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        await env.APP_DB.prepare('SELECT id FROM user LIMIT 1').first()
        return Response.json({ status: 'ok', runtime: 'cloudflare-worker' }, { headers: { 'cache-control': 'no-store' } })
      }
      if ((path === '/api/auth/sign-in/social' || path === '/api/auth/callback/google') && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
        return Response.json({ code: 'GOOGLE_NOT_CONFIGURED' }, { status: 503 })
      }
      const auth = new AuthController(env, this.context)
      if (path === '/api/auth/openapi.json') return await auth.documentation(request)
      if (path === '/api/projects') return await new ProjectController(new ProjectModel(env.APP_DB), auth).handle(request, isTrustedOrigin(request.headers.get('origin'), env))
      if (path.startsWith('/api/auth/organization-access/')) {
        return await new OrganizationController(new OrganizationModel(env.APP_DB), auth, env.BETTER_AUTH_SECRET).handle(request, isTrustedOrigin(request.headers.get('origin'), env))
      }
      return await auth.handle(request)
    } catch (error) {
      console.error(JSON.stringify({ event: 'api_request_failed', method: request.method, path, error: error instanceof Error ? error.message : String(error) }))
      return Response.json({ message: 'Não foi possível concluir a autenticação.' }, { status: 500 })
    }
  }
}
