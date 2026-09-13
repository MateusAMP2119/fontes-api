# News rankings

`GET /api/rankings?from=2026-09-11T00%3A00%3A00Z&until=2026-09-12T00%3A00%3A00Z&limit=10`

Requires `Authorization: Bearer <session token>` from login, with verified email,
matching the briefing routes. Cookie-only requests are not accepted. The existing
Worker CORS and private/no-store response policy applies.

`from` and `until` are required whole-second RFC 3339 timestamps, using the same
interval parser as briefings: at most 31 days, ending no later than now, with
enough history for a preceding equal interval. `limit` defaults to 10, accepts
1 through 50 and applies separately to each list. Duplicate and unknown parameters
are rejected. Scope is always `general`, across collected news; no workspace,
source, topic, search, or custom upstream URL filters are accepted.

The API calls `NEWS_API_URL/rankings` with Unix-second `from`, `until` and `limit`.
It sends no user credentials upstream. The engine route uses its existing caller
pacing middleware. There is a 10-second fetch timeout, a 128 KiB decompressed
response bound, no redirects, and validation of the response period, units,
counts, IDs, ordering, freshness and list lengths before returning data.

## Counting contract

- Periods use engine `documents.discovered_at` in `[from, until)`, not publication time.
- `writers`: distinct articles per stored author, including agencies and newsroom
  bylines. Each coauthor receives one article. Names use the existing author IDs;
  the engine currently deduplicates authors by case-insensitive name, not verified identity.
- `categories`: distinct articles per publisher category. Each attached category
  receives one article. These are publisher labels, not a new shared topic taxonomy.
- `mentions`: distinct summarized events per key entity. An event qualifies when
  at least one member article was collected in the period. Repeated articles in
  an event count once. This is event coverage, not literal article mention frequency.
  Entity aliases already resolve to the entity ID. `kind` is `person`, `org` or `location`.
- All lists sort by `count DESC, id ASC`; rank is the one-based list position.
- `totals.articles` includes all collected articles, even those without authors or
  categories. `totals.events` counts qualifying summarized events, even those without
  named entities. Totals are computed before the list limit. Counts across entries
  can sum to more than the corresponding total.
- `latest_discovery` is the most recent article discovery within the requested
  window, or null when empty. It is not a crawler health check. `generated_at` is
  the query timestamp. Entity associations reflect the current summarized data,
  so historical results can change after reprocessing.

## Response

```json
{
  "version": 1,
  "scope": "general",
  "period": { "from": 1789084800, "until": 1789171200 },
  "timestamp_basis": "discovered_at",
  "generated_at": 1789171210,
  "latest_discovery": 1789171100,
  "totals": { "articles": 5, "events": 2 },
  "writers": [{ "id": 1, "name": "Ana", "rank": 1, "count": 3, "unit": "articles" }],
  "categories": [{ "id": 2, "name": "Política", "rank": 1, "count": 4, "unit": "articles" }],
  "mentions": [{ "id": 3, "name": "Lisboa", "slug": "lisboa", "kind": "location", "rank": 1, "count": 2, "unit": "events" }]
}
```

Missing/invalid parameters return 400 (`INVALID_RANKINGS_PARAMETERS`). Missing or
invalid sessions return 401; unverified users return 403. Missing source config
returns 503 (`RANKINGS_NOT_CONFIGURED`). Source failure, timeout, rate limiting,
or contract failure returns 503 (`RANKINGS_UNAVAILABLE`), never fabricated empty
rankings. Genuine empty periods return 200 with zero totals and empty lists.

## Release and verification

Deploy the engine `/rankings` route before releasing the app API. No new bindings,
secrets, database migrations, scheduled jobs, or AI calls are needed. The engine
uses existing discovery and relationship indexes, one read-only SQL snapshot,
and a five-second statement timeout. No precomputed rankings are stored.

Run `npm run check` here. In iris-core, run `cargo test api::rankings`, then run
the ignored SQL integration test against an empty disposable Postgres database:
`RANKINGS_TEST_DATABASE_URL=... cargo test api::rankings -- --ignored`.
The fixture creates only the relational columns used by the production query,
inside a rolled-back transaction. It does not need the crawler or vector extension.

Local validation on 2026-09-12: the API's 82 tests, typecheck and Worker dry-run
build passed. Engine interval tests and the Postgres integration test passed.
A synthetic Postgres 14 run with 100,000 articles, 200,000 author links,
200,000 category links and 10,000 summarized events completed the aggregation
in 322 ms (0.75 ms planning), at limit 50. The plan used temporary disk blocks
for aggregation. This is local fixture evidence, not a production latency claim;
production volume and distribution still need to be observed after release.

## Growth ordering and sparklines

`sort=growth` compares the requested interval with the preceding interval of equal
length. With a 24-hour request, `activity` contains 24 hourly buckets, including
zeroes. Each entry adds `previous_count` and `growth_percent`, calculated as
`100 * (count - previous_count) / previous_count`, rounded to one decimal.
A zero previous count produces null, displayed as “Novo”, never infinity.

The database ranks all currently active entries before limiting, by growth
percentage descending, null last, current count descending, then ID. Entries
with only previous activity are not included. Existing requests without `sort`
retain the original count-based contract and payload.

Entity activity assigns each distinct summarized event to its earliest collected
article within each window. An event may contribute once to each comparison
window, but cannot contribute twice within one. Consequently the 24 buckets
always sum to the corresponding current count. This remains event coverage,
not literal mentions within article text.

The app defaults to seven days with 24-hour and 30-day controls, requesting
`sort=volume`. This mode includes the same validated activity buckets but sorts
by current count descending and ID ascending, before limiting. The app displays
counts and neutral sparklines, with units in accessible descriptions and tooltips.
Stored agency and newsroom bylines are included. Counts use discovery time.
