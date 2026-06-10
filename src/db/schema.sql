CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokenizer_type TEXT NOT NULL DEFAULT 'tiktoken',
  prompt_tokens_estimated INTEGER NOT NULL DEFAULT 0,
  completion_tokens_estimated INTEGER NOT NULL DEFAULT 0,
  prompt_tokens_actual INTEGER NOT NULL DEFAULT 0,
  completion_tokens_actual INTEGER NOT NULL DEFAULT 0,
  total_tokens_actual INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  date TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY (date, user_id, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_time ON usage_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_model ON usage_events(provider, model);
CREATE INDEX IF NOT EXISTS idx_rollups_user_date ON usage_daily_rollups(user_id, date);
