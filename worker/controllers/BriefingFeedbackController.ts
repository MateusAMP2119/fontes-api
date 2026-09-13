import type { AuthController, WorkerEnv } from './AuthController'
import { readJson } from '../../briefing/facts.ts'

export class BriefingFeedbackController {
  private env: WorkerEnv
  private auth: Pick<AuthController, 'bearerSession'>
  constructor(env: WorkerEnv, auth: Pick<AuthController, 'bearerSession'>) { this.env = env; this.auth = auth }

  async handle(request: Request): Promise<Response> {
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } })
    const session = await this.auth.bearerSession(request)
    if (!session) return new Response(null, { status: 401 })
    if (!session.user.emailVerified) return new Response(null, { status: 403 })
    const params = new URL(request.url).searchParams
    const id = params.get('generation_id')
    if (!id || !/^[a-zA-Z0-9-]{1,100}$/.test(id) || [...params.keys()].length !== 1) {
      return Response.json({ code: 'INVALID_BRIEFING_ID' }, { status: 400 })
    }
    const db = this.env.BRIEFING_DB
    if (!db) return Response.json({ code: 'BRIEFING_NOT_CONFIGURED' }, { status: 503 })
    let rating: 'up' | 'down' | null = null
    if (request.method === 'POST') {
      try {
        const body = await readJson(new Response(request.body), 1024) as { rating?: unknown }
        if (!body || (body.rating !== 'up' && body.rating !== 'down' && body.rating !== null)) throw new Error('INVALID_RATING')
        rating = body.rating
      } catch { return Response.json({ code: 'INVALID_RATING' }, { status: 400 }) }
    }
    try {
      const generation = await db.prepare("SELECT id FROM briefing_generations WHERE id = ? AND status = 'succeeded'").bind(id).first()
      if (!generation) return Response.json({ code: 'BRIEFING_NOT_FOUND' }, { status: 404 })
      if (request.method === 'POST') {
        if (rating === null) {
          await db.prepare('DELETE FROM briefing_feedback WHERE generation_id = ? AND user_id = ?').bind(id, session.user.id).run()
        } else {
          await db.prepare(`INSERT INTO briefing_feedback (generation_id, user_id, rating, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(generation_id, user_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`)
            .bind(id, session.user.id, rating, Math.floor(Date.now() / 1000)).run()
        }
      } else {
        const saved = await db.prepare('SELECT rating FROM briefing_feedback WHERE generation_id = ? AND user_id = ?')
          .bind(id, session.user.id).first<{ rating: 'up' | 'down' }>()
        rating = saved?.rating ?? null
      }
      return Response.json({ rating }, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch {
      return Response.json({ code: 'BRIEFING_FEEDBACK_UNAVAILABLE' }, { status: 503 })
    }
  }
}
