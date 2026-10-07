import type { ErrorCode, WorkspaceBatchStatus, WorkspaceProvisioningBatch, WorkspaceUserProvisioning, WorkspaceUserStatus } from "@weplay/types";
import type { DbClient } from "../db/types.js";

interface BatchRow {
  id: string;
  name: string;
  domain: string;
  status: string;
  requested_count: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface UserRow {
  id: string;
  batch_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  requested_username: string;
  full_email: string;
  status: string;
  google_user_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function mapBatch(row: BatchRow): WorkspaceProvisioningBatch {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    status: row.status as WorkspaceBatchStatus,
    requestedCount: Number(row.requested_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at)
  };
}

function mapUser(row: UserRow): WorkspaceUserProvisioning {
  return {
    id: row.id,
    batchId: row.batch_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    requestedUsername: row.requested_username,
    fullEmail: row.full_email,
    status: row.status as WorkspaceUserStatus,
    googleUserId: row.google_user_id,
    errorCode: (row.error_code as ErrorCode | null) ?? null,
    errorMessage: row.error_message,
    attemptCount: Number(row.attempt_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at)
  };
}

export class WorkspaceProvisioningRepository {
  constructor(private readonly db: DbClient) {}

  async insertBatch(batch: WorkspaceProvisioningBatch): Promise<void> {
    await this.db.execute(
      `INSERT INTO workspace_provisioning_batches (
        id, name, domain, status, requested_count, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        batch.id,
        batch.name,
        batch.domain,
        batch.status,
        batch.requestedCount,
        batch.createdAt,
        batch.updatedAt,
        batch.startedAt,
        batch.completedAt
      ]
    );
  }

  async updateBatch(batch: WorkspaceProvisioningBatch): Promise<void> {
    await this.db.execute(
      `UPDATE workspace_provisioning_batches SET
        name = ?, domain = ?, status = ?, requested_count = ?, updated_at = ?, started_at = ?, completed_at = ?
       WHERE id = ?`,
      [batch.name, batch.domain, batch.status, batch.requestedCount, batch.updatedAt, batch.startedAt, batch.completedAt, batch.id]
    );
  }

  async getBatch(id: string): Promise<WorkspaceProvisioningBatch | undefined> {
    const row = await this.db.queryOne<BatchRow>("SELECT * FROM workspace_provisioning_batches WHERE id = ?", [id]);
    return row ? mapBatch(row) : undefined;
  }

  async listBatches(limit = 50): Promise<WorkspaceProvisioningBatch[]> {
    const rows = await this.db.query<BatchRow>(
      "SELECT * FROM workspace_provisioning_batches ORDER BY created_at DESC LIMIT ?",
      [Math.min(limit, 200)]
    );
    return rows.map(mapBatch);
  }

  async listBatchesByStatus(status: WorkspaceBatchStatus): Promise<WorkspaceProvisioningBatch[]> {
    const rows = await this.db.query<BatchRow>(
      "SELECT * FROM workspace_provisioning_batches WHERE status = ? ORDER BY created_at ASC",
      [status]
    );
    return rows.map(mapBatch);
  }

  async insertUser(user: WorkspaceUserProvisioning): Promise<void> {
    await this.db.execute(
      `INSERT INTO workspace_user_provisionings (
        id, batch_id, first_name, last_name, display_name, requested_username, full_email, status,
        google_user_id, error_code, error_message, attempt_count, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.batchId,
        user.firstName,
        user.lastName,
        user.displayName,
        user.requestedUsername,
        user.fullEmail,
        user.status,
        user.googleUserId,
        user.errorCode,
        user.errorMessage,
        user.attemptCount,
        user.createdAt,
        user.updatedAt,
        user.completedAt
      ]
    );
  }

  async insertUsers(users: WorkspaceUserProvisioning[]): Promise<void> {
    for (const user of users) {
      await this.insertUser(user);
    }
  }

  async updateUser(user: WorkspaceUserProvisioning): Promise<void> {
    await this.db.execute(
      `UPDATE workspace_user_provisionings SET
        first_name = ?, last_name = ?, display_name = ?, requested_username = ?, full_email = ?, status = ?,
        google_user_id = ?, error_code = ?, error_message = ?, attempt_count = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [
        user.firstName,
        user.lastName,
        user.displayName,
        user.requestedUsername,
        user.fullEmail,
        user.status,
        user.googleUserId,
        user.errorCode,
        user.errorMessage,
        user.attemptCount,
        user.updatedAt,
        user.completedAt,
        user.id
      ]
    );
  }

  async getUser(id: string): Promise<WorkspaceUserProvisioning | undefined> {
    const row = await this.db.queryOne<UserRow>("SELECT * FROM workspace_user_provisionings WHERE id = ?", [id]);
    return row ? mapUser(row) : undefined;
  }

  async listUsers(batchId: string, filters: { status?: string; limit?: number } = {}): Promise<WorkspaceUserProvisioning[]> {
    const clauses = ["batch_id = ?"];
    const params: unknown[] = [batchId];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const limit = Math.min(filters.limit ?? 2000, 5000);
    const rows = await this.db.query<UserRow>(
      `SELECT * FROM workspace_user_provisionings WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(mapUser);
  }

  async listUsersByStatuses(batchId: string, statuses: WorkspaceUserStatus[], limit: number): Promise<WorkspaceUserProvisioning[]> {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = await this.db.query<UserRow>(
      `SELECT * FROM workspace_user_provisionings
       WHERE batch_id = ? AND status IN (${placeholders})
       ORDER BY created_at ASC
       LIMIT ?`,
      [batchId, ...statuses, limit]
    );
    return rows.map(mapUser);
  }

  async listUsersByStatus(status: WorkspaceUserStatus, limit = 10_000): Promise<WorkspaceUserProvisioning[]> {
    const rows = await this.db.query<UserRow>(
      `SELECT * FROM workspace_user_provisionings WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
      [status, limit]
    );
    return rows.map(mapUser);
  }

  async countsByStatus(batchId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; count: number }>(
      "SELECT status, COUNT(*) as count FROM workspace_user_provisionings WHERE batch_id = ? GROUP BY status",
      [batchId]
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = Number(row.count);
    }
    return result;
  }

  async cancelOpenUsers(batchId: string, updatedAt: number): Promise<void> {
    await this.db.execute(
      `UPDATE workspace_user_provisionings
       SET status = 'FAILED', error_code = 'CANCELLED', error_message = 'Provisioning cancelled before completion',
           updated_at = ?, completed_at = ?
       WHERE batch_id = ? AND status IN ('PENDING', 'VALIDATING', 'RETRYING')`,
      [updatedAt, updatedAt, batchId]
    );
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.execute("DELETE FROM workspace_user_provisionings WHERE id = ?", [id]);
  }

  async deleteBatch(id: string): Promise<void> {
    await this.db.execute("DELETE FROM workspace_user_provisionings WHERE batch_id = ?", [id]);
    await this.db.execute("DELETE FROM workspace_provisioning_batches WHERE id = ?", [id]);
  }

  async tryMarkCreating(id: string, updatedAt: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE workspace_user_provisionings
       SET status = 'CREATING', updated_at = ?
       WHERE id = ? AND status IN ('PENDING', 'RETRYING', 'VALIDATING', 'CREATING')`,
      [updatedAt, id]
    );
    return result.changes === 1;
  }
}
