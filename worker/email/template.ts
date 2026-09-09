import html0 from './emails/sign-in.html'
import copy0 from './emails/sign-in.json' with { type: 'json' }
import html1 from './emails/email-verification.html'
import copy1 from './emails/email-verification.json' with { type: 'json' }
import html2 from './emails/forget-password.html'
import copy2 from './emails/forget-password.json' with { type: 'json' }
import html3 from './emails/change-email.html'
import copy3 from './emails/change-email.json' with { type: 'json' }
import html4 from './emails/verify-link.html'
import copy4 from './emails/verify-link.json' with { type: 'json' }
import html5 from './emails/reset-link.html'
import copy5 from './emails/reset-link.json' with { type: 'json' }
import html6 from './emails/invite.html'
import copy6 from './emails/invite.json' with { type: 'json' }
export const TEMPLATE_PREFIX = 'transactional/pt-PT'
export const bundledTemplate = { messages: {
  'sign-in': { html: html0, copy: copy0 },
  'email-verification': { html: html1, copy: copy1 },
  'forget-password': { html: html2, copy: copy2 },
  'change-email': { html: html3, copy: copy3 },
  'verify-link': { html: html4, copy: copy4 },
  'reset-link': { html: html5, copy: copy5 },
  'invite': { html: html6, copy: copy6 }
} }
export type EmailTemplate = typeof bundledTemplate
export type EmailKind = keyof EmailTemplate['messages']
export function parseEmailPair(kind: EmailKind, html: string, value: unknown) {
  const fail = (): never => { throw new Error('Invalid email template pair') }
  if (!value || typeof value !== 'object' || !html.includes('<html') || html.length > 100000) return fail()
  const copy = value as typeof bundledTemplate.messages['sign-in']['copy']
  for (const key of Object.keys(bundledTemplate.messages[kind].copy) as Array<keyof typeof copy>) {
    const text = copy[key]
    if (typeof text !== 'string' || text.length > 10000 || text.includes('\u2014') || /(?<!\p{L})(tu|teu|tua|teus|tuas|introduz|entra|confirma|partilhes|ignora|você)(?!\p{L})/iu.test(text)) return fail()
    if (key !== 'text' && text.includes('{{')) return fail()
  }
  if (!copy.subject.trim() || /[\r\n]/.test(copy.subject)) return fail()
  const dynamic = ['verify-link', 'reset-link', 'invite'].includes(kind) ? 'url' : 'code'
  for (const body of [html, copy.text]) {
    const slots = [...body.matchAll(/\{\{(.*?)\}\}/g)].map(m => m[1])
    if (!slots.includes(dynamic) || slots.some(key => key !== dynamic && !Object.hasOwn(copy, key))) return fail()
  }
  return { html, copy }
}
