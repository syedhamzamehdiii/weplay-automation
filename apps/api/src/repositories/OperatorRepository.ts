import type { Operator } from "@weplay/types";
import type { DbClient } from "../db/types.js";

interface OperatorRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: number;
}

export class OperatorRepository {
  constructor(private readonly db: DbClient) {}

  async getByUsername(username: string): Promise<(Operator & { passwordHash: string }) | undefined> {
    const row = await this.db.queryOne<OperatorRow>("SELECT * FROM operators WHERE username = ?", [username]);
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      username: row.username,
      role: "admin",
      createdAt: Number(row.created_at),
      passwordHash: row.password_hash
    };
  }

  async getById(id: string): Promise<Operator | undefined> {
    const row = await this.db.queryOne<OperatorRow>("SELECT * FROM operators WHERE id = ?", [id]);
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      username: row.username,
      role: "admin",
      createdAt: Number(row.created_at)
    };
  }
}
