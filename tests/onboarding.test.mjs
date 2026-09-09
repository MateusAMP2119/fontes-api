import PostalMime from 'postal-mime'
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
const emailImport = `import { sendTransactionalEmail, INVITE_SECONDS } from '${new URL('../worker/email/send.ts', import.meta.url).href}';\n`
const { OnboardingController } = await import('data:text/javascript;base64,' + Buffer.from(emailImport + js).toString('base64'))
function fixture() {
 const sql = new DatabaseSync(':memory:')
 sql.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE user(id TEXT PRIMARY KEY, name TEXT, image TEXT, updatedAt INTEGER);
 CREATE TABLE account(id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, password TEXT);
 INSERT INTO account VALUES ('au','u','credential','test-hash'),('av','v','credential','test-hash');
 CREATE TABLE organization(id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, createdAt INTEGER);
 CREATE TABLE member(id TEXT PRIMARY KEY, organizationId TEXT REFERENCES organization(id), userId TEXT REFERENCES user(id), role TEXT, createdAt INTEGER);
 CREATE TABLE project(id TEXT PRIMARY KEY, organizationId TEXT REFERENCES organization(id), name TEXT, createdAt TEXT, ownerId TEXT, visibility TEXT);
 CREATE TABLE session(id TEXT PRIMARY KEY, userId TEXT, activeOrganizationId TEXT);
 INSERT INTO user VALUES ('u','User',NULL,0),('v','Visitor',NULL,0);
 INSERT INTO session VALUES ('s','u',NULL),('sv','v',NULL);`)
 sql.exec(readFileSync(new URL('../migrations/0001_onboarding.sql',import.meta.url),'utf8'))
 const db = { prepare(query) { let values=[]; return { bind(...args){values=args;return this}, async first(){return sql.prepare(query).get(...values)??null},async all(){return {results:sql.prepare(query).all(...values)}},async run(){return sql.prepare(query).run(...values)} } }, async batch(statements){sql.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.run());sql.exec('COMMIT');return rows}catch(error){sql.exec('ROLLBACK');throw error}} }
 let identity={user:{id:'u',email:'u@example.com',emailVerified:true},session:{id:'s',activeOrganizationId:null,createdAt:new Date().toISOString()}}
 const emails=[]
 const controller=new OnboardingController({APP_DB:db,AUTH_EMAIL:{send:async email=>{emails.push(email);return {messageId:'test-invite'}}}},{session:async()=>identity,setPassword:async(request,password)=>{const existing=sql.prepare("SELECT id FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL").get(identity.user.id);if(existing)throw Error('already set');sql.prepare("INSERT INTO account VALUES (?,?,'credential',?)").run('new-'+identity.user.id,identity.user.id,'hashed-in-auth-boundary')}})
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
 const delivered = await PostalMime.parse(f.emails[0].raw)
 assert.ok(delivered.html.includes(`https://app.fonteslabs.com/?invite=${token}`));assert.ok(delivered.text.includes('7 dias'))
 assert.notEqual(f.sql.prepare('SELECT tokenHash FROM onboardingInvite').get().tokenHash,token)
 assert.equal((await f.call('/join',{token})).status,403)
 f.identity({user:{id:'v',email:'v@example.com',emailVerified:true},session:{id:'sv',activeOrganizationId:null}})
 assert.equal((await f.call('/join',{token})).status,200);assert.equal((await f.call('/join',{token})).status,200)
 assert.equal(f.sql.prepare("SELECT count(*) n FROM member WHERE userId='v'").get().n,1)
 f.sql.exec('UPDATE onboardingInvite SET expiresAt=0');assert.equal((await f.call('/join',{token})).status,403);f.sql.close()
})

