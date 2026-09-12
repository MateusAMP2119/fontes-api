# Onboarding API changes

The bootstrap response now includes `passwordRequired`, `hasPassword`, `canInvite`, `canEditWorkspace`, `accessLost` and the last `operationId`. Existing verified OTP-only users without a Google identity require password setup. Existing Google users can continue without a password. Onboarding and invitation acceptance reject incomplete credential setup.

`POST /api/onboarding/password` takes `{ "newPassword": "..." }`. It requires a trusted origin, verified user and a session created within 15 minutes. It delegates hashing and storage to Better Auth's server-only setPassword operation. An existing password cannot be overwritten by this route; password reset and change use the established Better Auth endpoints. The password is never an onboarding field or queued write.

`POST /api/onboarding/join` validates token expiry, recipient identity and the creator's current owner/admin membership before adding membership. Expired copied invite links return 410 when reissued instead of incorrectly reporting ready. The unused invitation-preview endpoint has been removed.

Setup writes may supply `organizationId` to bind a queued snapshot to its original workspace. A mismatch returns a revision-conflict response. Membership role controls workspace edits; existing admins retain their role. Profile images support bounded data images or HTTPS profile URLs, and an empty image explicitly removes the saved image. All new wording is impersonal PT-PT.

No new schema migration is required. Deploy this API before the matching frontend. Release the API before the frontend main-branch deployment. Existing email templates and MIME transport were preserved.

Validation uses `npm test`, `npm run typecheck` and `npm run build`. Onboarding tests execute the real SQL against isolated SQLite. Password tests use the production auth configuration with an in-memory adapter and captured email transport, exercising OTP migration, password hashing/login, single-use password reset and session revocation. No tests send real email or modify production accounts.


Workspace URL uniqueness is checked atomically during setup. The unused availability endpoint has been removed.
