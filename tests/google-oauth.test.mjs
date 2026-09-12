import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture as authFixture } from './helpers/auth.mjs'

const cloud = 'https://api.fonteslabs.com'
const local = 'http://127.0.0.1:8788'
const callback = 'https://builder.fonteslabs.com/api/auth/callback/google'
function fixture(origin) {
  const f = authFixture({BETTER_AUTH_URL: origin, GOOGLE_REDIRECT_URI: callback})
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

test('local APIs do not offer Google sign-in', async () => {
  for (const origin of [local, 'http://localhost:8788']) {
    const dev = fixture(origin)
    const context = await dev.auth.$context
    assert.equal(context.socialProviders.length, 0)
    const response = await dev.auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
      method: 'POST', headers: {'content-type': 'application/json', origin: 'http://localhost:5173'},
      body: JSON.stringify({provider: 'google', callbackURL: 'http://localhost:5173/', disableRedirect: true}),
    }))
    assert.equal(response.status, 404)
  }
})

test('production Google callback creates a session without a proxy', async () => {
  const prod = fixture(cloud)
  const initial = await start(prod.auth, cloud, 'https://app.fonteslabs.com')
  const context = await prod.auth.$context
  const provider = context.socialProviders.find(p => p.id === 'google')
  provider.validateAuthorizationCode = async () => ({accessToken: 'fake-token'})
  provider.getUserInfo = async () => ({user: {id: 'google-test-user', name: 'Test', email: 'test@example.com', emailVerified: true}, data: {sub: 'google-test-user'}})
  const response = await prod.auth.handler(new Request(`${cloud}/api/auth/callback/google?code=fake-code&state=${encodeURIComponent(initial.url.searchParams.get('state'))}`, {headers: {cookie: cookies(initial.response)}}))
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://app.fonteslabs.com/')
  const session = await prod.auth.handler(new Request(`${cloud}/api/auth/get-session`, {headers: {cookie: cookies(response)}}))
  assert.equal((await session.json()).user.email, 'test@example.com')
})

test('cloud keeps the direct callback and rejects a missing state cookie', async () => {
  const prod = fixture(cloud)
  const initial = await start(prod.auth, cloud, 'https://app.fonteslabs.com')
  assert.equal(initial.url.searchParams.get('redirect_uri'), callback)
  assert.ok(cookies(initial.response).includes('__Secure-better-auth.state='))
  const rejected = await prod.auth.handler(new Request(`${cloud}/api/auth/callback/google?code=fake-code&state=${initial.url.searchParams.get('state')}`))
  assert.match(rejected.headers.get('location'), /state_mismatch/)
  assert.ok(rejected.headers.get('location').startsWith('https://app.fonteslabs.com/google-auth.html?'))
})
