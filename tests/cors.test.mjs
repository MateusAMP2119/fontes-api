import assert from 'node:assert/strict'
import { test } from 'node:test'
import { preflight, withCors } from '../worker/cors.ts'

const origin = 'https://app.fonteslabs.com'
const request = (method = 'POST', headers = 'Content-Type') => new Request('https://api.fonteslabs.com/api/onboarding', {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers },
})

test('credentialed JSON preflight succeeds without calling auth', () => {
  const response = withCors(preflight(request(), true), origin, true)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true')
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /content-type/)
})

test('untrusted origins and unsupported methods/headers fail preflight', () => {
  assert.equal(preflight(request(), false).status, 403)
  assert.equal(preflight(request('DELETE'), true).status, 403)
  assert.equal(preflight(request('POST', 'X-Admin-Key'), true).status, 403)
  assert.equal(withCors(preflight(request(), false), origin, false).headers.get('Access-Control-Allow-Origin'), null)
})

test('actual errors preserve status, body, cookies and cache variation', async () => {
  const result = new Response('unauthorized', { status: 401, headers: { 'Set-Cookie': 'session=test; HttpOnly; Secure', Vary: 'Accept' } })
  const response = withCors(result, origin, true)
  assert.equal(response.status, 401)
  assert.equal(await response.text(), 'unauthorized')
  assert.equal(response.headers.get('Set-Cookie'), 'session=test; HttpOnly; Secure')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
  assert.match(response.headers.get('Vary'), /Accept, Origin/)
})

test('ordinary requests proceed and no-origin requests get no CORS grant', () => {
  assert.equal(preflight(new Request('https://api.fonteslabs.com/api/auth/get-session'), true), undefined)
  const response = withCors(new Response(null), null, false)
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
})
