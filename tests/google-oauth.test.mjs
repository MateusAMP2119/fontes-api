import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture as authFixture } from './helpers/auth.mjs'

const cloud = 'https://api.fonteslabs.com'
const local = 'http://localhost:8788'
const callback = 'https://builder.fonteslabs.com/api/auth/callback/google'
const proxySecret = 'test-only-shared-proxy-secret-at-least-32-characters'
function fixture(origin) {
  const f = authFixture({BETTER_AUTH_URL: origin, GOOGLE_REDIRECT_URI: callback, OAUTH_PROXY_SECRET: proxySecret})
  return {auth: {handler: request => f.auth.handle(request), $context: f.auth.auth.$context}, database: f.env.store}
}
async function start(auth, origin, frontend) {
  const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: frontend },
    body: JSON.stringify({ provider: 'google', callbackURL: frontend + '/', disableRedirect: true }),
  }))
  assert.equal(response.status, 200)
  return { response, url: new URL((await response.json()).url) }
}
function cookies(response) { return response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') }

test('local Google handoff validates local state and establishes a local session', async () => {
  const dev = fixture(local), prod = fixture(cloud)
  const initial = await start(dev.auth, local, 'http://localhost:5173')
  assert.equal(initial.url.searchParams.get('redirect_uri'), callback)
  const context = await prod.auth.$context
  const provider = context.socialProviders.find(p => p.id === 'google')
  provider.validateAuthorizationCode = async () => ({ accessToken: 'fake-token' })
  provider.getUserInfo = async () => ({ user: { id: 'google-test-user', name: 'Test', email: 'test@example.com', emailVerified: true }, data: { sub: "google-test-user" } })
  const returned = await prod.auth.handler(new Request(`${cloud}/api/auth/callback/google?code=fake-code&state=${encodeURIComponent(initial.url.searchParams.get('state'))}`))
  assert.equal(returned.status, 302)
  const handoff = returned.headers.get('location')
  assert.ok(handoff.startsWith(local + '/api/auth/oauth-proxy-callback?'))
  const final = await dev.auth.handler(new Request(handoff, { headers: { cookie: cookies(initial.response) } }))
  assert.equal(final.status, 302)
  assert.equal(final.headers.get('location'), 'http://localhost:5173/')
  const session = await dev.auth.handler(new Request(`${local}/api/auth/get-session`, { headers: { cookie: cookies(final) } }))
  assert.equal((await session.json()).user.email, 'test@example.com')
  assert.equal((prod.database.user || []).length, 0)
  const replay = await dev.auth.handler(new Request(handoff, { headers: { cookie: cookies(initial.response) } }))
  assert.ok(!cookies(replay).includes('session_token='))
})

test('cloud keeps the direct callback and rejects a missing state cookie', async () => {
  const prod = fixture(cloud)
  const initial = await start(prod.auth, cloud, 'https://app.fonteslabs.com')
  assert.equal(initial.url.searchParams.get('redirect_uri'), callback)
  assert.ok(cookies(initial.response).includes('__Secure-better-auth.state='))
  const rejected = await prod.auth.handler(new Request(`${cloud}/api/auth/callback/google?code=fake-code&state=${initial.url.searchParams.get('state')}`))
  assert.match(rejected.headers.get('location'), /state_mismatch/)
})
