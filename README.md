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
The canonical API origin is `https://api.fonteslabs.com`; it serves `/api/auth/*`
and `/api/projects`. The legacy `builder.fonteslabs.com` callback host is also attached as a custom domain
so it resolves even after the old frontend deployment is deleted.
`GOOGLE_REDIRECT_URI` preserves that registered callback for both authorization
and token exchange. The legacy callback route forwards code/state to the canonical
API callback, where the API's host-only OAuth cookie is available. The redirect
only accepts GET on the exact registered host/path, sets no-referrer and inherits
no-store headers. No cross-subdomain session cookies are needed.
Email verification and password-reset links use the API origin.

Browser clients use `credentials: 'include'`. CORS uses the same allowlist as
Better Auth, including `https://app.fonteslabs.com`, `https://www.app.fonteslabs.com`,
the legacy builder/Pages origins and `http://localhost:5173`. OPTIONS requests are
handled before auth/database work; unknown origins, methods and headers fail
preflight. Actual responses, including errors, include credentialed CORS only for
trusted origins and remain private/no-store. Cookies remain HttpOnly, Secure and
SameSite=Lax in production. Use the HTTPS app domain for production login; a
cross-site workers.dev preview cannot rely on these same-site cookies.

News remains on the independent engine API at `https://fontes-api.bymarreco.com`;
this auth Worker does not proxy news or receive news requests.
Scalar docs are at `/api/auth/docs`. CI checks types and the bundle; deployment is explicit.

## Development

`npm run dev` executes the Worker remotely in Cloudflare and connects to the
configured Cloudflare D1 database. Changes affect that database and emails use
Cloudflare's email binding. There is no local database or email inbox.

Copy `.dev.vars.example` to `.dev.vars` and supply development credentials.
For a local API development session, set the frontend's `VITE_API_URL` to
`http://localhost:8787` and run `fontes-app` on port 5173. Both origins are same-site
for cookies; production API cookies do not work cross-site from plain localhost.
Register `http://localhost:8787/api/auth/callback/google` for development OAuth.

## Structure

- `worker/models/`: project and organization classes own D1 queries.
- `worker/controllers/`: routing, authorization, application actions and Scalar docs.
- `worker/controllers/AuthController.ts`: Better Auth configuration, username validation, email HTML and Scalar docs.
- `worker/index.ts`: Worker entrypoint.

Builds are minified. Project listing combines membership and visibility in one
query; organization join limits use a D1 batch. Auth remains request-scoped.
