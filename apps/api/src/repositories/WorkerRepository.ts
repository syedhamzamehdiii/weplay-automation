import type { Worker, WorkerStatus } from "@weplay/types";
import type { DbClient } from "../db/types.js";

interface WorkerRow {
  id: string;
  name: string;
  device_identifier: string;
  platform: string;
  status: string;
  worker_version: string;
  last_heartbeat: number | null;
  current_job_id: string | null;
  token_hash: string;
  created_at: number;
  updated_at: number;
}

function mapWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    deviceIdentifier: row.device_identifier,
    platform: "ANDROID",
    status: row.status as WorkerStatus,
    workerVersion: row.worker_version,
    lastHeartbeat: row.last_heartbeat === null ? null : Number(row.last_heartbeat),
    currentJobId: row.current_job_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class WorkerRepository {
  constructor(private readonly db: DbClient) {}

  async list(): Promise<Worker[]> {
    const rows = await this.db.query<WorkerRow>("SELECT * FROM workers ORDER BY created_at ASC");
    return rows.map(mapWorker);
  }

  async getById(id: string): Promise<Worker | undefined> {
    const row = await this.db.queryOne<WorkerRow>("SELECT * FROM workers WHERE id = ?", [id]);
    return row ? mapWorker(row) : undefined;
  }

  async getByDeviceIdentifier(deviceIdentifier: string): Promise<(Worker & { tokenHash: string }) | undefined> {
    const row = await this.db.queryOne<WorkerRow>("SELECT * FROM workers WHERE device_identifier = ?", [
      deviceIdentifier
    ]);
    return row ? { ...mapWorker(row), tokenHash: row.token_hash } : undefined;
  }

  async getWithTokenHash(id: string): Promise<(Worker & { tokenHash: string }) | undefined> {
    const row = await this.db.queryOne<WorkerRow>("SELECT * FROM workers WHERE id = ?", [id]);
    return row ? { ...mapWorker(row), tokenHash: row.token_hash } : undefined;
  }

  async insert(worker: Worker, tokenHash: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO workers (
        id, name, device_identifier, platform, status, worker_version,
        last_heartbeat, current_job_id, token_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        worker.id,
        worker.name,
        worker.deviceIdentifier,
        worker.platform,
        worker.status,
        worker.workerVersion,
        worker.lastHeartbeat,
        worker.currentJobId,
        tokenHash,
        worker.createdAt,
        worker.updatedAt
      ]
    );
  }

  async update(worker: Worker): Promise<void> {
    await this.db.execute(
      `UPDATE workers SET
        name = ?, status = ?, worker_version = ?, last_heartbeat = ?,
        current_job_id = ?, updated_at = ?
      WHERE id = ?`,
      [worker.name, worker.status, worker.workerVersion, worker.lastHeartbeat, worker.currentJobId, worker.updatedAt, worker.id]
    );
  }

  async updateTokenHash(id: string, tokenHash: string, updatedAt: number): Promise<void> {
    await this.db.execute("UPDATE workers SET token_hash = ?, updated_at = ? WHERE id = ?", [tokenHash, updatedAt, id]);
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("UPDATE jobs SET worker_id = NULL WHERE worker_id = ?", [id]);
    await this.db.execute("DELETE FROM workers WHERE id = ?", [id]);
  }

  async listStale(cutoff: number): Promise<Worker[]> {
    const rows = await this.db.query<WorkerRow>(
      "SELECT * FROM workers WHERE status != 'OFFLINE' AND (last_heartbeat IS NULL OR last_heartbeat < ?)",
      [cutoff]
    );
    return rows.map(mapWorker);
  }

  async counts(): Promise<{ online: number; offline: number }> {
    const rows = await this.db.query<{ status: string; count: number }>(
      "SELECT status, COUNT(*) as count FROM workers GROUP BY status"
    );
    let online = 0;
    let offline = 0;
    for (const row of rows) {
      const n = Number(row.count);
      if (row.status === "OFFLINE" || row.status === "ERROR" || row.status === "STOPPING") {
        offline += n;
      } else {
        online += n;
      }
    }
    return { online, offline };
  }
}
