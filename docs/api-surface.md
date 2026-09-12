# Public API surface

Only routes used by fontes-app and their authentication/email dependencies are exposed, plus the retained briefing reader, generator and API documentation. All other application routes return 404. OPTIONS is handled centrally for CORS. Unsupported methods on retained routes return 405.

## Authentication

All paths below are relative to `/api/auth`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/get-session` | Read the cookie-backed session. |
| POST | `/sign-in/email` | Password login. |
| POST | `/email-otp/send-verification-otp` | Send a registration code. |
| POST | `/sign-in/email-otp` | Verify a new account and create its first session. |
| POST | `/sign-in/social` | Start Google login. |
| GET | `/callback/google` | Complete Google login. |
| GET | `/oauth-proxy-callback` | Complete local OAuth handoff. |
| GET | `/error` | OAuth error fallback. |
| POST | `/sign-out` | End the current session. |
| POST | `/change-password` | Change a password. |
| POST | `/request-password-reset` | Send a recovery email. |
| GET | `/reset-password/:token` | Follow the recovery email link. |
| POST | `/reset-password` | Set a password using a recovery token. |
| GET | `/verify-email` | Complete verification links, including previously issued links. |

`AuthController.publicMethod` defines the public auth surface. Better Auth core and email OTP still provide server-side implementation, but unlisted HTTP routes are rejected before invoking their handlers. The organization and JWT plugins have been removed. OpenAPI generation is used only for the filtered documentation schema. The existing `session.activeOrganizationId` column is retained as a server-controlled additional field so workspace restoration and onboarding keep working. `auth.api.setPassword` is a server-only operation called by onboarding.

Email codes are registration-only. Existing accounts use password or Google; unfinished accounts without a password can use password recovery.

## Callback URLs

For `POST /api/auth/sign-in/social`, `callbackURL` is the destination after authentication. `https://app.fonteslabs.com/` is a valid production example; `http://localhost:5173/` is valid for local development. Absolute URLs must match a configured trusted origin. The app's popup flow generates `https://app.fonteslabs.com/google-auth.html?attempt=<uuid>&complete=1` automatically to notify its original window.

Google's OAuth redirect URI is a separate server setting: `https://builder.fonteslabs.com/api/auth/callback/google`. That registered bridge forwards the provider response to `https://api.fonteslabs.com/api/auth/callback/google` before returning to the app's `callbackURL`.

## Onboarding and briefings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/onboarding` | Read profile, workspace, default project and setup state. |
| POST | `/api/onboarding` | Save setup, profile and preferences; create the initial workspace/project if needed. |
| POST | `/api/onboarding/password` | Set the first password. |
| POST | `/api/onboarding/invite` | Create or send a token-based invitation. |
| POST | `/api/onboarding/join` | Accept a token-based invitation. |
| GET | `/api/briefing` | Read the latest saved briefing with a verified session bearer token. |
| POST | `/api/briefing/generate` | Generate new briefing results using a verified session bearer token. |

See [briefing contract](briefing.md) for generation inputs and storage behavior.

## Email assets

`GET` and `HEAD` on `/email-assets/header.png` and `/email-assets/footer.png` remain available because transactional emails reference them.

## Removed surface

Standalone project operations, access-code joins, invitation previews, slug availability checks, organization/member/invitation SDK endpoints, JWT/JWKS, health endpoints, unused core/OTP auth routes are no longer public. The root URL redirects to Scalar at `/api/auth/docs`, which reads the filtered schema at `/api/auth/openapi.json`. The raw Better Auth schema and reference routes remain unavailable. The matching app change removes the unused JWT and organization client plugins.

No database migration or data deletion is needed. Existing accounts, session cookies, workspace memberships, projects and saved briefings remain valid. The separate news API is unchanged.