test('email users require password setup; verified fresh session sets it once',async()=>{
 const f=fixture();f.sql.exec("DELETE FROM account WHERE userId='u'")
 assert.equal((await (await f.call()).json()).passwordRequired,true)
 assert.equal((await f.call('',f.setup)).status,400)
 assert.equal((await f.call('/password',{newPassword:'short'})).status,400)
 assert.equal((await f.call('/password',{newPassword:'valid-password-123'})).status,200)
 assert.equal((await (await f.call()).json()).passwordRequired,false)
 assert.equal((await f.call('/password',{newPassword:'replacement-password'})).status,409)
 assert.equal((await f.call('',f.setup)).status,200)
 f.identity({user:{id:'u',email:'u@example.com',emailVerified:true},session:{id:'s',createdAt:'2020-01-01'}})
 assert.equal((await f.call('/password',{newPassword:'valid-password-123'})).status,401)
 f.sql.close()
})
test('Google-only accounts do not require a password',async()=>{
 const f=fixture();f.sql.exec("UPDATE account SET providerId='google',password=NULL")
 assert.equal((await (await f.call()).json()).passwordRequired,false);f.sql.close()
})
test('profile image persists and explicit removal clears it',async()=>{
 const f=fixture();const image='data:image/webp;base64,AAAA'
 assert.equal((await f.call('',{...f.setup,profileImage:image})).status,200)
 assert.equal((await (await f.call()).json()).profile.image,image)
 assert.equal((await f.call('',{...f.setup,revision:2,operationId:'clear-image-operation',profileImage:''})).status,200)
 assert.equal((await (await f.call()).json()).profile.image,null)
 assert.equal((await f.call('',{...f.setup,revision:3,profileImage:'javascript:bad'})).status,400);f.sql.close()
})
test('invitation review never joins; member setup cannot rename a workspace',async()=>{
 const f=fixture();await f.call('',f.setup);const token='cd'.repeat(32)
 await f.call('/invite',{token,email:'v@example.com',organizationId:'onboarding_u'})
 f.identity({user:{id:'v',email:'v@example.com',emailVerified:true},session:{id:'sv',activeOrganizationId:null}})
 const review=await f.call('/invitation',{token});assert.equal(review.status,200);assert.equal((await review.json()).name,'Fontes')
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM member WHERE userId='v'").get().n,0)
 await f.call('/join',{token})
 const state=await (await f.call()).json();assert.equal(state.canInvite,false);assert.equal(state.canEditWorkspace,false)
 assert.equal((await f.call('',{...f.setup,name:'Hijacked',slug:'hijacked-url'})).status,200)
 assert.equal(f.sql.prepare("SELECT name FROM organization WHERE id='onboarding_u'").get().name,'Fontes')
 assert.equal((await f.call('/invite',{token:'ef'.repeat(32),email:null,organizationId:'onboarding_u'})).status,403)
 f.sql.close()
})
test('creator revocation invalidates invitation review and acceptance',async()=>{
 const f=fixture();await f.call('',f.setup);const token='ef'.repeat(32)
 await f.call('/invite',{token,email:null,organizationId:'onboarding_u'})
 f.sql.exec("DELETE FROM member WHERE userId='u'")
 assert.equal((await f.call('/invitation',{token})).status,403)
 assert.equal((await f.call('/join',{token})).status,403);f.sql.close()
})

test('existing admin retains role when editing setup; expired links cannot report ready',async()=>{
 const f=fixture();await f.call('',f.setup)
 f.sql.exec("INSERT INTO member VALUES ('admin_v','onboarding_u','v','admin',0)")
 f.identity({user:{id:'v',email:'v@example.com',emailVerified:true},session:{id:'sv',activeOrganizationId:'onboarding_u'}})
 assert.equal((await f.call('',{...f.setup,name:'Edited'})).status,200)
 const members=f.sql.prepare("SELECT role FROM member WHERE userId='v'").all();assert.deepEqual(members.map(m=>m.role),['admin'])
 const token='aa'.repeat(32);const invite={token,email:null,organizationId:'onboarding_u'}
 assert.equal((await f.call('/invite',invite)).status,200);f.sql.exec('UPDATE onboardingInvite SET expiresAt=0')
 assert.equal((await f.call('/invite',invite)).status,410);f.sql.close()
})

test('queued setup cannot modify a different active workspace',async()=>{
 const f=fixture();await f.call('',f.setup)
 const response=await f.call('',{...f.setup,revision:2,operationId:'wrong-workspace-operation',organizationId:'another-workspace',name:'Wrong'})
 assert.equal(response.status,409);assert.equal((await response.json()).conflict,true)
 assert.equal(f.sql.prepare("SELECT name FROM organization WHERE id='onboarding_u'").get().name,'Fontes');f.sql.close()
})

test('availability uses exact URLs, authenticates and never creates workspace data',async()=>{
 const f=fixture()
 assert.deepEqual(await (await f.call('/availability',{slug:'fontes-team'})).json(),{available:true})
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM organization').get().n,0)
 assert.equal((await f.call('/availability',{slug:'fo%'})).status,400)
 assert.equal((await f.call('/availability',{slug:'fontes-team'},'https://evil.example')).status,403)
 await f.call('',f.setup)
 assert.deepEqual(await (await f.call('/availability',{slug:'fontes-team'})).json(),{available:false})
 assert.deepEqual(await (await f.call('/availability',{slug:'fontes-tea'})).json(),{available:true})
 assert.deepEqual(await (await f.call('/availability',{slug:'fontes-team',organizationId:'onboarding_u'})).json(),{available:true})
 f.identity({user:{id:'v',email:'v@example.com',emailVerified:true},session:{id:'sv'}})
 assert.deepEqual(await (await f.call('/availability',{slug:'fontes-team',organizationId:'onboarding_u'})).json(),{available:false})
 f.identity(null);assert.equal((await f.call('/availability',{slug:'fontes-team'})).status,401)
 f.sql.close()
})
