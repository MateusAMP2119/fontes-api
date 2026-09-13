import type { AuthController, WorkerEnv } from './AuthController'
import { readJson } from '../../briefing/facts.ts'
import { parseRankingsQuery, validateRankings, type RankingsQuery } from '../rankings.ts'

export class RankingsController {
  private env: Pick<WorkerEnv, 'NEWS_API_URL'>
  private auth: Pick<AuthController, 'bearerSession'>
  constructor(env: Pick<WorkerEnv, 'NEWS_API_URL'>, auth: Pick<AuthController, 'bearerSession'>) { this.env = env; this.auth = auth }

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    const session = await this.auth.bearerSession(request)
    if (!session) return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
    if (!session.user.emailVerified) return new Response(null, { status: 403 })
    let query: RankingsQuery
    try { query = parseRankingsQuery(new URL(request.url).searchParams, Math.floor(Date.now() / 1000)) }
    catch { return Response.json({ code: 'INVALID_RANKINGS_PARAMETERS' }, { status: 400 }) }
    if (!this.env.NEWS_API_URL) return Response.json({ code: 'RANKINGS_NOT_CONFIGURED' }, { status: 503 })
    try {
      const url = new URL('/rankings', this.env.NEWS_API_URL)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
      const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual', headers: { Accept: 'application/json' } })
      const rankings = validateRankings(await readJson(response, 131072), query, Math.floor(Date.now() / 1000))
      return Response.json(rankings, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch {
      console.error(JSON.stringify({ event: 'rankings_source_failed' }))
      return Response.json({ code: 'RANKINGS_UNAVAILABLE' }, { status: 503 })
    }
  }
}
