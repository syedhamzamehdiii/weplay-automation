import type { DeviceFarmProvisioning, DeviceFarmProvisioningStatus, ErrorCode } from "@weplay/types";
import type { DbClient } from "../db/types.js";

interface Row {
  id: string;
  account_id: string;
  workspace_user_id: string;
  workspace_email: string;
  devicefarm_run_arn: string | null;
  devicefarm_job_arn: string | null;
  device_arn: string | null;
  device_name: string | null;
  weplay_user_id: string | null;
  provisioning_status: string;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function mapRow(row: Row): DeviceFarmProvisioning {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceUserId: row.workspace_user_id,
    workspaceEmail: row.workspace_email,
    deviceFarmRunArn: row.devicefarm_run_arn,
    deviceFarmJobArn: row.devicefarm_job_arn,
    deviceArn: row.device_arn,
    deviceName: row.device_name,
    weplayUserId: row.weplay_user_id,
    provisioningStatus: row.provisioning_status as DeviceFarmProvisioningStatus,
    errorCode: (row.error_code as ErrorCode | null) ?? null,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at)
  };
}

export class DeviceFarmProvisioningRepository {
  constructor(private readonly db: DbClient) {}

  async insert(row: DeviceFarmProvisioning): Promise<void> {
    await this.db.execute(
      `INSERT INTO devicefarm_provisionings (
        id, account_id, workspace_user_id, workspace_email, devicefarm_run_arn, devicefarm_job_arn,
        device_arn, device_name, weplay_user_id, provisioning_status, error_code, error_message,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.accountId,
        row.workspaceUserId,
        row.workspaceEmail,
        row.deviceFarmRunArn,
        row.deviceFarmJobArn,
        row.deviceArn,
        row.deviceName,
        row.weplayUserId,
        row.provisioningStatus,
        row.errorCode,
        row.errorMessage,
        row.createdAt,
        row.updatedAt,
        row.startedAt,
        row.completedAt
      ]
    );
  }

  async update(row: DeviceFarmProvisioning): Promise<void> {
    await this.db.execute(
      `UPDATE devicefarm_provisionings SET
        devicefarm_run_arn = ?, devicefarm_job_arn = ?, device_arn = ?, device_name = ?,
        weplay_user_id = ?, provisioning_status = ?, error_code = ?, error_message = ?,
        updated_at = ?, started_at = ?, completed_at = ?
      WHERE id = ?`,
      [
        row.deviceFarmRunArn,
        row.deviceFarmJobArn,
        row.deviceArn,
        row.deviceName,
        row.weplayUserId,
        row.provisioningStatus,
        row.errorCode,
        row.errorMessage,
        row.updatedAt,
        row.startedAt,
        row.completedAt,
        row.id
      ]
    );
  }

  async getById(id: string): Promise<DeviceFarmProvisioning | undefined> {
    const row = await this.db.queryOne<Row>("SELECT * FROM devicefarm_provisionings WHERE id = ?", [id]);
    return row ? mapRow(row) : undefined;
  }

  async listByAccount(accountId: string): Promise<DeviceFarmProvisioning[]> {
    const rows = await this.db.query<Row>(
      "SELECT * FROM devicefarm_provisionings WHERE account_id = ? ORDER BY created_at DESC",
      [accountId]
    );
    return rows.map(mapRow);
  }

  async latestByAccount(accountId: string): Promise<DeviceFarmProvisioning | undefined> {
    const row = await this.db.queryOne<Row>(
      "SELECT * FROM devicefarm_provisionings WHERE account_id = ? ORDER BY created_at DESC LIMIT 1",
      [accountId]
    );
    return row ? mapRow(row) : undefined;
  }

  async listByRunArn(runArn: string): Promise<DeviceFarmProvisioning[]> {
    const rows = await this.db.query<Row>(
      "SELECT * FROM devicefarm_provisionings WHERE devicefarm_run_arn = ? ORDER BY created_at ASC",
      [runArn]
    );
    return rows.map(mapRow);
  }

  async countInFlight(): Promise<number> {
    const row = await this.db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM devicefarm_provisionings
       WHERE provisioning_status IN ('PENDING', 'RUNNING')`
    );
    return Number(row?.count ?? 0);
  }

  async listInFlight(): Promise<DeviceFarmProvisioning[]> {
    const rows = await this.db.query<Row>(
      `SELECT * FROM devicefarm_provisionings
       WHERE provisioning_status IN ('PENDING', 'RUNNING')
       ORDER BY created_at ASC`
    );
    return rows.map(mapRow);
  }
}
