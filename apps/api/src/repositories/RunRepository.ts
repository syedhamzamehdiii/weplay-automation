import type { Run, RunConfiguration, RunStatus } from "@weplay/types";
import { parseJson } from "../http.js";
import type { DbClient } from "../db/types.js";

interface RunRow {
  id: string;
  name: string;
  configuration: string;
  status: string;
  started_at: number | null;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    name: row.name,
    configuration: parseJson<RunConfiguration>(row.configuration, {
      kind: "join_room",
      roomId: "",
      supportTarget: "",
      accountIds: [],
      durationMs: 0,
      intervalMs: 0
    }),
    status: row.status as RunStatus,
    startedAt: row.started_at === null ? null : Number(row.started_at),
    endsAt: row.ends_at === null ? null : Number(row.ends_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class RunRepository {
  constructor(private readonly db: DbClient) {}

  async list(): Promise<Run[]> {
    const rows = await this.db.query<RunRow>("SELECT * FROM runs ORDER BY created_at DESC");
    return rows.map(mapRun);
  }

  async getById(id: string): Promise<Run | undefined> {
    const row = await this.db.queryOne<RunRow>("SELECT * FROM runs WHERE id = ?", [id]);
    return row ? mapRun(row) : undefined;
  }

  async insert(run: Run): Promise<void> {
    await this.db.execute(
      `INSERT INTO runs (id, name, configuration, status, started_at, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.name,
        JSON.stringify(run.configuration),
        run.status,
        run.startedAt,
        run.endsAt,
        run.createdAt,
        run.updatedAt
      ]
    );
  }

  async update(run: Run): Promise<void> {
    await this.db.execute(
      `UPDATE runs SET name = ?, configuration = ?, status = ?, started_at = ?, ends_at = ?, updated_at = ?
       WHERE id = ?`,
      [run.name, JSON.stringify(run.configuration), run.status, run.startedAt, run.endsAt, run.updatedAt, run.id]
    );
  }

  async listByStatus(status: RunStatus): Promise<Run[]> {
    const rows = await this.db.query<RunRow>("SELECT * FROM runs WHERE status = ?", [status]);
    return rows.map(mapRun);
  }
}
