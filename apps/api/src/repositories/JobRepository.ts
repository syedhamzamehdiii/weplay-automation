import type { ErrorCode, Job, JobConfiguration, JobStatus } from "@weplay/types";
import { parseJson } from "../http.js";
import type { DbClient } from "../db/types.js";

interface JobRow {
  id: string;
  account_id: string | null;
  worker_id: string | null;
  run_id: string | null;
  execution_id: string;
  configuration: string;
  status: string;
  attempt_count: number;
  created_at: number;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: number;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    accountId: row.account_id ?? null,
    workerId: row.worker_id,
    runId: row.run_id,
    executionId: row.execution_id,
    configuration: parseJson<JobConfiguration>(row.configuration, { kind: "support" }),
    status: row.status as JobStatus,
    attemptCount: Number(row.attempt_count),
    createdAt: Number(row.created_at),
    scheduledAt: Number(row.scheduled_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    errorCode: (row.error_code as ErrorCode | null) ?? null,
    errorMessage: row.error_message,
    updatedAt: Number(row.updated_at)
  };
}

export class JobRepository {
  constructor(private readonly db: DbClient) {}

  async getById(id: string): Promise<Job | undefined> {
    const row = await this.db.queryOne<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
    return row ? mapJob(row) : undefined;
  }

  async list(filters: { status?: string; accountId?: string; runId?: string; kind?: string; limit?: number }): Promise<Job[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.accountId) {
      clauses.push("account_id = ?");
      params.push(filters.accountId);
    }
    if (filters.runId) {
      clauses.push("run_id = ?");
      params.push(filters.runId);
    }
    if (filters.kind) {
      clauses.push("configuration LIKE ?");
      params.push(`%"kind":"${filters.kind}"%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 200, 1000);
    const rows = await this.db.query<JobRow>(
      `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(mapJob);
  }

  async insert(job: Job): Promise<void> {
    await this.db.execute(
      `INSERT INTO jobs (
        id, account_id, worker_id, run_id, execution_id, configuration, status, attempt_count,
        created_at, scheduled_at, started_at, completed_at, error_code, error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.accountId,
        job.workerId,
        job.runId,
        job.executionId,
        JSON.stringify(job.configuration),
        job.status,
        job.attemptCount,
        job.createdAt,
        job.scheduledAt,
        job.startedAt,
        job.completedAt,
        job.errorCode,
        job.errorMessage,
        job.updatedAt
      ]
    );
  }

  async update(job: Job): Promise<void> {
    await this.db.execute(
      `UPDATE jobs SET
        worker_id = ?, execution_id = ?, configuration = ?, status = ?, attempt_count = ?,
        scheduled_at = ?, started_at = ?, completed_at = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ?`,
      [
        job.workerId,
        job.executionId,
        JSON.stringify(job.configuration),
        job.status,
        job.attemptCount,
        job.scheduledAt,
        job.startedAt,
        job.completedAt,
        job.errorCode,
        job.errorMessage,
        job.updatedAt,
        job.id
      ]
    );
  }

  async listQueuedDueForWorker(now: number, workerId: string, limit = 100): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      `SELECT jobs.* FROM jobs
       INNER JOIN accounts ON accounts.id = jobs.account_id
       WHERE jobs.status = 'QUEUED'
         AND jobs.scheduled_at <= ?
         AND (
           accounts.worker_id = ?
           OR (
             accounts.worker_id IS NULL
             AND (
               jobs.configuration LIKE '%"kind":"setup"%'
               OR jobs.configuration LIKE '%"kind":"reauth"%'
               OR jobs.configuration LIKE '%"kind":"join_room"%'
               OR jobs.configuration LIKE '%"kind":"create_account"%'
             )
           )
         )
         AND jobs.configuration NOT LIKE '%"kind":"workspace_provision"%'
         AND jobs.configuration NOT LIKE '%"kind":"devicefarm_provision"%'
       ORDER BY jobs.scheduled_at ASC
       LIMIT ?`,
      [now, workerId, limit]
    );
    return rows.map(mapJob);
  }

  async listQueuedDue(now: number, limit = 100): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      "SELECT * FROM jobs WHERE status = 'QUEUED' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT ?",
      [now, limit]
    );
    return rows.map(mapJob);
  }

  async listInFlight(): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      "SELECT * FROM jobs WHERE status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'RETRYING')"
    );
    return rows.map(mapJob);
  }

  async listAssignedOrRunning(): Promise<Job[]> {
    const rows = await this.db.query<JobRow>("SELECT * FROM jobs WHERE status IN ('ASSIGNED', 'RUNNING')");
    return rows.map(mapJob);
  }

  async hasInFlightForAccountRun(accountId: string, runId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM jobs
       WHERE account_id = ? AND run_id = ? AND status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'RETRYING')`,
      [accountId, runId]
    );
    return Number(row?.count ?? 0) > 0;
  }

  async latestCompletedForAccountRun(accountId: string, runId: string): Promise<Job | undefined> {
    const row = await this.db.queryOne<JobRow>(
      `SELECT * FROM jobs
       WHERE account_id = ? AND run_id = ? AND status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
       ORDER BY completed_at DESC LIMIT 1`,
      [accountId, runId]
    );
    return row ? mapJob(row) : undefined;
  }

  async cancelQueuedForRun(runId: string, updatedAt: number): Promise<number> {
    const result = await this.db.execute(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = ?, updated_at = ?
       WHERE run_id = ? AND status IN ('QUEUED', 'RETRYING', 'ASSIGNED')`,
      [updatedAt, updatedAt, runId]
    );
    return result.changes;
  }

  async cancelQueuedForAccount(accountId: string, updatedAt: number): Promise<void> {
    await this.db.execute(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = ?, updated_at = ?, error_code = 'CANCELLED', error_message = 'Account removed or disabled'
       WHERE account_id = ? AND status IN ('QUEUED', 'RETRYING', 'ASSIGNED')`,
      [updatedAt, updatedAt, accountId]
    );
  }

  async cancelQueuedUsbJobsForAccount(accountId: string, updatedAt: number): Promise<void> {
    await this.db.execute(
      `UPDATE jobs SET status = 'CANCELLED', completed_at = ?, updated_at = ?, error_code = 'CANCELLED',
          error_message = 'Cancelled so a Device Farm worker can start'
       WHERE account_id = ?
         AND status IN ('QUEUED', 'RETRYING', 'ASSIGNED')
         AND configuration NOT LIKE '%"kind":"devicefarm_provision"%'
         AND configuration NOT LIKE '%"kind":"workspace_provision"%'`,
      [updatedAt, updatedAt, accountId]
    );
  }

  async counts(): Promise<{ queued: number; running: number; completed: number }> {
    const rows = await this.db.query<{ status: string; count: number }>(
      "SELECT status, COUNT(*) as count FROM jobs GROUP BY status"
    );
    let queued = 0;
    let running = 0;
    let completed = 0;
    for (const row of rows) {
      const n = Number(row.count);
      if (row.status === "QUEUED" || row.status === "RETRYING") {
        queued += n;
      } else if (row.status === "ASSIGNED" || row.status === "RUNNING") {
        running += n;
      } else if (row.status === "SUCCEEDED") {
        completed += n;
      }
    }
    return { queued, running, completed };
  }

  async tryClaim(jobId: string, workerId: string, updatedAt: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE jobs SET status = 'ASSIGNED', worker_id = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
      [workerId, updatedAt, jobId]
    );
    return result.changes === 1;
  }

