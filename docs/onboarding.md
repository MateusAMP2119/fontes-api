# Onboarding

The flow derives organization membership, username, and accessible projects from the authenticated account. Failed lookups show a retry action instead of opening a creation form. A missing or stale active organization is restored from current membership.

Owners and admins can see the current four-digit entry code and organization identifier in the account menu. Codes rotate on fixed 20-minute boundaries, derive from an HMAC using BETTER_AUTH_SECRET, and cannot be retrieved by regular members. Changing that secret also invalidates codes. Join requests require a verified account and trusted origin; success grants only the member role. Exact display names work only when unambiguous; use the displayed slug otherwise.

Per 20-minute window, joining allows five attempts per account, twenty per Cloudflare client IP, and twenty per target organization. Invalid requests consume the account/IP budgets. The shared organization limit intentionally blocks further joins until the next window after twenty attempts. Expired codes have no grace period.

New projects default to private and store their creator. The projects API checks current organization membership and returns private projects only to their owner; public means visible within the organization. This controls project records; it does not add collaboration or synchronization to other workspace features.

## Release order

Apply `migrations-auth/0004_onboarding.sql` to APP_DB before deploying the auth Worker, then deploy the client. Existing project records remain public, matching their previous access; no historical creator is guessed. The migration adds columns and an attempt-counter table and was tested in an in-memory SQLite database. Released on 2026-09-05: migration applied to the remote database (then bound as `AUTH_DB`, now `APP_DB`), auth Worker version `94e55e84-e7f8-40af-966d-6ed77de2f9ba`, and production Pages deployment `ce1821df`. The Pages aliases redirect to `builder.fonteslabs.com` so authentication uses the canonical cookie origin. Live checks verified the current client bundle, signup rendering, alias redirects, session lookup, and unauthenticated API rejection.

## Verification

Use Node 24+ for the API tests (native TypeScript stripping and node:sqlite):

```sh
node --test scripts/onboarding-api.test.mjs
npm run build
npx tsc -p worker/tsconfig.json
npm run lint
```

With the Vite client listening on localhost:5173:

```sh
node --test scripts/onboarding-browser.test.mjs scripts/auth-regression.test.mjs
```

Browser tests intercept all API traffic; they do not create real accounts, alter the cloud database, or send emails. API tests execute the real SQL handlers against an in-memory database with session fixtures.
