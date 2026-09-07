import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migration-statements.mjs'

const migrations = readdirSync('migrations-auth').filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(`migrations-auth/${f}`, 'utf8'))

for (const runtime of ['SQLite', 'D1']) test(`user deletion rules in ${runtime}`, async t => {
  let exec, rows
  if (runtime === 'SQLite') {
    const db = new DatabaseSync(':memory:')
    t.after(() => db.close())
    db.exec('PRAGMA foreign_keys=ON')
    exec = async sql => { db.exec(sql) }
    rows = async sql => db.prepare(sql).all().map(row => ({ ...row }))
  } else {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("test") } }', compatibilityDate: '2026-09-07', d1Databases: ['DB'] }))
    t.after(() => mf.dispose())
    const db = await mf.getD1Database('DB')
    exec = async sql => { for (const statement of migrationStatements(sql)) await db.prepare(statement).run() }
    rows = async sql => (await db.prepare(sql).all()).results
  }
  for (const sql of migrations) await exec(sql)
  const count = async table => (await rows(`SELECT count(*) AS n FROM ${table}`))[0].n
  await exec(`
    INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('sole','Sole','sole@example.test',1,0,0);
    INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Owner','owner@example.test',1,0,0);
    INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('member','Member','member@example.test',1,0,0);
    INSERT INTO organization(id,name,slug,createdAt) VALUES('sole-org','Sole','sole',0);
    INSERT INTO organization(id,name,slug,createdAt) VALUES('shared-org','Shared','shared',0);
    INSERT INTO member VALUES('sole-member','sole-org','sole','owner',0);
    INSERT INTO member VALUES('owner-member','shared-org','owner','owner',0);
    INSERT INTO member VALUES('other-member','shared-org','member','member',0);
    INSERT INTO project(id,organizationId,name,createdAt,ownerId,visibility) VALUES('sole-private','sole-org','Private',0,'sole','private');
    INSERT INTO project(id,organizationId,name,createdAt,ownerId,visibility) VALUES('sole-public','sole-org','Public',0,'sole','public');
    INSERT INTO project(id,organizationId,name,createdAt,ownerId,visibility) VALUES('shared-private','shared-org','Private',0,'owner','private');
    INSERT INTO project(id,organizationId,name,createdAt,ownerId,visibility) VALUES('shared-public','shared-org','Public',0,'owner','public');
    INSERT INTO session(id,token,userId,createdAt,updatedAt,expiresAt,activeOrganizationId) VALUES('s','tok','sole',0,0,9999999999999,'sole-org');
    INSERT INTO session(id,token,userId,createdAt,updatedAt,expiresAt,activeOrganizationId) VALUES('m','tok2','member',0,0,9999999999999,'sole-org');
    INSERT INTO account(id,issuer,accountId,providerId,userId,createdAt,updatedAt) VALUES('a','local:credential','sole','credential','sole',0,0);
    INSERT INTO authToken(hash,kind,value,expiresAt) VALUES('verify','verify','{"userId":"sole"}',9999999999999);
    INSERT INTO authToken(hash,kind,value,expiresAt) VALUES('reset','reset','{"userId":"sole"}',9999999999999);
    INSERT INTO authToken(hash,kind,value,expiresAt) VALUES('other','verify','{"userId":"member"}',9999999999999);
    INSERT INTO invitation VALUES('invite','sole-org','invite@example.test','member','pending',9999999999999,0,'sole');
  `)
  // Direct Studio-style DELETE must behave exactly like an application deletion.
  await exec("DELETE FROM user WHERE id='sole';")
  assert.equal(await count('organization'), 1)
  assert.equal(await count('project'), 2)
  assert.equal(await count('account'), 0)
  assert.equal(await count('invitation'), 0)
  assert.equal(await count('authToken'), 1)
  assert.deepEqual(await rows("SELECT activeOrganizationId FROM session WHERE id='m'"), [{ activeOrganizationId: null }])
  // Shared data must be untouched if the last owner has not transferred ownership.
  await assert.rejects(exec("DELETE FROM user WHERE id='owner';"), /TRANSFER_ORGANIZATION_OWNERSHIP/)
  assert.equal(await count('project'), 2)
  assert.equal(await count('user'), 2)
  await exec("UPDATE member SET role='owner' WHERE id='other-member';")
  await exec("DELETE FROM user WHERE id='owner';")
  assert.deepEqual(await rows('SELECT id,ownerId FROM project'), [{ id: 'shared-public', ownerId: null }])
  assert.equal(await count('organization'), 1)
  await exec("DELETE FROM user WHERE id='member';")
  assert.equal(await count('organization'), 0)
  assert.equal(await count('project'), 0)
  assert.equal(await count('session'), 0)
  assert.equal(await count('member'), 0)
  assert.equal(await count('authToken'), 0)
  assert.deepEqual(await rows('PRAGMA foreign_key_check'), [])
  // The existing organization API removes memberships before its parent row.
  await exec(`
    INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('a','A','a@example.test',1,0,0);
    INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('b','B','b@example.test',1,0,0);
    INSERT INTO organization(id,name,slug,createdAt) VALUES('org','Org','org',0);
    INSERT INTO member VALUES('a','org','a','owner',0);
    INSERT INTO member VALUES('b','org','b','member',0);
    DELETE FROM member WHERE organizationId='org';
    DELETE FROM organization WHERE id='org';
  `)
  assert.equal(await count('member'), 0)
  assert.equal(await count('user'), 2)
})
