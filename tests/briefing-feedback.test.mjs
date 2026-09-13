import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { BriefingFeedbackController } from '../worker/controllers/BriefingFeedbackController.ts'

test('feedback is authenticated, validated, persisted and isolated per user and generation', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec("CREATE TABLE briefing_generations (id TEXT PRIMARY KEY, status TEXT); INSERT INTO briefing_generations VALUES ('saved-1', 'succeeded'), ('pending-1', 'pending');")
  sqlite.exec(readFileSync(new URL('../briefing/migrations/0004_briefing_feedback.sql', import.meta.url), 'utf8'))
  const db = { prepare(sql) { return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) ?? null },
    async run() { return sqlite.prepare(sql).run(...args) },
  } } } } }
  let identity = null
  const controller = new BriefingFeedbackController({ BRIEFING_DB: db }, { bearerSession: async () => identity })
  const call = (body, id = 'saved-1', method = body === undefined ? 'GET' : 'POST') => controller.handle(new Request(`https://api.fonteslabs.com/api/briefing/feedback?generation_id=${id}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  assert.equal((await call()).status, 401)
  identity = { user: { id: 'one', emailVerified: false } }
  assert.equal((await call()).status, 403)
  identity.user.emailVerified = true
  assert.deepEqual(await (await call()).json(), { rating: null })
  assert.equal((await call({ rating: 'other' })).status, 400)
  assert.equal((await call({ rating: 'up' }, 'missing')).status, 404)
  assert.equal((await call({ rating: 'up' }, 'pending-1')).status, 404)
  assert.equal((await call({ rating: 'up', padding: 'x'.repeat(1100) })).status, 400)
  assert.equal((await call(undefined, 'saved-1&user_id=one')).status, 400)
  assert.deepEqual(await (await call({ rating: 'up', user_id: 'someone-else' })).json(), { rating: 'up' })
  assert.deepEqual(await (await call()).json(), { rating: 'up' })
  identity.user.id = 'two'
  assert.deepEqual(await (await call()).json(), { rating: null })
  await call({ rating: 'down' })
  identity.user.id = 'one'
  await call({ rating: 'down' })
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM briefing_feedback').get().n, 2)
  assert.deepEqual(await (await call()).json(), { rating: 'down' })
  await call({ rating: null })
  assert.deepEqual(await (await call()).json(), { rating: null })
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM briefing_feedback').get().n, 1)
  sqlite.close()
})
