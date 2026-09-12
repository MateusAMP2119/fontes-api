# Fontes API

TypeScript Cloudflare Worker for app authentication, onboarding and briefings, backed by Better Auth and D1.

## Cloudflare

Requires Node.js 24+ and a Cloudflare account with access to the existing
`fontes-app` D1 database configured as `APP_DB` in `wrangler.jsonc`.
The repository does not provision databases or include the baseline auth schema.
Additive migrations live in `migrations/`; apply them explicitly before their API
release. A new empty database is not supported automatically.

```sh
npm ci
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OAUTH_PROXY_SECRET
npm run typecheck
npm run build
npm run deploy
```

Use a random production secret of at least 32 characters. Authorize
`conta@fonteslabs.com` for `AUTH_EMAIL` and register
`https://builder.fonteslabs.com/api/auth/callback/google` with Google.
The canonical API origin is `https://api.fonteslabs.com`; its supported routes are
listed in [API surface](docs/api-surface.md). The legacy `builder.fonteslabs.com` callback host is also attached as a custom domain
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

News remains on the independent engine API at `https://fontes-api.bymarreco.com`.
Briefing generation runs inside this Worker at `POST /api/briefing/generate`,
using a verified user session bearer token and explicit `from`/`until` timestamps. Saved
briefings remain in the existing D1 database. See [briefings](docs/briefing.md).

## Development

`npm run dev` executes the Worker remotely in Cloudflare and connects to the
configured Cloudflare D1 database. Changes affect that database and emails use
Cloudflare's email binding. There is no local database or email inbox.

Remote development inherits the deployed Worker’s secrets, including
`OAUTH_PROXY_SECRET`; there is no need to copy production credentials locally.
If overriding credentials with `.dev.vars`, use `.dev.vars.example` and keep the
proxy secret consistent with production.
For a local API development session, set the frontend's `VITE_API_URL` to
`http://localhost:8788` and run `fontes-app` on port 5173. Both origins are same-site
for cookies; production API cookies do not work cross-site from plain localhost.
Google continues to use the registered production callback. Better Auth’s OAuth
proxy returns the encrypted profile to `http://localhost:8788`, where the local
session cookie is set and checked. Deploy the OAuth proxy plugin to production
before testing this flow. Set the same random `OAUTH_PROXY_SECRET` (at least 32
characters) in production and `.dev.vars`; keep `BETTER_AUTH_SECRET` separate
between environments. Never disable OAuth state or cookie checks.

For the frontend, run `npm run dev:auth` to use the localhost API. Standard
production builds retain `https://api.fonteslabs.com`. The local frontend must
use `localhost`, not `127.0.0.1`, so both ports share the cookie site.

## Structure

- `worker/models/`: workspace restoration and visible project queries for onboarding.
- `worker/controllers/`: routing, authorization and app actions.
- `worker/controllers/AuthController.ts`: public auth route allowlist, sessions and Better Auth configuration.
- `worker/index.ts`: Worker entrypoint.

Builds are minified. Onboarding project selection combines membership and visibility
in one query. Auth remains request-scoped.

## Onboarding v2 rollout

Apply `migrations/0001_onboarding.sql` to the existing `fontes-app` database before
releasing this API, then release the frontend. This additive migration creates
onboarding progress/preferences and invitation records. It does not replace the
existing Better Auth or project schema. No migration is applied by the build.

The email OTP plugin supports six-digit login codes (10-minute expiry, hashed
storage, five attempts). Password login, change and recovery remain available alongside OTP and Google.

`GET /api/onboarding` returns the verified user's workspace, profile, default
project, preferences and completion state. `POST /api/onboarding` accepts a full
setup snapshot (`operationId`, increasing `revision`, `name`, `slug`,
`profileName`, `completed`, `changelog`, `daily`). Atomic conditional D1 writes and
stable entity IDs make retries safe and reject stale operations. Existing users
with a workspace and visible project skip onboarding. Display names replace the
old required username step. Preferences are stored; newsletter delivery is owned
by the email publishing system, not this endpoint.

`POST /api/onboarding/invite` registers a random 256-bit token, workspace ID and
optional recipient email. Only owners/admins can issue invitations. Tokens are
stored hashed, expire after seven days, and email-specific invitations require a
matching verified email. `POST /api/onboarding/join` accepts the token and grants
member access. Email delivery uses a lease and retries the same invitation link;
a crash after delivery but before acknowledgement can deliver a duplicate email.
These endpoints require a verified session, and writes require a trusted Origin.
