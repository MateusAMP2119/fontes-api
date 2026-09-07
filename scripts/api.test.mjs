import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migration-statements.mjs'

const cookies = r => r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'google-test', alg: 'RS256', use: 'sig' }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function idToken(emailVerified = true) {
  const now = Math.floor(Date.now() / 1000)
  const data = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode({ iss: 'https://accounts.google.com', aud: 'test-client', sub: emailVerified ? 'google-user' : 'unverified-google-user', email: emailVerified ? 'google@example.test' : 'unverified@example.test', email_verified: emailVerified, name: 'Google Test', iat: now, exp: now + 3600 })
  return data + '.' + sign('RSA-SHA256', Buffer.from(data), keys.privateKey).toString('base64url')
}

for (const origin of ['http://localhost:5173', 'https://builder.fonteslabs.com']) test(`API end to end on ${origin}`, async t => {
  let oauthForm, verifiedEmail = true
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: resolve('.wrangler/auth-test-dist/local.js'),
    compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'], d1Databases: ['APP_DB'],
    bindings: { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'test-only-secret-012345678901234567890123456789', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret' },
    outboundService: async request => {
      if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] })
      assert.equal(request.url, 'https://oauth2.googleapis.com/token')
      oauthForm = new URLSearchParams(await request.text())
      assert.equal(oauthForm.get('redirect_uri'), origin + '/api/auth/callback/google')
      if (oauthForm.get('code') === 'bad-code') return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({ access_token: 'test-access', token_type: 'Bearer', expires_in: 3600, id_token: idToken(verifiedEmail) })
    },
  }))
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('APP_DB')
  for (const file of (await readdir('migrations-auth')).sort()) {
    for (const sql of migrationStatements(await readFile('migrations-auth/' + file, 'utf8'))) await db.prepare(sql).run()
  }
  await db.prepare('CREATE TABLE authLocalMail(id TEXT PRIMARY KEY,recipient TEXT,subject TEXT,text TEXT,createdAt INTEGER)').run()
  const request = (path, body, cookie = '', extra = {}) => mf.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', cookie, 'cf-connecting-ip': '192.0.2.1', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' })
  const expect = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r }
  const post = async (path, body, cookie, status) => expect(await request('/api/auth/' + path, body, cookie), status)
  const creds = { email: 'email@example.test', password: 'Test-Password-123!', name: 'Email Test', callbackURL: '/' }
  await expect(await request('/api/auth/health'))
  await expect(await request('/api/auth/sign-up/email', creds, '', { origin: 'https://evil.test' }), 403)
  await post('sign-up/email', creds)
  await post('sign-in/email', creds, '', 403)
  const mail = () => db.prepare('SELECT text FROM authLocalMail WHERE recipient=? ORDER BY createdAt DESC LIMIT 1').bind(creds.email).first()
  const verify = await expect(await mf.dispatchFetch((await mail()).text, { redirect: 'manual' }), 302)
  let cookie = cookies(verify)
  assert.match(cookie, /better-auth.session_token=/)
  assert.equal(verify.headers.get('set-cookie').includes('Secure;'), origin.startsWith('https:'))
  const getSession = async c => (await request('/api/auth/get-session', undefined, c)).json()
  assert.equal((await getSession(cookie)).user.emailVerified, true)
  assert.equal(await getSession(cookie + 'tampered'), null)
  await post('update-user', { username: 'reader' }, cookie)
  const org = await (await post('organization/create', { name: 'Test', slug: 'test' }, cookie)).json()
  await post('organization/set-active', { organizationId: org.id }, cookie)
  await expect(await request('/api/projects', { name: 'Project', visibility: 'private' }, cookie), 201)
  assert.equal((await (await request('/api/projects', undefined, cookie)).json())[0].name, 'Project')
  await post('sign-out', {}, cookie)
  assert.equal(await getSession(cookie), null)
  cookie = cookies(await post('sign-in/email', creds))
  assert.equal((await getSession(cookie)).user.username, 'reader')
  await post('request-password-reset', { email: creds.email, redirectTo: origin + '/login?mode=reset' })
  const resetLink = await expect(await mf.dispatchFetch((await mail()).text, { redirect: 'manual' }), 302)
  const token = new URL(resetLink.headers.get('location')).searchParams.get('token')
  await post('reset-password', { token, newPassword: 'Updated-Password-123!' })
  await post('reset-password', { token, newPassword: 'Replay-Password-123!' }, '', 400)
  assert.equal(await getSession(cookie), null)
  await post('sign-in/email', creds, '', 401)
  await post('sign-in/email', { ...creds, password: 'Updated-Password-123!' })
  const start = await post('sign-in/social', { provider: 'google', callbackURL: '/' })
  const googleUrl = new URL((await start.json()).url)
  const callback = '/api/auth/callback/google?code=good-code&state=' + googleUrl.searchParams.get('state')
  const google = await expect(await request(callback, undefined, cookies(start)), 302)
  assert.equal(new URL(google.headers.get('location'), origin).pathname, '/')
  assert.equal(createHash('sha256').update(oauthForm.get('code_verifier')).digest('base64url'), googleUrl.searchParams.get('code_challenge'))
  assert.equal((await getSession(cookies(google))).user.email, 'google@example.test')
  const replay = await request(callback, undefined, cookies(start))
  assert.ok(!cookies(replay).includes('better-auth.session_token='))
  verifiedEmail = false
  const rejectedStart = await post('sign-in/social', { provider: 'google', callbackURL: '/' })
  const state = new URL((await rejectedStart.json()).url).searchParams.get('state')
  const rejected = await request('/api/auth/callback/google?code=good-code&state=' + state, undefined, cookies(rejectedStart))
  assert.ok(!cookies(rejected).includes('better-auth.session_token='))
  const spec = await (await request('/api/auth/openapi.json')).json()
  assert.ok(spec.paths['/api/auth/sign-in/email'])
  assert.ok(spec.paths['/api/projects'])
  assert.equal(spec.servers[0].url, '/')
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length, 0)
})

test('production bundle exposes docs but no local inbox and fails closed without secrets', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: resolve('.wrangler/auth-dist/index.js'), compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'], d1Databases: ['APP_DB'] }))
  t.after(() => mf.dispose())
  assert.equal((await mf.dispatchFetch('https://example.test/__dev/mail')).status, 404)
  assert.equal((await mf.dispatchFetch('https://example.test/api/auth/get-session')).status, 503)
  const docs = await mf.dispatchFetch('https://example.test/api/auth/docs')
  assert.equal(docs.status, 200)
  assert.match(await docs.text(), /Scalar.createApiReference/)
})
