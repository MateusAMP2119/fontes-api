import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync as Database } from 'node:sqlite'
import { organizationAccess, accessCode } from '../worker/organization-access.ts'
import { projects } from '../worker/projects.ts'

function fixture() {
  const db = new Database(':memory:')
  for (const file of readdirSync('migrations-auth').sort()) db.exec(readFileSync(`migrations-auth/${file}`, 'utf8'))
  for (const id of ['owner', 'admin', 'member', 'new', 'outsider']) {
    db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(id, id, `${id}@example.test`)
  }
  db.prepare('INSERT INTO organization (id,name,slug,createdAt) VALUES (?,?,?,0)').run('org', 'Test organization', 'test-org')
  for (const role of ['owner', 'admin', 'member']) db.prepare('INSERT INTO member VALUES (?,?,?,?,0)').run(role, 'org', role, role)
  const env = { BETTER_AUTH_SECRET: 'test-secret-never-production', APP_DB: {
    prepare(sql) {
      return { bind(...args) {
        return {
          async first() { return db.prepare(sql).get(...args) ?? null },
          async all() { return { results: db.prepare(sql).all(...args) } },
          async run() { return db.prepare(sql).run(...args) },
        }
      } }
    },
  } }
  const auth = (id, organizationId = 'org', verified = true) => ({ api: { async getSession() {
    return id ? { user: { id, emailVerified: verified }, session: { activeOrganizationId: organizationId } } : null
  } } })
  const request = (path, method = 'GET', body) => new Request(`https://example.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const code = () => accessCode(env.BETTER_AUTH_SECRET, 'org', Math.floor(Date.now() / 1200000))
  return { db, env, auth, request, code }
}

test('project visibility is persisted and enforced across users and organizations', async () => {
  const { env, auth, request } = fixture()
  const create = (body, user = 'owner') => projects(request('/api/projects', 'POST', body), env, auth(user), true)
  assert.equal((await create({ name: '  Private  ', visibility: 'private' })).status, 201)
  assert.equal((await create({ name: 'Shared', visibility: 'public' })).status, 201)
  assert.equal((await create({ name: 'Default' })).status, 201)
  const list = async (user) => (await projects(request('/api/projects'), env, auth(user), true)).json()
  assert.equal((await list('owner')).length, 3)
  assert.deepEqual((await list('member')).map((p) => p.name), ['Shared'])
  assert.equal((await projects(request('/api/projects'), env, auth('outsider'), true)).status, 403)
  assert.equal((await create({ name: 'x', visibility: 'oops' })).status, 400)
  assert.equal((await create({ name: ' '.repeat(4) })).status, 400)
  assert.equal((await create({ name: 'x'.repeat(81) })).status, 400)
  assert.equal((await projects(request('/api/projects','POST',{name:'x'}), env, auth('owner', null), true)).status, 409)
  assert.equal((await projects(request('/api/projects','POST',{name:'x'}), env, auth('owner'), false)).status, 403)
  assert.equal((await projects(request('/api/projects'), env, auth(null), true)).status, 401)
})

test('only verified owners/admins can retrieve the current non-cacheable code', async () => {
  const { env, auth, request, code } = fixture()
  for (const user of ['owner', 'admin']) {
    const response = await organizationAccess(request('/api/auth/organization-access/code'), env, auth(user), true)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).code, await code())
  }
  for (const user of ['member', 'outsider']) assert.equal((await organizationAccess(request('/api/auth/organization-access/code'), env, auth(user), true)).status, 403)
  assert.equal((await organizationAccess(request('/api/auth/organization-access/code'), env, auth('owner','org',false), true)).status, 403)
})

test('joining persists membership once, never upgrades roles, and rejects invalid codes', async () => {
  const { db, env, auth, request, code } = fixture()
  const join = (user, supplied) => organizationAccess(request('/api/auth/organization-access/join','POST', { name: 'test-org', code: supplied }), env, auth(user), true)
  const current = await code()
  assert.equal((await join('new', current)).status, 200)
  assert.equal((await join('new', current)).status, 200)
  assert.equal(db.prepare("SELECT count(*) n FROM member WHERE userId = 'new'").get().n, 1)
  assert.equal(db.prepare("SELECT role FROM member WHERE userId = 'new'").get().role, 'member')
  assert.equal((await join('owner', current)).status, 200)
  assert.equal(db.prepare("SELECT role FROM member WHERE userId = 'owner'").get().role, 'owner')
  assert.equal((await join('outsider', String((Number(current) + 1) % 10000).padStart(4,'0'))).status, 400)
  assert.equal(db.prepare("SELECT count(*) n FROM member WHERE userId = 'outsider'").get().n, 0)
})

test('attempt limits include unknown organizations and block the sixth account attempt', async () => {
  const { env, auth, request } = fixture()
  for (let i = 0; i < 6; i++) {
    const response = await organizationAccess(request('/api/auth/organization-access/join','POST', { name: 'missing', code: '0000' }), env, auth('new'), true)
    assert.equal(response.status, i === 5 ? 429 : 400)
    if (i === 5) assert.ok(Number(response.headers.get('retry-after')) > 0)
  }
})

test('expired codes and ambiguous organization names do not grant membership', async () => {
  const { db, env, auth, request, code } = fixture()
  let window = Math.floor(Date.now() / 1200000) - 1
  let expired = await accessCode(env.BETTER_AUTH_SECRET, 'org', window)
  while (expired === await code()) expired = await accessCode(env.BETTER_AUTH_SECRET, 'org', --window)
  const join = (name, value) => organizationAccess(request('/api/auth/organization-access/join','POST', { name, code:value }), env, auth('new'), true)
  assert.equal((await join('test-org', expired)).status, 400)
  db.prepare('INSERT INTO organization (id,name,slug,createdAt) VALUES (?,?,?,0)').run('duplicate','Test organization','other-org')
  assert.equal((await join('Test organization', await code())).status, 400)
  assert.equal((await join('test-org', await code())).status, 200)
})

test('organization and IP budgets hold across accounts, and reset in a new window', async () => {
  const { db, env, auth, request, code } = fixture()
  const window = Math.floor(Date.now() / 1200000)
  db.prepare('INSERT INTO organizationJoinAttempt VALUES (?,?,?)').run('org:org', window, 20)
  const join = () => organizationAccess(request('/api/auth/organization-access/join','POST', { name:'test-org', code:awaitCode }), env, auth('new'), true)
  const awaitCode = await code()
  assert.equal((await join()).status, 429)
  db.prepare('UPDATE organizationJoinAttempt SET window = ?').run(window - 1)
  assert.equal((await join()).status, 200)
  db.prepare('INSERT INTO organizationJoinAttempt VALUES (?,?,?)').run('ip:192.0.2.1', window, 20)
  const req = request('/api/auth/organization-access/join','POST', { name:'test-org', code:awaitCode })
  req.headers.set('cf-connecting-ip', '192.0.2.1')
  assert.equal((await organizationAccess(req, env, auth('outsider'), true)).status, 429)
})

test('join requires a session, verified email, and trusted origin', async () => {
  const { env, auth, request } = fixture()
  const req = () => request('/api/auth/organization-access/join','POST', { name:'test-org', code:'0000' })
  assert.equal((await organizationAccess(req(), env, auth(null), true)).status, 401)
  assert.equal((await organizationAccess(req(), env, auth('new','org',false), true)).status, 403)
  assert.equal((await organizationAccess(req(), env, auth('new'), false)).status, 403)
})
