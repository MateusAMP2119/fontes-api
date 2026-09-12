import briefing from '../../briefing/index.ts'
import { OnboardingController } from './OnboardingController'
import { BriefingController } from './BriefingController'
import { AuthController, type WorkerEnv } from './AuthController'

export class ApiController {
  private env: WorkerEnv
  private context: ExecutionContext
  constructor(env: WorkerEnv, context: ExecutionContext) { this.env = env; this.context = context }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (!AuthController.publicMethod(path) && !path.startsWith('/api/onboarding') && path !== '/api/briefing' && path !== '/api/briefing/generate') return new Response(null, { status: 404 })
    if (path === '/api/briefing/generate') {
      const url = new URL(request.url); url.pathname = '/generate'
      return briefing.fetch(new Request(url, request), this.env)
    }
    const env = this.env
    const base = URL.parse(env.BETTER_AUTH_URL ?? 'https://api.fonteslabs.com')
    if (!base || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) || (env.BETTER_AUTH_SECRET?.length ?? 0) < 32) {
      return Response.json({ code: 'AUTH_NOT_CONFIGURED' }, { status: 503 })
    }
    try {
      if ((path === '/api/auth/sign-in/social' || path === '/api/auth/callback/google') && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
        return Response.json({ code: 'GOOGLE_NOT_CONFIGURED' }, { status: 503 })
      }
      const auth = new AuthController(env, this.context)
      if (path.startsWith('/api/briefing')) return await new BriefingController(env, auth).handle(request)
      if (path.startsWith('/api/onboarding')) return await new OnboardingController(env, auth).handle(request)
      return await auth.handle(request)
    } catch (error) {
      console.error(JSON.stringify({ event: 'api_request_failed', method: request.method, path, error: error instanceof Error ? error.message : String(error) }))
      return Response.json({ message: 'Não foi possível concluir a autenticação.' }, { status: 500 })
    }
  }
}
