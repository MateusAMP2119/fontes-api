import briefing from '../../briefing/index.ts'
import type { AuthController, WorkerEnv } from './AuthController'
const FRESH_SECONDS = 900

export class BriefingController {
  private env: WorkerEnv
  private auth: Pick<AuthController, 'bearerSession'>
  constructor(env: WorkerEnv, auth: Pick<AuthController, 'bearerSession'>) { this.env = env; this.auth = auth }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const generating = path === '/api/briefing/generate'
    if (path !== '/api/briefing' && !generating) return new Response(null, { status: 404 })
    const method = generating ? 'POST' : 'GET'
    if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } })
    const session = await this.auth.bearerSession(request)
    if (!session) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
    if (!session.user.emailVerified) return new Response(null, { status: 403 })
    if (generating) {
      url.pathname = '/generate'
      return briefing.fetch(new Request(url, request), this.env)
    }
    if (url.search || request.body !== null) return Response.json({ code: 'BRIEFING_PARAMETERS_UNSUPPORTED' }, { status: 400 })
    // Scope is deliberately fixed. A request cannot supply workspace IDs, SQL or source URLs.
    if (!this.env.BRIEFING_DB) return Response.json({ code: 'BRIEFING_NOT_CONFIGURED' }, { status: 503 })
    try {
      const saved = await this.env.BRIEFING_DB.prepare("SELECT payload, generated_at FROM briefing_windows WHERE scope = 'general' AND payload IS NOT NULL ORDER BY generated_at DESC LIMIT 1").first<{ payload: string; generated_at: number }>()
      if (!saved) return Response.json({ code: 'BRIEFING_NOT_GENERATED' }, { status: 404 })
      const briefing = JSON.parse(saved.payload)
      if (Array.isArray(briefing.notes)) briefing.notes = briefing.notes.filter((note: { code: string }) => note.code !== 'PARTIAL_CLUSTERING')
      return Response.json({ briefing, stale: saved.generated_at <= Date.now() / 1000 - FRESH_SECONDS })
    } catch {
      console.error(JSON.stringify({ event: 'briefing_request_failed', method: request.method }))
      return Response.json({ code: 'BRIEFING_UNAVAILABLE' }, { status: 503 })
    }
  }
}
