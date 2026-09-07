# Fontes API

One TypeScript Cloudflare Worker for email/password and Google authentication,
sessions, organizations, join codes and projects. Better Auth owns authentication;
D1 `fontes-app` stores application data through the `APP_DB` binding. No Rust,
containers or separate local server runtime are required.

## Local development

Requires Node.js 24 or newer.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Add Google credentials to .dev.vars if testing Google login.
npm run dev
```

The API listens on `http://localhost:8787`. Run `fontes-app` at
`http://localhost:5173`; its Vite proxy keeps cookies and OAuth on that origin.
Local D1 migrations run automatically. Email links are captured at
`http://localhost:5173/__dev/mail`; local development sends no real emails.
The local session secret is generated once inside `.wrangler/`.

- Scalar API docs: `http://localhost:5173/api/auth/docs`
- OpenAPI JSON: `http://localhost:5173/api/auth/openapi.json`
- Google callback: `http://localhost:5173/api/auth/callback/google`

Scalar's browser bundle is pinned, its branding remains visible, and test requests
use the current origin. Auth schemas are generated from Better Auth; only the
application-specific operations are maintained in `worker/openapi.json`.

## Verification

```sh
npm run typecheck
npm test
```

Tests run the actual Worker bundles in workerd with local D1 on HTTP and HTTPS.
They cover email verification, password reset/revocation, Google PKCE with a mocked
provider and signed ID tokens, sessions, organization/project authorization,
deletion safeguards, generated docs and isolation of the development inbox.

## Cloudflare deployment

The Worker is named `fontes-api`. The database remains `fontes-app`.

```sh
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run db:migrate
npm run deploy
```

Use a stable random secret of at least 32 characters. Register the production
Google callback `https://builder.fonteslabs.com/api/auth/callback/google` and
configure Cloudflare Email Service to send from `conta@fonteslabs.com` through
`AUTH_EMAIL`. The routes in `wrangler.jsonc` serve `/api/auth/*` and `/api/projects*`
on the app origin. Deploy this API before releasing a frontend that depends on it.

Publishing this repository does not deploy Cloudflare resources. CI runs checks;
deployment is explicit. See [deletion policy](docs/user-deletion.md).
