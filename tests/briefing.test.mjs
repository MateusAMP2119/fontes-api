import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import generator from '../briefing/index.ts'
import { comparison } from '../briefing/llm.ts'
import { parsePeriod } from '../briefing/period.ts'
import { briefingMetadata, change, readJson, validateFacts } from '../briefing/facts.ts'
import { BriefingStore, LEASE_SECONDS } from '../briefing/store.ts'

const now = () => Math.floor(Date.now() / 1000)
const until = now()
const period = { from: until - 86400, until, previous_from: until - 172800 }
const input = (p = period) => ({ from: new Date(p.from * 1000).toISOString(), until: new Date(p.until * 1000).toISOString() })
function facts(until = period.until) {
  return { version: 1, scope: 'general', period: { from: until - 86400, until, previous_from: until - 172800 },
    totals: { articles: 10, previous_articles: 8, sources: 4, previous_sources: 3 },
    clustered_articles: 6, latest_discovery: until - 60,
    highlights: [{ story_id: 12, slug: 'example', title: 'Uma história', articles: 6, previous_articles: 3, sources: 2 }] }
}
function fixture(t) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(readFileSync(new URL('../briefing/migrations/0001_briefings.sql', import.meta.url), 'utf8'))
  sql.exec(readFileSync(new URL('../briefing/migrations/0002_generation_history.sql', import.meta.url), 'utf8'))
  sql.exec(readFileSync(new URL('../briefing/migrations/0003_briefing_windows.sql', import.meta.url), 'utf8'))
  let batchQueue = Promise.resolve()
  const db = { prepare(query) { let args = []; return {
    bind(...values) { args = values; return this },
    async first() { return sql.prepare(query).get(...args) ?? null },
    async run() { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } } },
  } }, batch(statements) {
    // D1 serializes transactions; model that instead of nesting SQLite BEGINs.
    const run = batchQueue.then(async () => {
      sql.exec('BEGIN')
      try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results }
      catch (error) { sql.exec('ROLLBACK'); throw error }
    })
    batchQueue = run.catch(() => {})
    return run
  } }
  const AI = { run: async () => Response.json(modelResponse()) }
  return { sql, db, store: new BriefingStore(db, period), env: { BRIEFING_DB: db, AI, NEWS_API_URL: 'https://news.example', EBS_API_TOKEN: 'test-only-token', CF_VERSION_METADATA: { id: 'test-version' } } }
}
function modelResponse() {
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
    text: 'Foram recolhidos 10 artigos de 4 fontes, 2 artigos mais do que no período anterior. «Uma história» reuniu 6 artigos de 2 fontes.',
    labels: [{ story_id: 12, label: 'Uma história' }],
  }) } }], usage: { prompt_tokens: 400, completion_tokens: 100, neurons: 6.3 } }
}
const generateRequest = (p = period) => new Request('https://briefing.internal/generate', { method: 'POST', headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' }, body: JSON.stringify(input(p)) })

test('public generation rejects missing or invalid credentials before storage or inference', async t => {
  const { env, sql } = fixture(t)
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch') })
  const ai = t.mock.method(env.AI, 'run', async () => { throw new Error('must not infer') })
  for (const host of ['ebs.fonteslabs.com', 'www.ebs.fonteslabs.com', 'briefing.internal']) {
    for (const authorization of ['', 'Bearer wrong', 'Bearer test-only-tokem']) {
      const response = await generator.fetch(new Request(`https://${host}/generate`, { method: 'POST', headers: { Authorization: authorization } }), env)
      assert.equal(response.status, 401)
    }
  }
  assert.equal((await generator.fetch(generateRequest(), { ...env, EBS_API_TOKEN: '' })).status, 503)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM briefing_windows').get().n, 0)
  assert.equal(upstream.mock.callCount(), 0)
  assert.equal(ai.mock.callCount(), 0)
})

test('public liveness exposes only service and version without touching dependencies', async () => {
  for (const path of ['/', '/health']) {
    const response = await generator.fetch(new Request(`https://ebs.fonteslabs.com${path}`), { CF_VERSION_METADATA: { id: 'test-version' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(await response.json(), { service: 'fontes-api', status: 'ok', version: 'test-version' })
  }
})

test('generation requires a bounded explicit JSON interval before storage or inference', async t => {
  const { env, sql } = fixture(t)
  const upstream = t.mock.method(globalThis, 'fetch', async () => Response.json(facts()))
  const headers = { Authorization: 'Bearer test-only-token' }
  for (const body of ['', '{}', ' ', 'x'.repeat(100000), JSON.stringify({ ...input(), extra: true }),
    JSON.stringify({ from: input().from }), JSON.stringify({ from: input().until, until: input().from }),
    JSON.stringify({ from: '2026-02-30T00:00:00Z', until: '2026-03-01T00:00:00Z' }),
    JSON.stringify({ from: '2026-01-01', until: '2026-01-02' }),
    JSON.stringify(input({ from: now() - 100, until: now() + 100 })),
    JSON.stringify(input({ from: now() - 32 * 86400, until: now() }))]) {
    assert.equal((await generator.fetch(new Request('https://ebs.fonteslabs.com/generate', { method: 'POST', headers, body }), env)).status, 400)
  }
  assert.equal(sql.prepare('SELECT count(*) AS n FROM briefing_windows').get().n, 0)
  assert.equal(upstream.mock.callCount(), 0)
  assert.equal((await generator.fetch(generateRequest(), env)).status, 201)
})

test('math handles zero baselines, stable periods and falling coverage', () => {
  assert.equal(change(12, 8).percent, 50)
  assert.equal(change(0, 4).percent, -100)
  assert.equal(change(8, 0).percent, null)
  assert.equal(change(8, 0).baseline, 'none')
  assert.equal(change(0, 0).direction, 'flat')
  const input = facts(); validateFacts(input, now())
  const result = briefingMetadata(input, now())
  assert.equal(result.totals.change.percent, 25)
  assert.equal(result.highlights[0].href, '/historias/12')
  assert.equal(result.coverage.clustered_articles, 6)
  assert.equal(result.timestamp_basis, 'discovered_at')
  assert.doesNotMatch(JSON.stringify(result), /\u2014/)
})

test('missing periods, impossible counts, duplicates and stale aggregates are rejected', () => {
  for (const mutate of [
    x => { x.period.from++ }, x => { x.period.until -= 500 },
    x => { x.totals.sources = 100 }, x => { x.totals.previous_sources = -1 },
    x => { x.clustered_articles = 20 }, x => { x.highlights.push(x.highlights[0]) },
    x => { x.highlights[0].articles = 11 }, x => { x.highlights[0].story_id = -1 },
    x => { x.latest_discovery = x.period.until + 1 },
  ]) { const input = facts(); mutate(input); assert.throws(() => validateFacts(input, now())) }
  const empty = facts(); empty.totals = { articles: 0, previous_articles: 0, sources: 0, previous_sources: 0 }
  empty.clustered_articles = 0; empty.highlights = []; empty.latest_discovery = null
  validateFacts(empty, now())
  assert.equal(briefingMetadata(empty, now()).coverage.collection_stale, true)
  assert.deepEqual(briefingMetadata(empty, now()).highlights, [])
})

test('response size bound applies even without Content-Length', async () => {
  assert.deepEqual(await readJson(Response.json({ ok: true })), { ok: true })
  await assert.rejects(() => readJson(new Response('x'.repeat(100)), 50), /TOO_LARGE/)
  await assert.rejects(() => readJson(new Response(null, { status: 503 })), /UNAVAILABLE/)
})

test('metadata keeps clustering counts out of reader notices', () => {
  const input = facts()
  input.totals.articles = 10000
  input.clustered_articles = 9999
  let result = briefingMetadata(input, now())
  assert.deepEqual(result.notes, [])
  assert.equal(result.coverage.clustered_articles, 9999)
  for (const field of ['text', 'segments', 'method', 'composition']) assert.equal(field in result, false)
  input.latest_discovery = input.period.until - 21601
  input.highlights = []
  result = briefingMetadata(input, now())
  assert.equal(result.coverage.collection_stale, true)
  assert.deepEqual(result.notes.map(n => n.code), ['COLLECTION_STALE', 'NO_HIGHLIGHTS'])
  input.clustered_articles = input.totals.articles
  assert.ok(!briefingMetadata(input, now()).notes.some(n => n.code === 'PARTIAL_CLUSTERING'))
})

test('cached legacy notes are filtered without inference or changing stored evidence', async t => {
  const { env, store } = fixture(t)
  const old = { ...briefingMetadata(facts(), now()), generation_id: 'old', text: 'Existing briefing' }
  old.notes = [
    { code: 'PARTIAL_CLUSTERING', text: 'Old clustering notice' },
    { code: 'COLLECTION_STALE', text: 'Existing freshness notice' },
  ]
  const payload = JSON.stringify(old)
  await store.claim('old', now())
  await store.save('old', payload, now())
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch') })
  const ai = t.mock.method(env.AI, 'run', async () => { throw new Error('must not infer') })
  const response = await generator.fetch(generateRequest(), env)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { cached: true, briefing: { ...old, notes: [old.notes[1]] } })
  assert.equal((await store.latest()).payload, payload)
  assert.equal(upstream.mock.callCount(), 0)
  assert.equal(ai.mock.callCount(), 0)
})

test('D1 lease prevents concurrent work and fences expired writers', async t => {
  const { store } = fixture(t)
  assert.equal(await store.claim('one', 1000), true)
  assert.equal(await store.claim('two', 1001), false)
  const expired = 1000 + LEASE_SECONDS
  assert.equal(await store.claim('two', expired), true)
  assert.equal(await store.save('one', '{}', expired + 1), false)
  await store.release('one')
  assert.equal(await store.save('two', '{"ok":true}', expired + 1), true)
  assert.equal(await store.claim('three', expired + 2), false)
  assert.equal(await store.claim('three', expired + 86400), false)
  assert.equal((await store.latest()).payload, '{"ok":true}')
})

test('generator writes exact evidence once and interval cache never expires', async t => {
  const { env, sql, store } = fixture(t)
  let calls = 0
  let aiCalls = 0
  t.mock.method(env.AI, 'run', async () => { aiCalls++; return Response.json(modelResponse()) })
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(facts()) })
  const created = await generator.fetch(generateRequest(), env)
  assert.equal(created.status, 201)
  assert.equal((await created.json()).briefing.highlights[0].articles, 6)
  const saved = await store.latest()
  const cached = await generator.fetch(generateRequest(), env)
  assert.equal((await cached.json()).cached, true)
  assert.equal(calls, 1)
  assert.equal(aiCalls, 1)
  const audit = sql.prepare('SELECT * FROM briefing_generations').get()
  assert.equal(audit.status, 'succeeded')
  assert.equal(JSON.parse(audit.inputs).totals.articles, 10)
  assert.equal(JSON.parse(audit.request).messages[0].role, 'system')
  assert.equal(JSON.parse(audit.response).usage.neurons, 6.3)
  assert.equal(audit.input_tokens, 400)
  assert.equal(audit.neurons_basis, 'reported')
  assert.equal(audit.payload, saved.payload)
  sql.prepare('UPDATE briefing_windows SET generated_at = ?').run(now() - 86400)
  assert.equal((await generator.fetch(generateRequest(), env)).status, 200)
  assert.equal((await store.latest()).payload, saved.payload)
  assert.equal(calls, 1)
  assert.equal(aiCalls, 1)
})

test('invalid AI output is audited, preserves last result and applies a cooldown', async t => {
  const { env, db, sql } = fixture(t)
  const store = new BriefingStore(db, { from: period.from - 86400, until: period.until - 86400, previous_from: period.previous_from - 86400 })
  await store.claim('old', now() - 1000); await store.save('old', '{"old":true}', now() - 1000)
  t.mock.method(globalThis, 'fetch', async () => Response.json(facts()))
  const invalid = modelResponse(); invalid.choices[0].message.content = '{"text":"invented"}'
  t.mock.method(env.AI, 'run', async () => Response.json(invalid))
  assert.equal((await generator.fetch(generateRequest(), env)).status, 502)
  assert.equal((await store.latest()).payload, '{"old":true}')
  const audit = sql.prepare('SELECT * FROM briefing_generations').get()
  assert.equal(audit.status, 'failed')
  assert.equal(audit.error_code, 'BRIEFING_INVALID_MODEL_OUTPUT')
  assert.equal(audit.neurons, 6.3)
  assert.equal((await generator.fetch(generateRequest(), env)).status, 409)
})

test('expired generation is audited as superseded and cannot replace a newer snapshot', async t => {
  const { store, sql } = fixture(t)
  const usage = { input_tokens: 400, output_tokens: 100, neurons: 6.3, neurons_basis: 'reported' }
  await store.claim('late', 1000)
  await store.begin('late', 1000, 'model', 'v1', '{}', '{}')
  await store.claim('new', 1000 + LEASE_SECONDS)
  await store.begin('new', 1000 + LEASE_SECONDS, 'model', 'v1', '{}', '{}')
  assert.equal(await store.complete('new', '{"new":true}', '{}', usage, 1001 + LEASE_SECONDS), true)
  assert.equal(await store.complete('late', '{"late":true}', '{}', usage, 1002 + LEASE_SECONDS), false)
  assert.equal((await store.latest()).payload, '{"new":true}')
  assert.equal(sql.prepare("SELECT status FROM briefing_generations WHERE id = 'late'").get().status, 'superseded')
})

test('AI timeout is recorded without fabricated usage and releases work into cooldown', async t => {
  const { env, sql } = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => Response.json(facts()))
  t.mock.method(env.AI, 'run', async (_model, _input, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    throw new DOMException('timeout', 'TimeoutError')
  })
  assert.equal((await generator.fetch(generateRequest(), env)).status, 502)
  const audit = sql.prepare('SELECT * FROM briefing_generations').get()
  assert.equal(audit.status, 'failed')
  assert.equal(audit.error_code, 'BRIEFING_MODEL_UNAVAILABLE')
  assert.equal(audit.neurons, null)
  assert.equal(audit.response, null)
})

test('publication failure rolls back the successful audit and latest payload together', async t => {
  const { store, sql } = fixture(t)
  await store.claim('atomic', now())
  await store.begin('atomic', now(), 'model', 'v1', '{}', '{}')
  sql.exec("CREATE TRIGGER deny_publication BEFORE UPDATE OF payload ON briefing_windows BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END")
  const usage = { input_tokens: 1, output_tokens: 1, neurons: 1, neurons_basis: 'reported' }
  await assert.rejects(() => store.complete('atomic', '{"ok":true}', '{}', usage, now()), /simulated/)
  assert.equal(await store.latest(), null)
  assert.equal(sql.prepare("SELECT status FROM briefing_generations WHERE id = 'atomic'").get().status, 'pending')
})

test('simultaneous generation requests make only one upstream request', async t => {
  const { env } = fixture(t)
  let finish
  let calls = 0
  const pending = new Promise(resolve => { finish = resolve })
  t.mock.method(globalThis, 'fetch', async () => { calls++; await pending; return Response.json(facts()) })
  const first = generator.fetch(generateRequest(), env)
  // Advance until the first request has acquired its lease and reached the source.
  await new Promise(resolve => setImmediate(resolve))
  const second = await generator.fetch(generateRequest(), env)
  assert.equal(second.status, 409)
  finish()
  assert.equal((await first).status, 201)
  assert.equal(calls, 1)
})


test('source redirects use the edge-supported manual mode and never reach inference', async t => {
  const { env } = fixture(t)
  const upstream = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/facts' } })
  })
  const ai = t.mock.method(env.AI, 'run', async () => { throw new Error('must not infer') })
  assert.equal((await generator.fetch(generateRequest(), env)).status, 502)
  assert.equal(upstream.mock.callCount(), 1)
  assert.equal(ai.mock.callCount(), 0)
})


