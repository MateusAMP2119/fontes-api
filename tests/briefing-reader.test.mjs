import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BriefingController } from '../worker/controllers/BriefingController.ts'

test('retained briefing reader requires verified sessions and reads saved results without generation', async () => {
  let identity = null
  let reads = 0
  const payload = {text: 'Resumo guardado.', notes: [{code: 'PARTIAL_CLUSTERING'}, {code: 'EMPTY_PERIOD'}]}
  const controller = new BriefingController({
    BRIEFING_DB: {prepare() {return {async first() {
      reads++
      return {payload: JSON.stringify(payload), generated_at: Date.now()/1000}
    }}}},
    AI: {run() {throw new Error('reader must not generate')}},
  }, {bearerSession: async () => identity})
  const call = (suffix = '', method = 'GET') => controller.handle(new Request('https://api.fonteslabs.com/api/briefing'+suffix, {method}))
  assert.equal((await call()).status, 401)
  identity = {user: {emailVerified: false}}
  assert.equal((await call()).status, 403)
  identity = {user: {emailVerified: true}}
  assert.equal((await call('?scope=other')).status, 400)
  assert.equal((await call('', 'POST')).status, 405)
  assert.equal(reads, 0)
  const response = await call()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {briefing: {text: payload.text, notes: [{code: 'EMPTY_PERIOD'}]}, stale: false})
  assert.equal(reads, 1)
})
