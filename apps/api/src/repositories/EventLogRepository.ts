import type { EventLog } from "@weplay/types";
import { parseJson } from "../http.js";
import type { DbClient } from "../db/types.js";

interface LogRow {
  id: string;
  timestamp: number;
  account_id: string | null;
  job_id: string | null;
  worker_id: string | null;
  run_id: string | null;
  event: string;
  status: string | null;
  error: string | null;
  message: string | null;
  metadata: string;
}

function mapLog(row: LogRow): EventLog {
  return {
    id: row.id,
    timestamp: Number(row.timestamp),
    accountId: row.account_id,
    jobId: row.job_id,
    workerId: row.worker_id,
    runId: row.run_id,
    event: row.event,
    status: row.status,
    error: row.error,
    message: row.message,
    metadata: parseJson(row.metadata, {})
  };
}

export class EventLogRepository {
  constructor(private readonly db: DbClient) {}

  async insert(log: EventLog): Promise<void> {
    await this.db.execute(
      `INSERT INTO event_logs (
        id, timestamp, account_id, job_id, worker_id, run_id, event, status, error, message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.id,
        log.timestamp,
        log.accountId,
        log.jobId,
        log.workerId,
        log.runId,
        log.event,
        log.status,
        log.error,
        log.message,
        JSON.stringify(log.metadata)
      ]
    );
  }

  async list(filters: {
    accountId?: string;
    jobId?: string;
    workerId?: string;
    limit?: number;
  }): Promise<EventLog[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.accountId) {
      clauses.push("account_id = ?");
      params.push(filters.accountId);
    }
    if (filters.jobId) {
      clauses.push("job_id = ?");
      params.push(filters.jobId);
    }
    if (filters.workerId) {
      clauses.push("worker_id = ?");
      params.push(filters.workerId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 200, 1000);
    const rows = await this.db.query<LogRow>(
      `SELECT * FROM event_logs ${where} ORDER BY timestamp DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(mapLog);
  }
}