test('equivalent timezone offsets share the same persistent interval cache', async t => {
  const { env } = fixture(t)
  const first = { from: '2026-09-01T00:00:00Z', until: '2026-09-02T00:00:00Z' }
  const second = { from: '2026-09-01T01:00:00+01:00', until: '2026-09-02T02:00:00+02:00' }
  const expected = parsePeriod(first, now())
  assert.deepEqual(parsePeriod(second, now()), expected)
  const upstream = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.searchParams.get('from'), String(expected.from))
    assert.equal(url.searchParams.get('until'), String(expected.until))
    return Response.json(facts(expected.until))
  })
  const request = body => new Request('https://ebs.fonteslabs.com/generate', { method: 'POST', headers: { Authorization: 'Bearer test-only-token' }, body: JSON.stringify(body) })
  const a = await generator.fetch(request(first), env)
  const b = await generator.fetch(request(second), env)
  assert.equal(a.status, 201)
  assert.equal(b.status, 200)
  assert.equal((await b.json()).cached, true)
  assert.equal(upstream.mock.callCount(), 1)
})

test('different intervals have independent leases and cached results', async t => {
  const { env } = fixture(t)
  const other = { from: period.from - 86400, until: period.until - 86400, previous_from: period.previous_from - 86400 }
  const upstream = t.mock.method(globalThis, 'fetch', async url => Response.json(facts(Number(url.searchParams.get('until')))))
  const responses = await Promise.all([generator.fetch(generateRequest(), env), generator.fetch(generateRequest(other), env)])
  assert.deepEqual(responses.map(r => r.status), [201, 201])
  const [a, b] = await Promise.all(responses.map(r => r.json()))
  assert.notEqual(a.briefing.generation_id, b.briefing.generation_id)
  for (const p of [period, other]) assert.equal((await generator.fetch(generateRequest(p), env)).status, 200)
  assert.equal(upstream.mock.callCount(), 2)
})

