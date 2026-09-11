import { parsePeriod } from '../src/briefing/period.ts'
import { readJson, validateFacts } from '../src/briefing/facts.ts'

// Read-only release preflight. No deployment, database write or model call.
const url = new URL('/briefing-facts', process.env.NEWS_API_URL ?? 'https://fontes-api.bymarreco.com')
if (url.protocol !== 'https:') throw new Error('Briefing source must use HTTPS')
try {
  const now = Math.floor(Date.now() / 1000)
  const args = process.argv.slice(2)
  if (args.length !== 0 && args.length !== 2) throw new Error('Supply both from and until as ISO 8601 timestamps')
  const period = parsePeriod({ from: args[0] ?? new Date((now - 86400) * 1000).toISOString(), until: args[1] ?? new Date(now * 1000).toISOString() }, now)
  url.searchParams.set('from', String(period.from))
  url.searchParams.set('until', String(period.until))
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}. Release the iris-core /briefing-facts endpoint first.`)
  const facts = await readJson(response)
  validateFacts(facts, now, period)
  console.log(JSON.stringify({ source: url.href, valid: true, articles: facts.totals.articles, sources: facts.totals.sources,
    highlights: facts.highlights.length, summaries: facts.highlights.filter(s => s.description).length, period: facts.period }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Briefing source check failed')
  process.exitCode = 1
}
