import Database from "better-sqlite3";
import type { DbClient } from "./types.js";

export class SqliteClient implements DbClient {
  readonly dialect = "sqlite" as const;
  private depth = 0;
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes };
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    if (this.depth > 0) {
      return fn(this);
    }
    this.depth += 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = await fn(this);
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
