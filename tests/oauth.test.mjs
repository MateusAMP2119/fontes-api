import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oauthCallbackRedirect } from '../worker/oauth.ts'

const api = 'https://api.fonteslabs.com'
const callback = 'https://builder.fonteslabs.com/api/auth/callback/google'

test('registered Google callback carries state/code to the cookie-owning API origin', () => {
  const response = oauthCallbackRedirect(new Request(`${callback}?code=test-code&state=test-state`), api, callback)
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('Location'), `${api}/api/auth/callback/google?code=test-code&state=test-state`)
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
})

test('callback bridge cannot loop or redirect unrelated hosts, paths or methods', () => {
  for (const url of [`${api}/api/auth/callback/google`, `${callback}/other`, 'https://untrusted.test/api/auth/callback/google']) {
    assert.equal(oauthCallbackRedirect(new Request(url), api, callback), undefined)
  }
  assert.equal(oauthCallbackRedirect(new Request(callback, { method: 'POST' }), api, callback), undefined)
  assert.equal(oauthCallbackRedirect(new Request(callback), api), undefined)
})
