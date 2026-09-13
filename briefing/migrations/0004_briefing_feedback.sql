CREATE TABLE IF NOT EXISTS briefing_feedback (
  generation_id TEXT NOT NULL REFERENCES briefing_generations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (generation_id, user_id)
);
