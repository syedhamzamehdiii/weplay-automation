import type { Account, AccountStatus, ErrorCode, LoginProvider, SetupStatus } from "@weplay/types";
import { fromBool, parseJson, toBool } from "../http.js";
import type { DbClient } from "../db/types.js";

interface AccountRow {
  id: string;
  display_name: string;
  login_provider: string;
  status: string;
  setup_status: string;
  worker_id: string | null;
  enabled: number | boolean;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  metadata: string;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    displayName: row.display_name,
    loginProvider: row.login_provider as LoginProvider,
    status: row.status as AccountStatus,
    setupStatus: row.setup_status as SetupStatus,
    workerId: row.worker_id,
    enabled: toBool(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    lastSuccessAt: row.last_success_at === null ? null : Number(row.last_success_at),
    lastFailureAt: row.last_failure_at === null ? null : Number(row.last_failure_at),
    lastErrorCode: (row.last_error_code as ErrorCode | null) ?? null,
    lastErrorMessage: row.last_error_message,
    metadata: parseJson(row.metadata, {})
  };
}

export class AccountRepository {
  constructor(private readonly db: DbClient) {}

  async list(): Promise<Account[]> {
    const rows = await this.db.query<AccountRow>("SELECT * FROM accounts ORDER BY created_at ASC");
    return rows.map(mapAccount);
  }

  async getById(id: string): Promise<Account | undefined> {
    const row = await this.db.queryOne<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
    return row ? mapAccount(row) : undefined;
  }

  async getByIds(ids: string[]): Promise<Account[]> {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.db.query<AccountRow>(
      `SELECT * FROM accounts WHERE id IN (${placeholders})`,
      ids
    );
    return rows.map(mapAccount);
  }

  async findByWorkspaceEmail(email: string): Promise<Account | undefined> {
    const normalized = email.trim().toLowerCase();
    const accounts = await this.list();
    return accounts.find((account) => String(account.metadata.workspaceEmail ?? "").toLowerCase() === normalized);
  }

  async insert(account: Account): Promise<void> {
    await this.db.execute(
      `INSERT INTO accounts (
        id, display_name, login_provider, status, setup_status, worker_id, enabled,
        created_at, updated_at, last_used_at, last_success_at, last_failure_at,
        last_error_code, last_error_message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        account.id,
        account.displayName,
        account.loginProvider,
        account.status,
        account.setupStatus,
        account.workerId,
        fromBool(account.enabled),
        account.createdAt,
        account.updatedAt,
        account.lastUsedAt,
        account.lastSuccessAt,
        account.lastFailureAt,
        account.lastErrorCode,
        account.lastErrorMessage,
        JSON.stringify(account.metadata)
      ]
    );
  }

  async update(account: Account): Promise<void> {
    await this.db.execute(
      `UPDATE accounts SET
        display_name = ?, login_provider = ?, status = ?, setup_status = ?, worker_id = ?,
        enabled = ?, updated_at = ?, last_used_at = ?, last_success_at = ?, last_failure_at = ?,
        last_error_code = ?, last_error_message = ?, metadata = ?
      WHERE id = ?`,
      [
        account.displayName,
        account.loginProvider,
        account.status,
        account.setupStatus,
        account.workerId,
        fromBool(account.enabled),
        account.updatedAt,
        account.lastUsedAt,
        account.lastSuccessAt,
        account.lastFailureAt,
        account.lastErrorCode,
        account.lastErrorMessage,
        JSON.stringify(account.metadata),
        account.id
      ]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM devicefarm_provisionings WHERE account_id = ?", [id]);
    await this.db.execute("DELETE FROM jobs WHERE account_id = ?", [id]);
    await this.db.execute("DELETE FROM accounts WHERE id = ?", [id]);
  }

  async clearWorker(workerId: string): Promise<void> {
    await this.db.execute("UPDATE accounts SET worker_id = NULL, updated_at = ? WHERE worker_id = ?", [
      Date.now(),
      workerId
    ]);
  }

  async countsByStatus(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; count: number }>(
      "SELECT status, COUNT(*) as count FROM accounts GROUP BY status"
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = Number(row.count);
    }
    return result;
  }

  async total(): Promise<number> {
    const row = await this.db.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM accounts");
    return Number(row?.count ?? 0);
  }
}
