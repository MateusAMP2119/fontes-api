import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../worker/controllers/ApiController.ts', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const imports = `import { BriefingController } from '${new URL('../worker/controllers/BriefingController.ts', import.meta.url).href}';\nimport { AuthController } from '${new URL('./helpers/auth.mjs', import.meta.url).href}';\nimport briefing from '${new URL('../briefing/index.ts', import.meta.url).href}';\n`
const { ApiController } = await import('data:text/javascript;base64,' + Buffer.from(imports + js).toString('base64'))
test('retired custom and auth routes return 404 before configuration or database access', async () => {
  const api = new ApiController({}, {})
  for (const path of ['/api/projects', '/api/auth/health', '/api/auth/organization-access/code', '/api/auth/organization-access/join', '/api/auth/organization/create', '/api/auth/token']) {
    for (const method of ['GET', 'POST']) {
      assert.equal((await api.handle(new Request('https://api.fonteslabs.com'+path, {method}))).status, 404, path)
    }
  }
})

test('root and docs remain public while the schema includes only retained API operations', async () => {
  const api = new ApiController({}, {})
  const root = await api.handle(new Request('https://api.fonteslabs.com/'))
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('location'), 'https://api.fonteslabs.com/api/auth/docs')
  for (const path of ['/api/auth/docs', '/api/auth/docs/']) {
    const response = await api.handle(new Request('https://api.fonteslabs.com'+path))
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Scalar.createApiReference/)
  }
  const {fixture, AuthController} = await import('./helpers/auth.mjs')
  const f = fixture()
  const configured = new ApiController(f.env, {waitUntil() {}})
  const response = await configured.handle(new Request('https://api.fonteslabs.com/api/auth/openapi.json'))
  assert.equal(response.status, 200)
  const schema = await response.json()
  assert.equal(Object.keys(schema.paths).length, 19)
  assert.deepEqual(schema.security, [])
  for (const path of ['/api/auth/email-otp/send-verification-otp', '/api/auth/sign-in/email-otp', '/api/auth/sign-in/email', '/api/auth/sign-in/social']) assert.deepEqual(schema.paths[path].post.security, [], path)
  assert.equal(schema.paths['/api/auth/sign-in/email-otp'].post.summary, 'Verify registration code')
  for (const operations of Object.values(schema.paths)) {
    for (const operation of Object.values(operations)) {
      for (const requirement of operation.security ?? []) {
        for (const scheme of Object.keys(requirement)) assert.ok(schema.components.securitySchemes[scheme], scheme)
      }
    }
  }
  for (const path of ['/api/briefing', '/api/briefing/generate']) {
    for (const operation of Object.values(schema.paths[path])) assert.deepEqual(operation.security, [{sessionBearer:[]}])
  }
  assert.equal(schema.components.securitySchemes.sessionBearer.scheme, 'bearer')
  assert.equal(schema.components.securitySchemes.briefingBearer, undefined)
  assert.deepEqual(schema.tags.map(tag => tag.name), ['Authentication', 'Email verification', 'Onboarding', 'Briefing'])
  const expectedTags = {
    '/api/auth/sign-in/social': 'Authentication', '/api/auth/get-session': 'Authentication',
    '/api/auth/set-password': 'Authentication', '/api/auth/verify-email': 'Email verification',
    '/api/onboarding': 'Onboarding', '/api/briefing': 'Briefing',
  }
  for (const [path, tag] of Object.entries(expectedTags)) {
    for (const operation of Object.values(schema.paths[path])) assert.deepEqual(operation.tags, [tag])
  }
  for (const operations of Object.values(schema.paths)) {
    for (const operation of Object.values(operations)) {
      assert.equal(operation.tags.length, 1)
      assert.notEqual(operation.tags[0], 'Default')
    }
  }
  assert.deepEqual(schema.paths['/api/auth/callback/google'].get.parameters, [])
  for (const [path, operations] of Object.entries(schema.paths)) {
    if (path.startsWith('/api/auth/')) {
      const method = AuthController.publicMethod(path).toLowerCase()
      assert.deepEqual(Object.keys(operations), [method], path)
    }
  }
  for (const path of ['/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/callback/google', '/api/onboarding', '/api/briefing', '/api/briefing/generate']) assert.ok(schema.paths[path], path)
  for (const path of ['/api/projects', '/api/auth/token', '/api/auth/organization/create', '/api/auth/sign-up/email', '/api/onboarding/availability']) assert.equal(schema.paths[path], undefined, path)
  const post = await configured.handle(new Request('https://api.fonteslabs.com/api/auth/openapi.json', {method:'POST'}))
  assert.equal(post.status, 405)
})

