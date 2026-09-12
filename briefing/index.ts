import { readJson, validateFacts } from './facts.ts'
import { BriefingStore } from './store.ts'
import { parsePeriod } from './period.ts'
import { MODEL, PROMPT_VERSION, modelRequest, composeModel, usageOf } from './llm.ts'

export default {
  async fetch(request: Request, env: Pick<AuthBindings, 'BRIEFING_DB' | 'AI' | 'NEWS_API_URL' | 'CF_VERSION_METADATA'>): Promise<Response> {
    const url = new URL(request.url)
    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      return Response.json({ service: 'fontes-api', status: 'ok', version: env.CF_VERSION_METADATA.id }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (url.pathname !== '/generate') return new Response(null, { status: 404 })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    let period
    try {
      if (url.search) throw new Error('INVALID_BRIEFING_INTERVAL')
      // Apply the byte limit while streaming, even when Content-Length is absent.
      const input = await readJson(new Response(request.body), 1024)
      period = parsePeriod(input, Math.floor(Date.now() / 1000))
    } catch {
      return Response.json({ code: 'INVALID_BRIEFING_INTERVAL', message: 'from and until must be ISO 8601 timestamps with a timezone, at whole-second precision. The interval must be positive, at most 31 days, and end no later than now.' }, { status: 400 })
    }
    // Internal generator: BriefingController validates the bearer session before dispatch.
    const store = new BriefingStore(env.BRIEFING_DB, period)
    const now = () => Math.floor(Date.now() / 1000)
    const token = crypto.randomUUID()
    let raw: unknown = null
    let sourceStatus: number | null = null
    let errorCode = 'BRIEFING_SOURCE_UNAVAILABLE'
    try {
      const prior = await store.latest()
      if (prior) {
        const briefing: ReturnType<typeof composeModel> = JSON.parse(prior.payload)
        // Hide the retired notice without rewriting stored evidence or regenerating text.
        if (Array.isArray(briefing.notes)) briefing.notes = briefing.notes.filter(note => note.code !== 'PARTIAL_CLUSTERING')
        return Response.json({ briefing, cached: true }, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (!await store.claim(token, now())) return Response.json({ code: 'BRIEFING_BUSY' }, { status: 409, headers: { 'Retry-After': '5' } })
      const url = new URL('/briefing-facts', env.NEWS_API_URL)
      url.searchParams.set('from', String(period.from))
      url.searchParams.set('until', String(period.until))
      if (url.protocol !== 'https:') throw new Error('INVALID_BRIEFING_SOURCE')
      const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual', headers: { Accept: 'application/json' } })
      sourceStatus = response.status
      const facts = await readJson(response)
      validateFacts(facts, now(), period)
      const input = modelRequest(facts)
      await store.begin(token, now(), MODEL, PROMPT_VERSION, JSON.stringify(facts), JSON.stringify(input))
      errorCode = 'BRIEFING_MODEL_UNAVAILABLE'
      const aiResponse = await env.AI.run(MODEL, input, { returnRawResponse: true, signal: AbortSignal.timeout(60000) })
      raw = await readJson(aiResponse)
      errorCode = 'BRIEFING_INVALID_MODEL_OUTPUT'
      const briefing = composeModel(facts, raw, now(), token)
      errorCode = 'BRIEFING_STORAGE_FAILED'
      if (!await store.complete(token, JSON.stringify(briefing), JSON.stringify(raw), usageOf(raw), briefing.generated_at)) throw new Error('BRIEFING_LEASE_EXPIRED')
      console.log(JSON.stringify({ event: 'briefing_generated', generation_id: token, model: MODEL, scope: 'general', articles: facts.totals.articles, ...usageOf(raw) }))
      return Response.json({ briefing, cached: false }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      await store.fail(token, now(), errorCode, raw === null ? null : JSON.stringify(raw), usageOf(raw))
        .catch(() => console.error(JSON.stringify({ event: 'briefing_audit_failed', generation_id: token })))
      console.error(JSON.stringify({ event: 'briefing_generation_failed', generation_id: token, code: errorCode, source_status: sourceStatus, cause: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }))
      return Response.json({ code: 'BRIEFING_GENERATION_FAILED' }, { status: 502 })
    } finally {
      await store.release(token).catch(() => { console.error(JSON.stringify({ event: 'briefing_lease_release_failed' })) })
    }
  },
} satisfies ExportedHandler<Pick<AuthBindings, 'BRIEFING_DB' | 'AI' | 'NEWS_API_URL' | 'CF_VERSION_METADATA'>>
