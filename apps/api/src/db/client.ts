import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl } from "@weplay/config";
import { createPostgresClient } from "./postgres.js";
import { SqliteClient } from "./sqlite.js";
import type { DbClient } from "./types.js";

function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

export function createDb(databaseUrl: string): DbClient {
  const parsed = parseDatabaseUrl(databaseUrl);
  if (parsed.dialect === "postgres") {
    return createPostgresClient(parsed.postgresUrl!);
  }
  let sqlitePath = parsed.sqlitePath ?? ":memory:";
  if (sqlitePath !== ":memory:" && sqlitePath !== "file::memory:?cache=shared") {
    if (!path.isAbsolute(sqlitePath)) {
      sqlitePath = path.resolve(repoRoot(), sqlitePath);
    }
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }
  return new SqliteClient(sqlitePath);
}

export type { DbClient } from "./types.js";
