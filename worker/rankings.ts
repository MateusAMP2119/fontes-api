import { parsePeriod } from '../briefing/period.ts'

export type RankingsQuery = { from: number; until: number; limit: number; sort?: 'growth' | 'volume' }
export type RankingItem = { id: number; name: string; rank: number; count: number; unit: 'articles' | 'events'; previous_count?: number; growth_percent?: number | null; activity?: number[] }
export type MentionItem = RankingItem & { kind: 'person' | 'org' | 'location'; slug: string | null }
export type Rankings = {
  version: 1
  scope: 'general'
  sort?: 'growth' | 'volume'
  period: { from: number; until: number }
  timestamp_basis: 'discovered_at'
  generated_at: number
  latest_discovery: number | null
  totals: { articles: number; events: number }
  writers: RankingItem[]
  categories: RankingItem[]
  mentions: MentionItem[]
}

export function parseRankingsQuery(params: URLSearchParams, now: number): RankingsQuery {
  for (const key of params.keys()) {
    if (!['from', 'until', 'limit', 'sort'].includes(key) || params.getAll(key).length !== 1) throw new Error('INVALID_RANKINGS_PARAMETERS')
  }
  const { from, until } = parsePeriod({ from: params.get('from'), until: params.get('until') }, now)
  const raw = params.get('limit') ?? '10'
  if (!/^[1-9]\d?$/.test(raw) || Number(raw) > 50) throw new Error('INVALID_RANKINGS_PARAMETERS')
  const sort = params.get('sort')
  if (sort !== null && sort !== 'count' && sort !== 'growth' && sort !== 'volume') throw new Error('INVALID_RANKINGS_PARAMETERS')
  return { from, until, limit: Number(raw), ...(sort === 'growth' || sort === 'volume' ? { sort } : {}) }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** Validate and reconstruct the upstream contract. Do not forward unknown fields. */
export function validateRankings(value: unknown, query: RankingsQuery, now: number): Rankings {
  const invalid = (): never => { throw new Error('INVALID_RANKINGS_SOURCE') }
  if (!record(value) || value.version !== 1 || value.scope !== 'general' || value.timestamp_basis !== 'discovered_at'
    || !record(value.period) || value.period.from !== query.from || value.period.until !== query.until
    || !count(value.generated_at) || Math.abs(value.generated_at - now) > 120
    || !record(value.totals) || !count(value.totals.articles) || !count(value.totals.events)
    || !(value.latest_discovery === null || (count(value.latest_discovery) && value.latest_discovery >= query.from && value.latest_discovery < query.until))) return invalid()
  if (query.sort && value.sort !== query.sort) return invalid()
  const articles = value.totals.articles, events = value.totals.events
  if ((articles === 0) !== (value.latest_discovery === null) || (articles === 0 && events !== 0)) return invalid()
  const items = (input: unknown, unit: 'articles' | 'events', total: number): RankingItem[] => {
    if (!Array.isArray(input) || input.length > query.limit) return invalid()
    const ids = new Set<number>()
    let previous: RankingItem | undefined
    return input.map((item: unknown, index) => {
      if (!record(item) || !count(item.id) || item.id === 0 || ids.has(item.id)
        || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 1000
        || item.rank !== index + 1 || !count(item.count) || item.count === 0 || item.count > total || item.unit !== unit) return invalid()
      if (query.sort !== 'growth' && previous && (item.count > previous.count || (item.count === previous.count && item.id <= previous.id))) return invalid()
      ids.add(item.id)
      const result: RankingItem = { id: item.id, name: item.name, rank: index + 1, count: item.count, unit }
      if (query.sort) {
        if (!count(item.previous_count) || !Array.isArray(item.activity) || item.activity.length !== 24
          || !item.activity.every(count) || item.activity.reduce((sum: number, n: number) => sum + n, 0) !== item.count) return invalid()
        const expected = item.previous_count === 0 ? null : (item.count - item.previous_count) * 100 / item.previous_count
        if (expected === null ? item.growth_percent !== null : (typeof item.growth_percent !== 'number' || !Number.isFinite(item.growth_percent) || Math.abs(item.growth_percent - expected) > 0.050001)) return invalid()
        result.previous_count = item.previous_count
        result.growth_percent = item.growth_percent as number | null
        result.activity = [...item.activity]
        if (query.sort === 'growth' && previous) {
          const currentGrowth = result.growth_percent ?? -Infinity, previousGrowth = previous.growth_percent ?? -Infinity
          if (currentGrowth > previousGrowth || (currentGrowth === previousGrowth && (result.count > previous.count || (result.count === previous.count && result.id <= previous.id)))) return invalid()
        }
      }
      previous = result
      return result
    })
  }
  const writers = items(value.writers, 'articles', articles)
  const categories = items(value.categories, 'articles', articles)
  const mentionRows = value.mentions
  const mentions = items(mentionRows, 'events', events).map((item, index): MentionItem => {
    const source: unknown = Array.isArray(mentionRows) ? mentionRows[index] : undefined
    if (!record(source) || (source.kind !== 'person' && source.kind !== 'org' && source.kind !== 'location')
      || !(source.slug === null || (typeof source.slug === 'string' && source.slug.length <= 1000 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(source.slug)))) return invalid()
    return { ...item, kind: source.kind, slug: source.slug }
  })
  return { version: 1, scope: 'general', ...(query.sort ? { sort: query.sort } : {}), period: { from: query.from, until: query.until }, timestamp_basis: 'discovered_at',
    generated_at: value.generated_at, latest_discovery: value.latest_discovery, totals: { articles, events }, writers, categories, mentions }
}
