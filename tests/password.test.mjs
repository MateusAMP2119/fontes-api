import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, cookies, origin } from './helpers/auth.mjs'
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
 const loggedIn=await f.call('/sign-in/email',{email,password:'second-password-456'})
 const changed=await f.call('/change-password',{currentPassword:'second-password-456',newPassword:'third-password-789',revokeOtherSessions:true},cookies(loggedIn))
 assert.equal(changed.status,200)
 assert.equal((await f.call('/sign-in/email',{email,password:'third-password-789'})).status,200)
})
