import { serveEmailAsset } from './email/assets.ts'
import { ApiController } from './controllers/ApiController'
import { AuthController, type WorkerEnv } from './controllers/AuthController'
import { preflight, withCors } from './cors'
import { oauthCallbackRedirect } from './oauth'

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/email-assets/')) return serveEmailAsset(request, env.EMAIL_TEMPLATES, context)
    const origin = request.headers.get('Origin')
    const trusted = AuthController.isTrustedOrigin(origin, env)
    const result = preflight(request, trusted)
      ?? oauthCallbackRedirect(request, env.BETTER_AUTH_URL ?? 'https://api.fonteslabs.com', env.GOOGLE_REDIRECT_URI)
      ?? await new ApiController(env, context).handle(request)
    const response = withCors(result, origin, trusted)
    // Auth and workspace responses depend on the current user's cookies.
    response.headers.set('Cache-Control', 'private, no-store')
    response.headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
    return response
  },
} satisfies ExportedHandler<WorkerEnv>