test('source must return the exact requested interval', async t => {
  const { env, sql } = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => Response.json(facts(period.until - 1)))
  const ai = t.mock.method(env.AI, 'run', async () => { throw new Error('must not infer') })
  assert.equal((await generator.fetch(generateRequest(), env)).status, 502)
  assert.equal(ai.mock.callCount(), 0)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM briefing_generations').get().n, 0)
})

test('window migration preserves a legacy saved briefing', () => {
  const sql = new DatabaseSync(':memory:')
  try {
    for (const name of ['0001_briefings.sql', '0002_generation_history.sql']) sql.exec(readFileSync(new URL('../briefing/migrations/' + name, import.meta.url), 'utf8'))
    const payload = JSON.stringify({ period, generated_at: now(), text: 'Existing briefing' })
    sql.prepare("INSERT INTO briefing(scope,payload,generated_at) VALUES ('general',?,?)").run(payload, now())
    sql.exec(readFileSync(new URL('../briefing/migrations/0003_briefing_windows.sql', import.meta.url), 'utf8'))
    assert.equal(sql.prepare('SELECT payload FROM briefing_windows WHERE period_from=? AND period_until=?').get(period.from, period.until).payload, payload)
    assert.equal(sql.prepare('SELECT payload FROM briefing').get().payload, payload)
  } finally { sql.close() }
})


test('custom interval copy compares equal durations without claiming 24 hours', () => {
  for (const current of [100, 101, 150]) {
    const f = facts()
    f.period.from = f.period.until - 3600
    f.period.previous_from = f.period.from - 3600
    f.totals.articles = current
    f.totals.previous_articles = 100
    validateFacts(f, now(), f.period)
    assert.match(comparison(f), /período anterior/)
    assert.doesNotMatch(comparison(f), /24 horas/)
    assert.equal(briefingMetadata(f, now()).heading, 'Resumo do período')
  }
})
