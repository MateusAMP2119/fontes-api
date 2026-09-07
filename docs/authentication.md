# Authentication

Better Auth 1.7.2 runs directly in the TypeScript Worker. It owns password hashing,
Google OAuth/PKCE and ID-token validation, session cookies, verification, reset,
organization membership and JWT issuance. Application-specific authorization is
in `worker/projects.ts` and `worker/organization-access.ts`.

Email/password requires verification. Google also requires a verified account email before a session is issued. Password reset revokes existing sessions. The same Worker runs in workerd
locally and on Cloudflare, with local-only mail capture supplied by `worker/local.ts`.
Production never imports that entrypoint.

Existing users, password hashes, cookies and D1 schema remain compatible with the
previous app. Migrations 0005 and 0006 have already been applied to the remote
`fontes-app` database. Migration history is retained: the obsolete Rust token tables
are unused by this service, but still referenced by the existing deletion triggers.
Do not rewrite applied migrations or delete shared data during deployment.

The Google OAuth provider is mocked only in tests. Real Google login additionally
requires configured credentials and exact callback registration. Cloudflare Email
Service must be enabled for the sender before production verification/reset works.

The old auth Worker was absent during the last production inspection, causing API
requests to receive SPA HTML. GitHub publication alone does not resolve that live
configuration: deploy `fontes-api` with its secrets and routes using the README.
