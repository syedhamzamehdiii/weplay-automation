import { Pool } from "pg";
import type { DbClient } from "./types.js";

function toPg(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

type PgQueryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

class PgSession implements DbClient {
  readonly dialect = "postgres" as const;

  constructor(
    private readonly client: PgQueryable,
    private readonly pool?: Pool
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(toPg(sql), params);
    return result.rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.client.query(toPg(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      return fn(this);
    }
    const conn = await this.pool.connect();
    const session = new PgSession(conn);
    try {
      await conn.query("BEGIN");
      const value = await fn(session);
      await conn.query("COMMIT");
      return value;
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

export function createPostgresClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });
  return new PgSession(pool, pool);
}
