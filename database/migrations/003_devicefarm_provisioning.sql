-- AWS Device Farm worker provisioning mapping (single-worker PoC). Portable SQLite + PostgreSQL.

CREATE TABLE IF NOT EXISTS devicefarm_provisionings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  workspace_user_id TEXT NOT NULL,
  workspace_email TEXT NOT NULL,
  devicefarm_run_arn TEXT,
  devicefarm_job_arn TEXT,
  device_arn TEXT,
  device_name TEXT,
  weplay_user_id TEXT,
  provisioning_status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_devicefarm_provisionings_account ON devicefarm_provisionings(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_devicefarm_provisionings_status ON devicefarm_provisionings(provisioning_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_devicefarm_provisionings_email ON devicefarm_provisionings(workspace_email);
