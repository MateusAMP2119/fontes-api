import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRankingsQuery, validateRankings } from '../worker/rankings.ts'
import { RankingsController } from '../worker/controllers/RankingsController.ts'

const from = 1789084800, until = from + 86400
const now = until + 10
const query = { from, until, limit: 10 }
const params = 'from=2026-09-11T00:00:00Z&until=2026-09-12T00:00:00Z'
const item = (id, count, unit = 'articles') => ({ id, name: 'Name', count, rank: id, unit })
function payload() {
  return { version: 1, scope: 'general', period: { from, until }, timestamp_basis: 'discovered_at', generated_at: now,
    latest_discovery: until - 1, totals: { articles: 5, events: 2 },
    writers: [item(1, 3), item(2, 3)], categories: [item(1, 5)],
    mentions: [{ ...item(1, 2, 'events'), kind: 'person', slug: 'name' }] }
}

test('rankings require an explicit bounded period and bounded limit, with no duplicate or unknown parameters', () => {
  assert.deepEqual(parseRankingsQuery(new URLSearchParams(params), now), query)
  assert.equal(parseRankingsQuery(new URLSearchParams(params + '&limit=50'), now).limit, 50)
  assert.deepEqual(parseRankingsQuery(new URLSearchParams('from=2026-09-11T01:00:00%2B01:00&until=2026-09-12T01:00:00%2B01:00'), now), query)
  for (const input of ['', 'from=2026-09-11T00:00:00Z', params + '&from=2026-09-11T00:00:00Z', params + '&scope=private',
    ...['0', '51', '100', '-1', '1.5', '01', '', 'NaN'].map(limit => params + '&limit=' + limit),
    params + '&limit=1&limit=2', 'from=2026-02-30T00:00:00Z&until=2026-03-01T00:00:00Z',
    'from=2026-08-01T00:00:00Z&until=2026-09-12T00:00:00Z',
    'from=2026-09-12T00:00:00Z&until=2026-09-11T00:00:00Z',
    'from=2026-09-11T00:00:00Z&until=2026-09-13T00:00:00Z']) {
    assert.throws(() => parseRankingsQuery(new URLSearchParams(input), now), undefined, input)
  }
})

test('upstream rankings are bounded, correctly ordered, scoped and reconstructed', () => {
  const input = payload()
  assert.deepEqual(validateRankings(input, query, now), input)
  input.secret = 'not part of contract'; input.writers[0].unknown = true
  const result = validateRankings(input, query, now)
  assert.equal(result.secret, undefined); assert.equal(result.writers[0].unknown, undefined)
  const invalid = [
    p => { p.period.from-- }, p => { p.scope = 'workspace' }, p => { p.timestamp_basis = 'published_at' },
    p => { p.generated_at = now - 121 }, p => { p.latest_discovery = until },
    p => { p.latest_discovery = null }, p => { p.writers[0].id = Number.MAX_SAFE_INTEGER + 1 },
    p => { p.writers[1].id = 1 }, p => { p.writers[1].rank = 1 },
    p => { p.writers[1].count = 4 }, p => { p.writers.reverse(); p.writers.forEach((w, i) => w.rank = i + 1) },
    p => { p.writers[0].count = 6 }, p => { p.writers[0].count = 0 },
    p => { p.mentions[0].unit = 'articles' }, p => { p.mentions[0].kind = 'unknown' },
    p => { p.mentions[0].kind = ['person'] },
    p => { p.mentions[0].slug = 'https://evil.example' }, p => { p.categories = null },
  ]
  for (const change of invalid) { const p = payload(); change(p); assert.throws(() => validateRankings(p, query, now)) }
  assert.throws(() => validateRankings(payload(), { ...query, limit: 1 }, now))
  const empty = { ...payload(), latest_discovery: null, totals: { articles: 0, events: 0 }, writers: [], categories: [], mentions: [] }
  assert.deepEqual(validateRankings(empty, query, now), empty)
})

