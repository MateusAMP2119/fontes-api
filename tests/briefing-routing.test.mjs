import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../worker/controllers/ApiController.ts', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const imports = `import briefing from '${new URL('../briefing/index.ts', import.meta.url).href}';\n`
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
