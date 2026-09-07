# Fontes API

TypeScript Worker with Better Auth, D1, organizations, projects and Scalar docs.

## Local

Node.js 24+:

```sh
npm ci
cp .dev.vars.example .dev.vars
# Set a random BETTER_AUTH_SECRET (32+ characters) and Google credentials.
npm run db:init  # once, for a fresh local database
npm run dev
```

Run `fontes-app` on port 5173; it proxies the Worker on port 8787.
Existing local databases need no initialization.

- Docs: http://localhost:5173/api/auth/docs
- Local email links: http://localhost:5173/__dev/mail
- Google callback: http://localhost:5173/api/auth/callback/google

`schema.sql` initializes local D1. Production uses the existing `fontes-app`
database via `APP_DB`; deploy does not modify its schema or records.
Local email capture is isolated in `worker/local.ts`.

## Cloudflare

Set `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with
`wrangler secret put`. Authorize `conta@fonteslabs.com` for the `AUTH_EMAIL` binding
and register `https://builder.fonteslabs.com/api/auth/callback/google` with Google.

```sh
npm run typecheck
npm run build
npm run deploy
```

The `fontes-api` Worker serves `/api/auth/*` and `/api/projects*` on the app origin.
CI checks types and the bundle; deployment is explicit.
