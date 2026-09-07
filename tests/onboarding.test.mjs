import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
// Execute the controller and its real SQL with an in-memory SQLite D1 adapter.
// Only the auth boundary and email transport are replaced; no network is used.
const source = readFileSync(new URL('../worker/controllers/OnboardingController.ts', import.meta.url), 'utf8').replace(/^import .*\n/gm, '')
const model = readFileSync(new URL('../worker/models/ProjectModel.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(`const AuthController = { isTrustedOrigin: (origin: string) => origin === 'https://app.fonteslabs.com' };\n${model}\n${source}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { OnboardingController } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
function fixture() {
 const sql = new DatabaseSync(':memory:')
 sql.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE user(id TEXT PRIMARY KEY, name TEXT, image TEXT, updatedAt INTEGER);
 CREATE TABLE organization(id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, createdAt INTEGER);
 CREATE TABLE member(id TEXT PRIMARY KEY, organizationId TEXT REFERENCES organization(id), userId TEXT REFERENCES user(id), role TEXT, createdAt INTEGER);
 CREATE TABLE project(id TEXT PRIMARY KEY, organizationId TEXT REFERENCES organization(id), name TEXT, createdAt TEXT, ownerId TEXT, visibility TEXT);
 CREATE TABLE session(id TEXT PRIMARY KEY, userId TEXT, activeOrganizationId TEXT);
 INSERT INTO user VALUES ('u','User',NULL,0),('v','Visitor',NULL,0);
 INSERT INTO session VALUES ('s','u',NULL),('sv','v',NULL);`)
 sql.exec(readFileSync(new URL('../migrations/0001_onboarding.sql',import.meta.url),'utf8'))
 const db = { prepare(query) { let values=[]; return { bind(...args){values=args;return this}, async first(){return sql.prepare(query).get(...values)??null},async all(){return {results:sql.prepare(query).all(...values)}},async run(){return sql.prepare(query).run(...values)} } }, async batch(statements){sql.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.run());sql.exec('COMMIT');return rows}catch(error){sql.exec('ROLLBACK');throw error}} }
 let identity={user:{id:'u',email:'u@example.com',emailVerified:true},session:{id:'s',activeOrganizationId:null}}
 const emails=[]
 const controller=new OnboardingController({APP_DB:db,AUTH_EMAIL:{send:async email=>emails.push(email)}},{session:async()=>identity})
 const call=(path='',body,origin='https://app.fonteslabs.com')=>controller.handle(new Request('https://api.fonteslabs.com/api/onboarding'+path,{method:body?'POST':'GET',headers:{origin,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}))
 const setup={operationId:'operation-first',revision:1,name:'Fontes',slug:'fontes-team',profileName:'Mateus',completed:true,changelog:true,daily:false}
 return {sql,call,setup,emails,identity:value=>{identity=value}}
}
test('atomic setup, idempotent retries, stale rejection and default project',async()=>{
 const f=fixture();assert.equal((await f.call('',f.setup)).status,200);assert.equal((await f.call('',f.setup)).status,200)
 assert.equal(f.sql.prepare('SELECT count(*) n FROM organization').get().n,1);assert.equal(f.sql.prepare('SELECT count(*) n FROM project').get().n,1)
 assert.equal((await f.call('',{...f.setup,operationId:'different-operation'})).status,409)
 const state=await (await f.call()).json();assert.equal(state.completed,true);assert.equal(state.changelog,true);assert.equal(state.profile.name,'Mateus')
 f.sql.close()
})
test('URL conflict does not leave partial onboarding data',async()=>{
 const f=fixture();f.sql.exec("INSERT INTO organization VALUES ('other','Other','fontes-team',0)")
 assert.equal((await f.call('',f.setup)).status,409);assert.equal(f.sql.prepare('SELECT count(*) n FROM onboarding').get().n,0);f.sql.close()
})
test('verified sessions and trusted origins are required; revoked membership cannot be restored',async()=>{
 const f=fixture();assert.equal((await f.call('',f.setup,'https://evil.example')).status,403)
 await f.call('',f.setup);f.sql.exec('DELETE FROM member');assert.equal((await f.call('',{...f.setup,revision:2,operationId:'operation-second'})).status,403)
 f.identity(null);assert.equal((await f.call()).status,401);f.sql.close()
})
test('invites use hashed tokens, repeat sends are deduplicated and email is bound on acceptance',async()=>{
 const f=fixture();await f.call('',f.setup);const token='ab'.repeat(32)
 const body={token,email:'v@example.com',organizationId:'onboarding_u'}
 assert.equal((await f.call('/invite',body)).status,200);assert.equal((await f.call('/invite',body)).status,200);assert.equal(f.emails.length,1)
 assert.notEqual(f.sql.prepare('SELECT tokenHash FROM onboardingInvite').get().tokenHash,token)
 assert.equal((await f.call('/join',{token})).status,403)
 f.identity({user:{id:'v',email:'v@example.com',emailVerified:true},session:{id:'sv',activeOrganizationId:null}})
 assert.equal((await f.call('/join',{token})).status,200);assert.equal((await f.call('/join',{token})).status,200)
 assert.equal(f.sql.prepare("SELECT count(*) n FROM member WHERE userId='v'").get().n,1)
 f.sql.exec('UPDATE onboardingInvite SET expiresAt=0');assert.equal((await f.call('/join',{token})).status,403);f.sql.close()
})
