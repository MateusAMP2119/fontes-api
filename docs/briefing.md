# Briefings inside fontes-api

The former fontes-ebs generator now runs in the API Worker. There is no separate generation Worker, deploy command, or service binding.

`POST https://api.fonteslabs.com/api/briefing/generate` requires `Authorization: Bearer <session-token>` and a JSON object:

```json
{"from":"2026-09-10T00:00:00Z","until":"2026-09-11T00:00:00Z"}
```

Both briefing endpoints require a live session for a user whose email is verified. The bearer value is the `token` returned by password/OTP sign-in, `session.token` from `GET /api/auth/get-session`, or the signed `set-auth-token` response header. Example:

```http
Authorization: Bearer <session-token>
```

Better Auth validates the token against the existing session. Expired or revoked sessions return 401; unverified users return 403. A cookie alone is insufficient for briefing requests, and an invalid bearer token cannot fall back to a valid cookie. Browser login, onboarding and the session endpoint continue to support cookies. No JWT issuance endpoint is needed.

The old static EBS_API_TOKEN is no longer read or accepted as a generation credential. Existing callers must sign in and send their session token. No database migration is required.

Timestamps must include a timezone and whole-second precision. The interval must be positive, no longer than 31 days, and end no later than now. Equivalent timezone offsets reuse the same persistent interval. A cache hit returns 200; new generation returns 201; invalid input 400; invalid token 401; an active lease 409; generation failures 502.

`GET /api/briefing` requires the same session bearer header and returns the latest saved window without inference. It retains the `stale` indicator after 15 minutes. Retired PARTIAL_CLUSTERING notices are omitted on reads without changing stored history.

The AI binding, news facts URL, version metadata and existing `fontes-briefings` D1 binding belong to the API configuration. The copied migration files document the existing schema; consolidation requires no remote migration. Never recreate or delete this database. fontes-ews continues reading briefing_windows without changes.

The model, prompt, source interval checks, exact-count validation, leases, history, usage accounting and error handling are preserved from fontes-ebs commit e8e0fe1. Tests mock source fetches and inference. Run `npm run check` before deployment.
