import app from './index'
import type { WorkerEnv } from './auth'

// This entrypoint is used ONLY by the generated local config. Production builds
// worker/index.ts, which contains neither an inbox nor a simulated mail transport.
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/__dev/mail') {
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      const { results } = await env.APP_DB.prepare('SELECT recipient, subject, text FROM authLocalMail ORDER BY createdAt DESC LIMIT 50').all<{ recipient: string; subject: string; text: string }>()
      if (request.headers.get('accept')?.includes('text/html')) {
        const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
        const messages = results.map(mail => `<article><h2>${escape(mail.subject)}</h2><p>${escape(mail.recipient)}</p><a href="${escape(mail.text)}">Abrir ligação</a></article>`).join('')
        return new Response(`<!doctype html><html lang="pt"><meta charset="utf-8"><title>Email local — Fontes</title><style>body{font:16px system-ui;max-width:720px;margin:48px auto;padding:20px}article{border-top:1px solid #ddd;padding:16px 0}h2{font-size:20px}</style><h1>Email local</h1><p>Estas mensagens ficam apenas neste computador.</p>${messages || '<p>Sem mensagens.</p>'}</html>`, {
          headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
        })
      }
      return Response.json(results, { headers: { 'cache-control': 'no-store' } })
    }
    const localEnv = {
      ...env,
      AUTH_EMAIL: {
        async send(message: EmailMessage | EmailMessageBuilder) {
          if (!('subject' in message) || typeof message.to !== 'string' || !message.text) {
            throw new Error('The local inbox requires a structured text email.')
          }
          const messageId = crypto.randomUUID()
          await env.APP_DB.prepare('INSERT INTO authLocalMail(id,recipient,subject,text,createdAt) VALUES(?,?,?,?,?)')
            .bind(messageId, message.to, message.subject, message.text, Date.now()).run()
          console.log(JSON.stringify({ event: 'local_email_captured', inbox: '/__dev/mail' }))
          return { messageId }
        },
      },
    }
    return app.fetch(request, localEnv, ctx)
  },
}
