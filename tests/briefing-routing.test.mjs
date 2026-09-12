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
  for (const path of ['/', '/api/projects', '/api/auth/health', '/api/auth/docs', '/api/auth/openapi.json', '/api/auth/organization-access/code', '/api/auth/organization-access/join', '/api/auth/organization/create', '/api/auth/token']) {
    for (const method of ['GET', 'POST']) {
      assert.equal((await api.handle(new Request('https://api.fonteslabs.com'+path, {method}))).status, 404, path)
    }
  }
})
