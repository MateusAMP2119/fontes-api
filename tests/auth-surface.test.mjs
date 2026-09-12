import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, cookies } from './helpers/auth.mjs'

test('unused Better Auth routes are unavailable, including authenticated callers', async () => {
  const f = fixture()
  const email = 'surface@example.com'
  await f.call('/email-otp/send-verification-otp', {email, type: 'sign-in'})
  await Promise.all(f.pending)
  const signedIn = await f.call('/sign-in/email-otp', {email, otp: f.env.messages[0].code})
  assert.equal(signedIn.status, 200)
  const cookie = cookies(signedIn)
  const removed = [
    'sign-up/email', 'verify-password', 'send-verification-email', 'change-email',
    'update-session', 'update-user', 'delete-user', 'delete-user/callback',
    'list-sessions', 'revoke-session', 'revoke-sessions', 'revoke-other-sessions',
    'link-social', 'list-accounts', 'unlink-account', 'refresh-token', 'get-access-token',
    'account-info', 'ok', 'health', 'token', '.well-known/jwks.json',
    'open-api/generate-schema', 'reference', 'docs', 'openapi.json',
    'email-otp/check-verification-otp', 'email-otp/verify-email',
    'email-otp/request-password-reset', 'forget-password/email-otp', 'email-otp/reset-password',
    'email-otp/request-email-change', 'email-otp/change-email',
    'organization-access/code', 'organization-access/join',
    ...['create', 'update', 'delete', 'set-active', 'get-organization', 'get-full-organization',
      'list', 'invite-member', 'cancel-invitation', 'accept-invitation', 'get-invitation',
      'reject-invitation', 'list-invitations', 'get-active-member', 'check-slug',
      'remove-member', 'update-member-role', 'leave', 'list-user-invitations',
      'list-members', 'get-active-member-role', 'has-permission'].map(path => `organization/${path}`),
  ]
  for (const path of removed) {
    for (const body of [undefined, {}]) {
      assert.equal((await f.call('/' + path, body, cookie)).status, 404, path)
    }
  }
  assert.equal(f.env.store.user.length, 1)
  assert.equal(f.env.store.session.length, 1)
  assert.equal(f.env.messages.length, 1)
})

test('session workspace field survives plugin removal and cannot be supplied by login', async () => {
  const f = fixture({APP_DB: {activeOrganizationId: 'saved-workspace'}})
  const email = 'workspace@example.com'
  await f.call('/email-otp/send-verification-otp', {email, type: 'sign-in'})
  await Promise.all(f.pending)
  const signedIn = await f.call('/sign-in/email-otp', {
    email, otp: f.env.messages[0].code, activeOrganizationId: 'injected-workspace',
  })
  assert.equal(signedIn.status, 200)
  const cookie = cookies(signedIn)
  const response = await f.call('/get-session', undefined, cookie)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).session.activeOrganizationId, 'saved-workspace')
  assert.equal(f.env.store.session[0].activeOrganizationId, 'saved-workspace')
  assert.equal((await f.call('/get-session', {}, cookie)).status, 405)
  assert.equal((await f.call('/sign-out', {}, cookie)).status, 200)
  assert.equal(await (await f.call('/get-session', undefined, cookie)).json(), null)
})

test('email codes create only new accounts, never another session for an existing user', async () => {
  const f = fixture()
  const email = 'register-only@example.com'
  for (const type of ['email-verification','forget-password','change-email']) {
    const rejected=fixture()
    assert.equal((await rejected.call('/email-otp/send-verification-otp', {email,type})).status,400)
    assert.equal(rejected.env.messages.length,0)
  }
  assert.equal(f.env.messages.length,0)
  assert.equal((await f.call('/email-otp/send-verification-otp', {email,type:'sign-in'})).status,200)
  await Promise.all(f.pending)
  const otp = f.env.messages[0].code
  const created = await f.call('/sign-in/email-otp',{email,otp})
  assert.equal(created.status,200)
  assert.ok((await created.clone().json()).token)
  const existing = async () => {
    f.env.store.rateLimit.length=0 // Isolate authorization from the send-code rate limit.
    for (const [path,body] of [['/email-otp/send-verification-otp',{email:email.toUpperCase(),type:'sign-in'}],['/sign-in/email-otp',{email,otp}]]) {
      const response = await f.call(path,body)
      assert.equal(response.status,400)
      assert.equal((await response.json()).code,'REGISTRATION_ACCOUNT_EXISTS')
      assert.equal(response.headers.get('set-auth-token'),null)
    }
  }
  await existing() // Even an unfinished account without a password cannot use OTP login.
  await f.auth.setPassword(f.request('/unused',undefined,cookies(created)),'registration-password')
  await existing()
  f.env.store.user[0].emailVerified = false
  await existing()
  assert.equal(f.env.messages.length,1)
  assert.equal(f.env.store.session.length,1)
  f.env.store.user[0].emailVerified = true
  assert.equal((await f.call('/sign-in/email',{email,password:'registration-password'})).status,200)
})

test('an account created during registration verification cannot receive an OTP login session', async () => {
  const f=fixture(), email='registration-race@example.com'
  await f.call('/email-otp/send-verification-otp',{email,type:'sign-in'})
  await Promise.all(f.pending)
  const context=await f.auth.auth.$context
  await context.internalAdapter.createUser({email,name:'Existing Google user',emailVerified:true})
  const find=context.internalAdapter.findUserByEmail.bind(context.internalAdapter)
  let lookups=0
  context.internalAdapter.findUserByEmail=async (...args)=>++lookups===1?null:find(...args)
  const response=await f.call('/sign-in/email-otp',{email,otp:f.env.messages[0].code})
  assert.equal(response.status,400)
  assert.equal((await response.json()).code,'REGISTRATION_ACCOUNT_EXISTS')
  assert.equal(f.env.store.session.length,0)
})

test('an unfinished registration can establish a password through email recovery', async () => {
  const f=fixture(),email='unfinished@example.com'
  await f.call('/email-otp/send-verification-otp',{email,type:'sign-in'})
  await Promise.all(f.pending)
  const created=await f.call('/sign-in/email-otp',{email,otp:f.env.messages[0].code})
  await f.call('/sign-out',{},cookies(created))
  assert.equal((await f.call('/request-password-reset',{email,redirectTo:'https://app.fonteslabs.com/reset-password'})).status,200)
  await Promise.all(f.pending)
  const reset=f.env.messages.find(message=>message.kind==='reset-link')
  const redirect=await f.auth.handle(new Request(reset.url))
  const token=new URL(redirect.headers.get('location')).searchParams.get('token')
  assert.equal((await f.call('/reset-password',{token,newPassword:'recovered-password'})).status,200)
  assert.equal((await f.call('/sign-in/email',{email,password:'recovered-password'})).status,200)
  assert.equal(f.env.store.user.length,1)
})

test('registration defaults usernames from compact lowercase names and resolves duplicates',async()=>{
 const f=fixture()
 for (const [email,name,expected] of [['name-one@example.com','Mateus Costa','mateuscosta'],['name-two@example.com','Mateus Costa','mateuscosta2'],['name-three@example.com','João da Silva','joaodasilva']]) {
  f.env.store.rateLimit=[]
  await f.call('/email-otp/send-verification-otp',{email,type:'sign-in'});await Promise.all(f.pending)
  const response=await f.call('/sign-in/email-otp',{email,name,otp:f.env.messages.find(m=>m.email===email).code})
  assert.equal(response.status,200)
  assert.equal((await response.json()).user.username,expected)
 }
})
