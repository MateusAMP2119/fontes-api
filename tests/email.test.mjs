import PostalMime from 'postal-mime'
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { bundledTemplate, parseEmailPair, TEMPLATE_PREFIX } from '../worker/email/template.ts'
import { renderEmail, sendTransactionalEmail, buildRawEmail } from '../worker/email/send.ts'

const purposes = ['sign-in', 'email-verification', 'forget-password', 'change-email']
for (const kind of purposes) {
  test(`${kind}: HTML and text have the same code, purpose, expiry, and safety copy`, () => {
    const email = renderEmail({ kind, code: '012345' })
    assert.equal(email.subject, bundledTemplate.messages[kind].copy.subject)
    for (const body of [email.html, email.text]) {
      assert.ok(body.includes('012345'))
      assert.ok(body.includes('10 minutos'))
      assert.ok(body.includes('não deve ser partilhado'))
      assert.ok(!body.includes('{{'))
    }
    assert.ok(!email.subject.includes('012345'))
    assert.equal((email.html.match(/href=/g) ?? []).length, 1) // Brand link only; the code stays selectable text.
    assert.ok(!('attachments' in email))
    assert.ok(email.html.includes('https://api.fonteslabs.com/email-assets/header.png'))
  })
}

test('link messages retain complete URLs and escape HTML attributes', () => {
  for (const kind of ['verify-link', 'reset-link', 'invite']) {
    const url = 'https://api.fonteslabs.com/api/auth/verify-email?token=test&callbackURL=https%3A%2F%2Fapp.fonteslabs.com'
    const email = renderEmail({ kind, url })
    assert.ok(email.text.includes(url))
    assert.ok(email.html.includes('token=test&amp;callbackURL='))
    assert.equal((email.html.match(/href=/g) ?? []).length, 3)
    assert.ok(!email.html.includes('{{'))
  }
})

test('unsafe actions and malformed codes cannot be rendered', () => {
  for (const url of ['javascript:alert(1)', 'https://evil.example/', 'https://api.fonteslabs.com.evil.example/', 'https://user:pass@api.fonteslabs.com/', 'http://api.fonteslabs.com/']) {
    assert.throws(() => renderEmail({ kind: 'reset-link', url }))
  }
  for (const code of ['12345', '1234567', '<img>', '123 45']) assert.throws(() => renderEmail({ kind: 'sign-in', code }))
  assert.doesNotThrow(() => renderEmail({ kind: 'verify-link', url: 'http://localhost:8788/api/auth/verify-email?token=test' }))
})


function fixture() {
 const sent = []
 const pair = structuredClone(bundledTemplate.messages['sign-in'])
 return { sent, pair, env: {
  EMAIL_TEMPLATES: { async get(key) {
   assert.ok(key === `${TEMPLATE_PREFIX}/sign-in.html` || key === `${TEMPLATE_PREFIX}/sign-in.json`)
   return { size: 20000, text: async () => pair.html, json: async () => pair.copy }
  } },
  AUTH_EMAIL: { async send(message) { sent.push(message); return { messageId: 'test-message' } } }
 } }
}
test('R2 HTML and JSON pair supplies updated wording without deployment', async () => {
 const f = fixture()
 f.pair.copy.body = 'Código de acesso temporário.'
 await sendTransactionalEmail(f.env, 'person@example.com', { kind: 'sign-in', code: '012345' })
 assert.ok((await PostalMime.parse(f.sent[0].raw)).html.includes('Código de acesso temporário.'))
 assert.ok((await PostalMime.parse(f.sent[0].raw)).html.includes('012345'))
})
test('all pairs validate and reject missing runtime slots and direct address', () => {
 for (const [kind, pair] of Object.entries(bundledTemplate.messages)) {
  assert.doesNotThrow(() => parseEmailPair(kind, pair.html, pair.copy))
  assert.throws(() => parseEmailPair(kind, '<html>{{unknown}}</html>', pair.copy))
  assert.throws(() => parseEmailPair(kind, pair.html, { ...pair.copy, body: 'Introduz o teu código' }))
 }
})
test('missing R2 assets fall back to the bundled design', async () => {
 const f = fixture(); f.env.EMAIL_TEMPLATES.get = async () => null
 await sendTransactionalEmail(f.env, 'person@example.com', { kind: 'sign-in', code: '012345' })
 assert.equal((await PostalMime.parse(f.sent[0].raw)).html.replace(/cid:(fontes-(?:header|footer))\.[^" ]+@fonteslabs\.com/g, 'cid:$1'), renderEmail({ kind: 'sign-in', code: '012345' }).html)
})
test('provider failures propagate without a duplicate send', async () => {
 const f = fixture(); let calls = 0
 f.env.AUTH_EMAIL.send = async () => { calls++; throw new Error('provider failure') }
 await assert.rejects(sendTransactionalEmail(f.env, 'person@example.com', { kind: 'sign-in', code: '012345' }))
 assert.equal(calls, 1)
})

test('email layout avoids percentage padding and fixed image heights', () => {
 for (const {html} of Object.values(bundledTemplate.messages)) {
  assert.ok(!html.includes('padding-bottom:20%'))
  assert.ok(!html.includes('display:block;height:0'))
  assert.ok(!/<img[^>]+height="/.test(html))
 }
})
test('all email messages use public images with zero MIME attachments', async () => {
 for (const kind of Object.keys(bundledTemplate.messages)) {
  const content = purposes.includes(kind) ? { kind, code: '012345' } : { kind, url: 'https://app.fonteslabs.com/?token=test' }
  const rendered = renderEmail(content)
  const parsed = await PostalMime.parse(buildRawEmail('person@example.com', rendered))
  assert.equal(parsed.attachments.length, 0)
  assert.equal(parsed.html, rendered.html)
  assert.equal(parsed.text, rendered.text)
  assert.ok(!parsed.html.includes('cid:'))
  for (const name of ['header', 'footer']) assert.ok(parsed.html.includes(`https://api.fonteslabs.com/email-assets/${name}.png`))
 }
})
