-- Portable schema (SQLite + PostgreSQL). INTEGER timestamps are Unix milliseconds. Booleans are 0/1.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  device_identifier TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  last_heartbeat INTEGER,
  current_job_id TEXT,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  login_provider TEXT NOT NULL,
  status TEXT NOT NULL,
  setup_status TEXT NOT NULL,
  worker_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (worker_id) REFERENCES workers(id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  configuration TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  worker_id TEXT,
  run_id TEXT,
  execution_id TEXT NOT NULL UNIQUE,
  configuration TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (worker_id) REFERENCES workers(id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS event_logs (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  account_id TEXT,
  job_id TEXT,
  worker_id TEXT,
  run_id TEXT,
  event TEXT NOT NULL,
  status TEXT,
  error TEXT,
  message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_status_enabled ON accounts(status, enabled);
CREATE INDEX IF NOT EXISTS idx_accounts_worker ON accounts(worker_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled ON jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_worker ON jobs(worker_id);
CREATE INDEX IF NOT EXISTS idx_workers_status_heartbeat ON workers(status, last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_event_logs_account ON event_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_event_logs_job ON event_logs(job_id);
