import { spawnSync } from 'node:child_process'
import { bundledTemplate, parseEmailPair, TEMPLATE_PREFIX } from '../worker/email/template.ts'
const files = []
for (const [kind, pair] of Object.entries(bundledTemplate.messages)) {
  parseEmailPair(kind, pair.html, pair.copy)
  for (const ext of ['html', 'json']) files.push([`${TEMPLATE_PREFIX}/${kind}.${ext}`, `worker/email/emails/${kind}.${ext}`, ext === 'html' ? 'text/html; charset=utf-8' : 'application/json'])
}
for (const name of ['header', 'footer']) files.push([`assets/${name}.png`, `worker/email/assets/${name}.png`, 'image/png'])
console.log(`Validated ${files.length} individual R2 files.`)
if (process.argv.includes('--upload')) {
  for (const [key, file, type] of files) {
    const result = spawnSync('./node_modules/.bin/wrangler', ['r2', 'object', 'put', `fontes-email-templates/${key}`, '--file', file, '--content-type', type, '--remote'], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
  console.log('Published separate HTML, JSON, and image files. No Worker deployment performed.')
}
