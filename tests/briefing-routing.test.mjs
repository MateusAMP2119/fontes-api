import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../worker/controllers/ApiController.ts', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const imports = `import { AuthController } from '${new URL('./helpers/auth.mjs', import.meta.url).href}';\nimport briefing from '${new URL('../briefing/index.ts', import.meta.url).href}';\n`
const { ApiController } = await import('data:text/javascript;base64,' + Buffer.from(imports + js).toString('base64'))
test('API dispatches briefing generation directly and keeps bearer authentication', async () => {
  const env = { EBS_API_TOKEN: 'test-token' }
  const api = new ApiController(env, {})
  const call = (method, token, body) => api.handle(new Request('https://api.fonteslabs.com/api/briefing/generate', {
    method, headers: { Authorization: `Bearer ${token}` }, ...(body ? { body } : {}),
  }))
  assert.equal((await call('POST', 'wrong')).status, 401)
  assert.equal((await call('GET', 'test-token')).status, 405)
  const response = await call('POST', 'test-token', '{}')
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'INVALID_BRIEFING_INTERVAL')
})

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
  assert.equal(Object.keys(schema.paths).length, 20)
  assert.deepEqual(schema.tags.map(tag => tag.name), ['Authentication', 'Sessions', 'Passwords', 'Email verification', 'Onboarding', 'Briefing'])
  const expectedTags = {
    '/api/auth/sign-in/social': 'Authentication', '/api/auth/get-session': 'Sessions',
    '/api/auth/change-password': 'Passwords', '/api/auth/verify-email': 'Email verification',
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
