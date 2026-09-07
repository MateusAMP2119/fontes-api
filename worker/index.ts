import application, { type WorkerEnv } from './auth'
import { apiDocs } from './api-docs'

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const docs = apiDocs(request)
    if (docs) return docs
    const path = new URL(request.url).pathname
    if (!path.startsWith('/api/auth/') && path !== '/api/projects') return new Response(null, { status: 404 })
    const base = new URL(env.BETTER_AUTH_URL ?? 'https://builder.fonteslabs.com')
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) || (env.BETTER_AUTH_SECRET?.length ?? 0) < 32) {
      return Response.json({ code: 'AUTH_NOT_CONFIGURED' }, { status: 503 })
    }
    if (path === '/api/auth/health') {
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      await env.APP_DB.prepare('SELECT id FROM user LIMIT 1').first()
      return Response.json({ status: 'ok', runtime: 'cloudflare-worker' }, { headers: { 'cache-control': 'no-store' } })
    }
    if ((path === '/api/auth/sign-in/social' || path === '/api/auth/callback/google') && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
      return Response.json({ code: 'GOOGLE_NOT_CONFIGURED' }, { status: 503 })
    }
    return application.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<WorkerEnv>
