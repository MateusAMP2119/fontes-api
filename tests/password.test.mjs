import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
// Run the production auth configuration with only database and email transport replaced.
const source=readFileSync(new URL('../worker/controllers/AuthController.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'').replace('database: env.APP_DB,','database: memoryAdapter(env.store),')
const prelude=`import { betterAuth } from '${import.meta.resolve('better-auth')}';
import { APIError } from '${import.meta.resolve('better-auth/api')}';
import { memoryAdapter } from '${import.meta.resolve('better-auth/adapters/memory')}';
import { jwt, organization, openAPI, emailOTP } from '${import.meta.resolve('better-auth/plugins')}';
import { createOAuthProxy } from '${new URL('../worker/oauth.ts',import.meta.url).href}';
const custom={info:{},paths:{},components:{securitySchemes:{}}};
const OrganizationModel=class {async firstFor(){return null}};
const OTP_SECONDS=600,RESET_SECONDS=3600,VERIFICATION_SECONDS=86400;
async function sendTransactionalEmail(env,email,content){env.messages.push({email,...content})}
`
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const {AuthController}=await import('data:text/javascript;base64,'+Buffer.from(prelude+js).toString('base64'))
const base='https://api.fonteslabs.com',origin='https://app.fonteslabs.com'
function fixture(){
 const env={BETTER_AUTH_URL:base,BETTER_AUTH_SECRET:'test-only-secret-with-more-than-thirty-two-characters',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',store:{user:[],account:[],session:[],verification:[],rateLimit:[],jwks:[]},messages:[]}
 const pending=[];const auth=new AuthController(env,{waitUntil:p=>pending.push(p)})
 const request=(path,body,cookie='')=>new Request(base+'/api/auth'+path,{method:body?'POST':'GET',headers:{origin,'content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined})
 return {env,auth,pending,request,call:(path,body,cookie)=>auth.handle(request(path,body,cookie))}
}
const cookies=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
test('production auth config supports OTP migration, password login, reset and single-use tokens',async()=>{
 const f=fixture(),email='migration@example.com'
 assert.equal((await f.call('/email-otp/send-verification-otp',{email,type:'sign-in'})).status,200)
 await Promise.all(f.pending)
 const code=f.env.messages.find(m=>m.kind==='sign-in').code
 const verified=await f.call('/sign-in/email-otp',{email,otp:code});assert.equal(verified.status,200)
 const cookie=cookies(verified),session=await f.auth.session(f.request('/get-session',undefined,cookie))
 assert.equal(session.user.emailVerified,true)
 await f.auth.setPassword(f.request('/unused',undefined,cookie),'first-password-123')
 assert.equal(f.env.store.user.length,1)
 const credential=f.env.store.account.find(a=>a.providerId==='credential');assert.ok(credential.password);assert.notEqual(credential.password,'first-password-123')
 await assert.rejects(f.auth.setPassword(f.request('/unused',undefined,cookie),'overwrite-password-123'))
 assert.equal((await f.call('/sign-in/email',{email,password:'wrong-password'})).status,401)
 const login=await f.call('/sign-in/email',{email,password:'first-password-123'});assert.equal(login.status,200)
 assert.equal((await f.call('/request-password-reset',{email,redirectTo:origin+'/reset-password'})).status,200)
 await Promise.all(f.pending)
 const reset=f.env.messages.find(m=>m.kind==='reset-link')
 const callback=await f.auth.handle(new Request(reset.url));assert.equal(callback.status,302)
 const token=new URL(callback.headers.get('location')).searchParams.get('token');assert.ok(token)
 assert.equal((await f.call('/reset-password',{token,newPassword:'second-password-456'})).status,200)
 assert.equal((await f.call('/reset-password',{token,newPassword:'third-password-789'})).status,400)
 assert.equal(f.env.store.session.length,0,'reset revokes existing sessions')
 assert.equal((await f.call('/sign-in/email',{email,password:'second-password-456'})).status,200)
 assert.equal(f.env.store.user.length,1,'migration and reset keep the same identity')
})