  async listQueuedWorkspaceDue(now: number, limit: number): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'QUEUED'
         AND scheduled_at <= ?
         AND configuration LIKE '%"kind":"workspace_provision"%'
       ORDER BY scheduled_at ASC
       LIMIT ?`,
      [now, limit]
    );
    return rows.map(mapJob);
  }

  async listQueuedDeviceFarmDue(now: number, limit: number): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'QUEUED'
         AND scheduled_at <= ?
         AND configuration LIKE '%"kind":"devicefarm_provision"%'
       ORDER BY scheduled_at ASC
       LIMIT ?`,
      [now, limit]
    );
    return rows.map(mapJob);
  }

  async countWorkspaceInFlight(): Promise<number> {
    const row = await this.db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM jobs
       WHERE status IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'RETRYING')
         AND configuration LIKE '%"kind":"workspace_provision"%'`
    );
    return Number(row?.count ?? 0);
  }

  async listQueuedDeviceFarmJoinDue(now: number, limit: number): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'QUEUED'
         AND scheduled_at <= ?
         AND configuration LIKE '%"kind":"devicefarm_join"%'
       ORDER BY scheduled_at ASC
       LIMIT ?`,
      [now, limit]
    );
    return rows.map(mapJob);
  }

  async listQueuedJoinRoomDue(now: number, limit: number): Promise<Job[]> {
    const rows = await this.db.query<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'QUEUED'
         AND scheduled_at <= ?
         AND configuration LIKE '%"kind":"join_room"%'
       ORDER BY scheduled_at ASC
       LIMIT ?`,
      [now, limit]
    );
    return rows.map(mapJob);
  }

  async tryStartInternal(jobId: string, updatedAt: number): Promise<boolean> {
    const result = await this.db.execute(
      "UPDATE jobs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
      [updatedAt, updatedAt, jobId]
    );
    return result.changes === 1;
  }
}
