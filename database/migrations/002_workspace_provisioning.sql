-- Google Workspace user provisioning (Admin SDK Directory API). Portable SQLite + PostgreSQL.

CREATE TABLE IF NOT EXISTS workspace_provisioning_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_user_provisionings (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  requested_username TEXT NOT NULL,
  full_email TEXT NOT NULL,
  status TEXT NOT NULL,
  google_user_id TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (batch_id) REFERENCES workspace_provisioning_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_batches_status ON workspace_provisioning_batches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_users_batch_status ON workspace_user_provisionings(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_workspace_users_email ON workspace_user_provisionings(full_email);
CREATE INDEX IF NOT EXISTS idx_workspace_users_username ON workspace_user_provisionings(requested_username);

-- Workspace jobs are executed by the API controller, not Android workers, so account_id may be null.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  account_id TEXT,
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

INSERT INTO jobs_new (
  id, account_id, worker_id, run_id, execution_id, configuration, status, attempt_count,
  created_at, scheduled_at, started_at, completed_at, error_code, error_message, updated_at
)
SELECT
  id, account_id, worker_id, run_id, execution_id, configuration, status, attempt_count,
  created_at, scheduled_at, started_at, completed_at, error_code, error_message, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled ON jobs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_worker ON jobs(worker_id);
