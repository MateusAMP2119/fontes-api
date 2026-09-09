# Onboarding API changes

The bootstrap response now includes `passwordRequired`, `hasPassword`, `canInvite`, `canEditWorkspace`, `accessLost` and the last `operationId`. Existing verified OTP-only users without a Google identity require password setup. Existing Google users can continue without a password. Onboarding and invitation acceptance reject incomplete credential setup.

`POST /api/onboarding/password` takes `{ "newPassword": "..." }`. It requires a trusted origin, verified user and a session created within 15 minutes. It delegates hashing and storage to Better Auth's server-only setPassword operation. An existing password cannot be overwritten by this route; password reset and change use the established Better Auth endpoints. The password is never an onboarding field or queued write.

`POST /api/onboarding/invitation` takes `{ "token": "..." }` and returns the workspace name and member role for review, without adding membership. It checks token expiry, recipient identity and the creator's current owner/admin membership. `/join` repeats those checks on acceptance. Expired copied links return 410 instead of incorrectly reporting ready.

Setup writes may supply `organizationId` to bind a queued snapshot to its original workspace. A mismatch returns a revision-conflict response. Membership role controls workspace edits; existing admins retain their role. Profile images support bounded data images or HTTPS profile URLs, and an empty image explicitly removes the saved image. All new wording is impersonal PT-PT.

No new schema migration is required. Deploy this API before the matching frontend. Release the API before the frontend main-branch deployment. Existing email templates and MIME transport were preserved.

Validation uses `npm test`, `npm run typecheck` and `npm run build`. Onboarding tests execute the real SQL against isolated SQLite. Password tests use the production auth configuration with an in-memory adapter and captured email transport, exercising OTP migration, password hashing/login, single-use password reset and session revocation. No tests send real email or modify production accounts.


`POST /api/onboarding/availability` accepts a valid lowercase workspace `slug` and optional current `organizationId`. It requires a verified session and trusted origin, returns only an `available` boolean and performs an exact indexed lookup. An owner/admin can retain their current workspace URL; another account cannot use that organization ID to hide a collision. The endpoint never reserves or writes data, and the final setup write still checks uniqueness.
