CREATE TABLE briefing_generations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope = 'general'),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'superseded')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  inputs TEXT NOT NULL CHECK (json_valid(inputs)),
  request TEXT NOT NULL CHECK (json_valid(request)),
  response TEXT CHECK (response IS NULL OR json_valid(response)),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  neurons REAL,
  neurons_basis TEXT CHECK (neurons_basis IS NULL OR neurons_basis IN ('reported', 'estimated'))
);
CREATE INDEX briefing_generations_scope_started ON briefing_generations(scope, started_at DESC);
ALTER TABLE briefing ADD COLUMN generation_id TEXT REFERENCES briefing_generations(id);