test('both briefing routes accept login session bearer tokens and reject missing, expired or revoked sessions', async () => {
  const {fixture, cookies} = await import('./helpers/auth.mjs')
  let reads = 0
  const f = fixture({BRIEFING_DB: {prepare() {return {
    bind() {return this}, async first() {reads++; return {payload: JSON.stringify({text:'Saved briefing'}), generated_at: Date.now()/1000}}, async run() {},
  }}}})
  const email = 'briefing@example.com'
  await f.call('/email-otp/send-verification-otp', {email, type:'sign-in'})
  await Promise.all(f.pending)
  const login = await f.call('/sign-in/email-otp', {email, otp:f.env.messages[0].code})
  assert.equal(login.status, 200)
  const cookie = cookies(login)
  const signedToken = login.headers.get('set-auth-token')
  const {token} = await login.json()
  assert.ok(token)
  assert.ok(signedToken)
  await f.auth.setPassword(f.request('/unused', undefined, cookie), 'test-briefing-password')
  const api = new ApiController(f.env, {waitUntil() {}})
  const request = (path, authorization, body) => new Request('https://api.fonteslabs.com'+path, {
    method: path.endsWith('/generate') ? 'POST' : 'GET',
    headers: {authorization, cookie, 'content-type':'application/json'},
    ...(path.endsWith('/generate') ? {body:body ?? JSON.stringify({from:'2026-09-10T00:00:00Z',until:'2026-09-11T00:00:00Z'})} : {}),
  })
  const paths = ['/api/briefing', '/api/briefing/generate']
  for (const path of paths) {
    for (const authorization of ['', 'Bearer wrong', 'Bearer test-only-token', 'Basic '+token]) {
      const result = await api.handle(request(path, authorization))
      assert.equal(result.status, 401, path)
      assert.equal(result.headers.get('www-authenticate'), 'Bearer')
    }
  }
  assert.equal(reads, 0, 'invalid bearer never falls back to the valid cookie')
  for (const path of paths) {
    for (const value of [token, signedToken]) {
      const result = await api.handle(request(path, 'Bearer '+value))
      assert.equal(result.status, 200, path)
      assert.equal((await result.json()).briefing.text, 'Saved briefing')
    }
  }
  const invalid = await api.handle(request('/api/briefing/generate', 'Bearer '+token, '{}'))
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'INVALID_BRIEFING_INTERVAL')
  const validReads = reads
  f.env.store.user[0].emailVerified = false
  for (const path of paths) assert.equal((await api.handle(request(path, 'Bearer '+token))).status, 403)
  f.env.store.user[0].emailVerified = true
  f.env.store.session[0].expiresAt = new Date(0)
  for (const path of paths) assert.equal((await api.handle(request(path, 'Bearer '+token))).status, 401)
  // Expiry may remove the row. Password login tests revocation independently.
  const fresh = await f.call('/sign-in/email', {email, password:'test-briefing-password'})
  const freshToken = (await fresh.clone().json()).token
  assert.ok(freshToken)
  assert.equal((await f.call('/sign-out', {}, cookies(fresh))).status, 200)
  for (const path of paths) assert.equal((await api.handle(request(path, 'Bearer '+freshToken))).status, 401)
  assert.equal(reads, validReads, 'rejected sessions never reach briefing storage')
})