test('controller rejects unauthorized, unverified and malformed requests before fetching; bounds and validates upstream data', async t => {
  let calls = 0, upstream = () => Response.json({ ...payload(), generated_at: Math.floor(Date.now() / 1000) })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url.origin, 'https://news.example')
    assert.equal(url.pathname, '/rankings')
    assert.deepEqual(Object.fromEntries(url.searchParams), { from: String(from), until: String(until), limit: '10' })
    assert.equal(options.redirect, 'manual')
    assert.deepEqual(options.headers, { Accept: 'application/json' })
    assert.ok(options.signal)
    return upstream()
  })
  const env = { NEWS_API_URL: 'https://news.example' }
  const request = (suffix = params, method = 'GET') => new Request('https://api.fonteslabs.com/api/rankings?' + suffix, { method })
  let session = null
  const controller = new RankingsController(env, { async bearerSession() { return session } })
  assert.equal((await controller.handle(request())).status, 401)
  session = { user: { emailVerified: false } }
  assert.equal((await controller.handle(request())).status, 403)
  session.user.emailVerified = true
  const wrongMethod = await controller.handle(request(params, 'POST'))
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('allow'), 'GET')
  assert.equal((await controller.handle(request(''))).status, 400)
  assert.equal(calls, 0)
  const response = await controller.handle(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal((await response.json()).mentions[0].unit, 'events')
  for (const failure of [() => new Response(null, { status: 429 }), () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    () => new Response('invalid json'), () => new Response('x'.repeat(131073)),
    () => Response.json({ ...payload(), period: { from: 0, until } }),
    () => { throw new DOMException('timed out', 'TimeoutError') }]) {
    upstream = failure
    const failed = await controller.handle(request())
    assert.equal(failed.status, 503)
    assert.deepEqual(await failed.json(), { code: 'RANKINGS_UNAVAILABLE' })
  }
  assert.equal((await new RankingsController({}, { async bearerSession() { return session } }).handle(request())).status, 503)
})

test('growth contract validates prior counts, measured changes, buckets and global order', () => {
  const q = { ...query, sort: 'growth' }
  assert.deepEqual(parseRankingsQuery(new URLSearchParams(params + '&sort=growth'), now), q)
  assert.throws(() => parseRankingsQuery(new URLSearchParams(params + '&sort=unknown'), now))
  const p = { ...payload(), sort: 'growth' }
  for (const key of ['writers', 'categories', 'mentions']) p[key] = p[key].map(item => ({ ...item, previous_count: 1, growth_percent: (item.count - 1) * 100, activity: [item.count, ...Array(23).fill(0)] }))
  assert.deepEqual(validateRankings(p, q, now), p)
  for (const mutate of [
    v => { v.writers[0].activity.pop() },
    v => { v.writers[0].activity[0]++ },
    v => { v.writers[0].growth_percent++ },
    v => { v.writers[0].previous_count = -1 },
    v => { v.writers[0].previous_count = 0 },
    v => { v.writers[0].growth_percent = Infinity },
    v => { v.writers[0].previous_count = 10; v.writers[0].growth_percent = -70 },
  ]) { const bad = structuredClone(p); mutate(bad); assert.throws(() => validateRankings(bad, q, now)) }
  p.writers[1].previous_count = 0; p.writers[1].growth_percent = null
  assert.equal(validateRankings(p, q, now).writers[1].growth_percent, null)
  p.writers.reverse(); p.writers.forEach((item, i) => item.rank = i + 1)
  assert.throws(() => validateRankings(p, q, now), 'new entries follow measured changes')
})

test('volume keeps activity but orders by article count independently of growth', () => {
  const q = { ...query, sort: 'volume' }
  assert.deepEqual(parseRankingsQuery(new URLSearchParams(params + '&sort=volume'), now), q)
  const p = { ...payload(), sort: 'volume' }
  for (const key of ['writers', 'categories', 'mentions']) p[key] = p[key].map(item => ({ ...item, previous_count: 1, growth_percent: (item.count - 1) * 100, activity: [item.count, ...Array(23).fill(0)] }))
  p.writers[0].previous_count = 30; p.writers[0].growth_percent = -90
  assert.deepEqual(validateRankings(p, q, now), p)
  p.writers[1].count = 4; p.writers[1].activity[0] = 4; p.writers[1].growth_percent = 300
  assert.throws(() => validateRankings(p, q, now))
})


test('pagination accepts a non-negative offset and validates absolute ranks', () => {
  assert.equal(parseRankingsQuery(new URLSearchParams(params + '&offset=20'), now).offset, 20)
  for (const offset of ['-1', '1.5', '01', '', '100000000', 'NaN']) {
    assert.throws(() => parseRankingsQuery(new URLSearchParams(params + '&offset=' + offset), now))
  }
  assert.throws(() => parseRankingsQuery(new URLSearchParams(params + '&offset=0&offset=1'), now))
  const data = payload()
  for (const key of ['writers', 'categories', 'mentions']) data[key].forEach(row => { row.rank += 20 })
  assert.equal(validateRankings(data, { ...query, offset: 20 }, now).writers[0].rank, 21)
  assert.throws(() => validateRankings(payload(), { ...query, offset: 20 }, now))
})
