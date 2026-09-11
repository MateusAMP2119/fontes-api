-- Keep the legacy cache and generation history intact for rolling deployments.
CREATE TABLE briefing_windows (
  scope TEXT NOT NULL CHECK (scope = 'general'),
  period_from INTEGER NOT NULL CHECK (period_from >= 0),
  period_until INTEGER NOT NULL CHECK (period_until > period_from),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  generated_at INTEGER,
  generation_id TEXT REFERENCES briefing_generations(id),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period_from, period_until),
  CHECK ((payload IS NULL) = (generated_at IS NULL))
);

-- Every previously successful generation is already a snapshot of an exact interval.
INSERT OR IGNORE INTO briefing_windows
  (scope, period_from, period_until, payload, generated_at, generation_id)
SELECT scope, json_extract(payload, '$.period.from'), json_extract(payload, '$.period.until'),
       payload, json_extract(payload, '$.generated_at'), id
FROM briefing_generations
WHERE status = 'succeeded' AND payload IS NOT NULL
ORDER BY finished_at, id;

INSERT OR IGNORE INTO briefing_windows
  (scope, period_from, period_until, payload, generated_at, generation_id)
SELECT scope, json_extract(payload, '$.period.from'), json_extract(payload, '$.period.until'),
       payload, generated_at, generation_id
FROM briefing WHERE payload IS NOT NULL;
