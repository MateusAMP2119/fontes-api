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
