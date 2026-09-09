import { EmailMessage } from 'cloudflare:email'
import { createMimeMessage } from 'mimetext/browser'
import { bundledTemplate, parseEmailPair, TEMPLATE_PREFIX, type EmailTemplate } from './template.ts'

export const OTP_SECONDS = 600
export const RESET_SECONDS = 3600
export const VERIFICATION_SECONDS = 86400
export const INVITE_SECONDS = 7 * 86400

export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email'
export type EmailContent =
  | { kind: OtpPurpose; code: string }
  | { kind: 'verify-link' | 'reset-link' | 'invite'; url: string }
type EmailEnv = Pick<AuthBindings, 'AUTH_EMAIL' | 'EMAIL_TEMPLATES'>

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

function fill(template: string, slots: Record<string, string>) {
  return template.replace(/\{\{(.*?)\}\}/g, (_, key: string) => {
    if (!(key in slots)) throw new Error('Unknown email layout slot')
    return slots[key]
  })
}

export function renderEmail(content: EmailContent, template: EmailTemplate = bundledTemplate) {
  const email = template.messages[content.kind]
  let slots: Record<string, string>
  let textSlots: Record<string, string>
  if ('code' in content) {
    if (!/^\d{6}$/.test(content.code)) throw new Error('Invalid email code')
    slots = textSlots = { code: content.code }
  } else {
    const url = new URL(content.url)
    const allowed = url.protocol === 'https:' && ['api.fonteslabs.com', 'builder.fonteslabs.com', 'app.fonteslabs.com'].includes(url.hostname)
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    if ((!allowed && !local) || url.username || url.password) throw new Error('Invalid email action URL')
    slots = { url: escapeHtml(url.href) }
    textSlots = { url: url.href }
  }
  return {
    subject: email.copy.subject,
    html: fill(email.html.replaceAll('cid:fontes-header', 'https://api.fonteslabs.com/email-assets/header.png').replaceAll('cid:fontes-footer', 'https://api.fonteslabs.com/email-assets/footer.png'), { ...Object.fromEntries(Object.entries(email.copy).map(([key, value]) => [key, escapeHtml(value).replaceAll("\n", "<br>")])), ...slots }),
    text: fill(email.copy.text, { ...email.copy, ...textSlots }),

  }
}

// Preserve UTF-8 wording in the plain-text and HTML alternatives.
export function buildRawEmail(to: string, email: ReturnType<typeof renderEmail>) {
  if (/[\r\n]/.test(to)) throw new Error('Invalid email recipient')
  const message = createMimeMessage()
  message.setSender({ name: 'Fontes', addr: 'conta@fonteslabs.com' })
  message.setRecipient(to)
  message.setSubject(email.subject)
  const base64 = (bytes: Uint8Array) => {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).match(/.{1,76}/g)!.join('\r\n')
  }
  for (const [contentType, body] of [['text/plain', email.text], ['text/html', email.html]]) {
    message.addMessage({ contentType: contentType as 'text/plain' | 'text/html', encoding: 'base64', data: base64(new TextEncoder().encode(body)) })
  }
  return message.asRaw()
}

export async function sendTransactionalEmail(env: EmailEnv, to: string, content: EmailContent) {
  let template = bundledTemplate
  try {
    const keys = [`${TEMPLATE_PREFIX}/${content.kind}.html`, `${TEMPLATE_PREFIX}/${content.kind}.json`]
    const objects = await Promise.all(keys.map(key => env.EMAIL_TEMPLATES.get(key)))
    if (objects.some(object => !object || object.size > 100000)) throw new Error('Missing or oversized email asset')
    const [html, copy] = await Promise.all([
      objects[0]!.text(), objects[1]!.json(),
    ])
    const pair = parseEmailPair(content.kind, html, copy)
    template = { messages: { ...bundledTemplate.messages, [content.kind]: pair } }
  } catch {
    console.warn(JSON.stringify({ event: 'email_template_fallback' }))
  }
  try {
    const raw = buildRawEmail(to, renderEmail(content, template))
    const result = await env.AUTH_EMAIL.send(new EmailMessage('conta@fonteslabs.com', to, raw))
    console.info(JSON.stringify({ event: 'email_accepted', kind: content.kind, messageId: result.messageId }))
    return result
  } catch (error) {
    console.error(JSON.stringify({ event: 'email_send_failed', kind: content.kind }))
    throw error
  }
}
