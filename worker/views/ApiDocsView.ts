import custom from '../openapi.json'
import type { Auth } from '../auth'

// Pin the browser bundle so local and deployed docs use the same Scalar release.
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fontes App API · Scalar</title>
<style>body{margin:0}</style>
</head><body>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0/dist/browser/standalone.js"></script>
<script>Scalar.createApiReference('#app', {
  url: '/api/auth/openapi.json',
  theme: 'default',
  hideClientButton: false,
  showDeveloperTools: 'never',
  persistAuth: false,
  telemetry: false,
  proxyUrl: '',
  customFetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' })
})</script>
</body></html>`

export class ApiDocsView {
  static async schema(auth: Auth) {
    const generated = await auth.api.generateOpenAPISchema()
    return { ...generated, info: custom.info, servers: [{ url: '/' }],
      paths: { ...Object.fromEntries(Object.entries(generated.paths).map(([path, operation]) => ['/api/auth' + path, operation])), ...custom.paths },
      components: { ...generated.components, securitySchemes: { ...generated.components.securitySchemes, ...custom.components.securitySchemes } },
    }
  }

  static page(request: Request): Response {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    return new Response(request.method === 'HEAD' ? null : html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    })
  }
}
