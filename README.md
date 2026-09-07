# Fontes API

TypeScript Cloudflare Worker with Better Auth, D1, organizations, projects and Scalar docs.

## Cloudflare

Requires Node.js 24+ and a Cloudflare account with access to the existing
`fontes-app` D1 database configured as `APP_DB` in `wrangler.jsonc`.
The repository does not provision databases or contain schema/migration files.
Deploying preserves the existing schema and records; a new empty database is not supported automatically.

```sh
npm ci
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run typecheck
npm run build
npm run deploy
```

Use a random production secret of at least 32 characters. Authorize
`conta@fonteslabs.com` for `AUTH_EMAIL` and register
`https://builder.fonteslabs.com/api/auth/callback/google` with Google.
The Worker serves `/api/auth/*` and `/api/projects*` on `builder.fonteslabs.com`.
Scalar docs are at `/api/auth/docs`. CI checks types and the bundle; deployment is explicit.

## Development

`npm run dev` executes the Worker remotely in Cloudflare and connects to the
configured Cloudflare D1 database. Changes affect that database and emails use
Cloudflare's email binding. There is no local database or email inbox.

Copy `.dev.vars.example` to `.dev.vars` and supply development credentials.
Run `fontes-app` on port 5173; it proxies port 8787 to the remote Worker.
Register `http://localhost:5173/api/auth/callback/google` for development OAuth.

## Structure

- `worker/models/`: project and organization classes own D1 queries.
- `worker/controllers/`: routing, authorization, application actions and Scalar docs.
- `worker/controllers/AuthController.ts`: Better Auth configuration, username validation, email HTML and Scalar docs.
- `worker/index.ts`: Worker entrypoint.

Builds are minified. Project listing combines membership and visibility in one
query; organization join limits use a D1 batch. Auth remains request-scoped.
