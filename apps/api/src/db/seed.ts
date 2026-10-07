import bcrypt from "bcryptjs";
import type { AppEnv } from "@weplay/config";
import { createId, now } from "@weplay/shared";
import type { DbClient } from "./types.js";

export async function seed(db: DbClient, env: AppEnv): Promise<void> {
  const existing = await db.queryOne<{ count: number }>("SELECT COUNT(*) as count FROM operators");
  const count = Number(existing?.count ?? 0);
  if (count === 0) {
    const passwordHash = await bcrypt.hash(env.INITIAL_ADMIN_PASSWORD, 12);
    await db.execute(
      "INSERT INTO operators (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
      [createId(), env.INITIAL_ADMIN_USERNAME, passwordHash, "admin", now()]
    );
  }

  const defaults: Array<[string, string]> = [
    ["controller.status", "STOPPED"],
    ["max_job_retries", String(env.MAX_JOB_RETRIES)],
    ["heartbeat_timeout_ms", String(env.HEARTBEAT_TIMEOUT_MS)],
    ["default_interval_ms", String(env.DEFAULT_INTERVAL_MS)],
    ["allowed_durations_ms", JSON.stringify(env.ALLOWED_DURATIONS_MS)],
    ["job_stale_ms", String(env.JOB_STALE_MS)],
    ["controller_tick_ms", String(env.CONTROLLER_TICK_MS)]
  ];

  const ts = now();
  for (const [key, value] of defaults) {
    const row = await db.queryOne("SELECT key FROM settings WHERE key = ?", [key]);
    if (!row) {
      await db.execute("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", [key, value, ts]);
    }
  }
}
