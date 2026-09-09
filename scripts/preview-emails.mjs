import { mkdir, writeFile } from 'node:fs/promises'
import { bundledTemplate } from '../worker/email/template.ts'
const messages = bundledTemplate.messages
import { renderEmail } from '../worker/email/send.ts'

const dir = new URL('../.wrangler/email-previews/', import.meta.url)
await mkdir(dir, { recursive: true })
for (const kind of Object.keys(messages)) {
  const content = ['verify-link', 'reset-link', 'invite'].includes(kind)
    ? { kind, url: 'https://app.fonteslabs.com/?preview=email' }
    : { kind, code: '012345' }
  const email = renderEmail(content)
  let html = email.html
  await writeFile(new URL(`${kind}.html`, dir), html)
  await writeFile(new URL(`${kind}.txt`, dir), `${email.subject}\n\n${email.text}\n`)
}
console.log(`Saved seven email previews to ${dir.pathname}`)
