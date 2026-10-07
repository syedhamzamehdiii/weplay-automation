import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "./types.js";

function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function splitStatements(sql: string): string[] {
  return stripComments(sql)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function migrate(db: DbClient): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`
  );

  const dir = path.join(repoRoot(), "database", "migrations");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

  for (const file of files) {
    const applied = await db.queryOne<{ id: string }>("SELECT id FROM schema_migrations WHERE id = ?", [file]);
    if (applied) {
      continue;
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(sql)) {
        await tx.execute(statement);
      }
      await tx.execute("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [file, Date.now()]);
    });
  }
}
