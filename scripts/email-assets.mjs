// Node-only test/preview adapter for Wrangler's Text and Data module imports.
// Production embeds these assets through wrangler.jsonc and never reads files.
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:email') return { url: specifier, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'cloudflare:email') return { format: 'module', shortCircuit: true,
      source: 'export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw } }' }

    if (url.startsWith('file:') && /\/worker\/email\/.*\.(html|png)$/.test(url)) {
      const bytes = readFileSync(new URL(url))
      const value = url.endsWith('.html')
        ? JSON.stringify(bytes.toString('utf8'))
        : `Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0)).buffer`
      return { format: 'module', source: `export default ${value}`, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
