import { MAX_INTERVAL_SECONDS, type Period } from './period.ts'
export type Counts = { articles: number; previous_articles: number; sources: number }
export type Facts = {
  version: 1
  scope: 'general'
  period: { from: number; until: number; previous_from: number }
  totals: Counts & { previous_sources: number }
  latest_discovery: number | null
  clustered_articles: number
  highlights: (Counts & { story_id: number; title: string; slug: string | null; description?: string | null })[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const counts = (value: unknown): value is Counts & Record<string, unknown> => record(value) && count(value.articles) && count(value.previous_articles) && count(value.sources) && value.sources <= value.articles

export function validateFacts(value: unknown, now: number, expected?: Period): asserts value is Facts {
  if (!record(value) || value.version !== 1 || value.scope !== 'general' || !record(value.period)
    || !count(value.period.from) || !count(value.period.until) || !count(value.period.previous_from)
    || value.period.until <= value.period.from || value.period.until - value.period.from > MAX_INTERVAL_SECONDS
    || value.period.until - value.period.from !== value.period.from - value.period.previous_from
    || (expected ? value.period.from !== expected.from || value.period.until !== expected.until || value.period.previous_from !== expected.previous_from : Math.abs(value.period.until - now) > 120) || !counts(value.totals) || !record(value.totals)
    || !count(value.totals.previous_sources) || value.totals.previous_sources > value.totals.previous_articles
    || !count(value.clustered_articles) || value.clustered_articles > value.totals.articles
    || !(value.latest_discovery === null || (count(value.latest_discovery) && value.latest_discovery >= value.period.previous_from && value.latest_discovery < value.period.until))
    || !Array.isArray(value.highlights) || value.highlights.length > 3) throw new Error('INVALID_BRIEFING_FACTS')
  const ids = new Set<number>()
  for (const item of value.highlights) {
    if (!record(item) || !counts(item) || !count(item.story_id) || item.story_id === 0 || ids.has(item.story_id)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1000
      || !(item.description === undefined || item.description === null || (typeof item.description === 'string' && item.description.length <= 6000))
      || !(item.slug === null || (typeof item.slug === 'string' && item.slug.length <= 1000))
      || item.sources < 2 || item.articles > value.totals.articles || item.sources > value.totals.sources
      || item.previous_articles > value.totals.previous_articles) throw new Error('INVALID_BRIEFING_HIGHLIGHT')
    ids.add(item.story_id)
  }
  // Normalize order at the boundary; every subsequent stage uses this ranking.
  value.highlights.sort((a, b) => b.sources - a.sources || b.articles - a.articles || a.story_id - b.story_id)
}

export function change(current: number, previous: number) {
  return {
    absolute: current - previous,
    percent: previous === 0 ? null : Math.round((current - previous) / previous * 100),
    direction: current > previous ? 'up' : current < previous ? 'down' : 'flat',
    baseline: previous === 0 ? 'none' : 'available',
  }
}

const number = new Intl.NumberFormat('pt-PT')
const quantity = (n: number, one: string, many: string) => `${number.format(n)} ${n === 1 ? one : many}`

/** Structured evidence and UI notices, without generating a briefing paragraph. */
export function briefingMetadata(facts: Facts, generatedAt: number) {
  const stale = facts.latest_discovery === null || facts.period.until - facts.latest_discovery > 21600
  const notes: { code: string; text: string }[] = []
  if (stale) notes.push({ code: 'COLLECTION_STALE', text: 'Não há recolhas recentes nos dados deste intervalo. A cobertura pode estar incompleta.' })
  if (facts.totals.articles > 0 && facts.highlights.length === 0) notes.push({ code: 'NO_HIGHLIGHTS', text: 'Não há histórias com resumo e cobertura de pelo menos duas fontes no período selecionado.' })
  const highlights = facts.highlights.map(item => ({
    ...item,
    // IDs remain usable when a title or slug changes. Titles are data, never HTML.
    href: `/historias/${item.story_id}`,
    title: item.title.replaceAll('\u2014', ',').trim(),
    change: change(item.articles, item.previous_articles),
    text: `${quantity(item.articles, 'artigo recolhido', 'artigos recolhidos')} em ${quantity(item.sources, 'fonte', 'fontes')}.`,
  }))
  return {
    version: 1,
    scope: facts.scope,
    generated_at: generatedAt,
    period: facts.period,
    timestamp_basis: 'discovered_at',
    heading: 'Resumo do período',
    notes,
    totals: { ...facts.totals, change: change(facts.totals.articles, facts.totals.previous_articles) },
    coverage: { clustered_articles: facts.clustered_articles, latest_discovery: facts.latest_discovery,
      collection_stale: stale },
    ranking: 'sources_desc_articles_desc_story_id_asc',
    highlights,
  }
}

/** Bound decompressed bytes, including responses without Content-Length. */
export async function readJson(response: Response, limit = 65536): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('BRIEFING_SOURCE_UNAVAILABLE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let length = 0
  let body = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); throw new Error('BRIEFING_SOURCE_TOO_LARGE') }
      body += decoder.decode(value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } finally { reader.releaseLock() }
}
