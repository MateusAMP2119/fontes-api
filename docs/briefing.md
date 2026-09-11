# Briefings inside fontes-api

The former fontes-ebs generator now runs in the API Worker. There is no separate generation Worker, deploy command, or service binding.

`POST https://api.fonteslabs.com/api/briefing/generate` requires `Authorization: Bearer <EBS_API_TOKEN>` and a JSON object:

```json
{"from":"2026-09-10T00:00:00Z","until":"2026-09-11T00:00:00Z"}
```

The secret retains its existing name and value so callers only change the URL. It is a server credential, never a browser credential. The old EBS hostname is retired with the Worker.

Timestamps must include a timezone and whole-second precision. The interval must be positive, no longer than 31 days, and end no later than now. Equivalent timezone offsets reuse the same persistent interval. A cache hit returns 200; new generation returns 201; invalid input 400; invalid token 401; an active lease 409; generation failures 502.

`GET /api/briefing` requires a verified user session and returns the latest saved window without inference. It retains the `stale` indicator after 15 minutes. Retired PARTIAL_CLUSTERING notices are omitted on reads without changing stored history.

The AI binding, news facts URL, version metadata and existing `fontes-briefings` D1 binding belong to the API configuration. The copied migration files document the existing schema; consolidation requires no remote migration. Never recreate or delete this database. fontes-ews continues reading briefing_windows without changes.

The model, prompt, source interval checks, exact-count validation, leases, history, usage accounting and error handling are preserved from fontes-ebs commit e8e0fe1. Tests mock source fetches and inference. Run `npm run check` before deployment.
