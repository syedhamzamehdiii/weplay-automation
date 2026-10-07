import type { AppSettings, ControllerStatus } from "@weplay/types";
import type { AppEnv } from "@weplay/config";
import { parseJson } from "../http.js";
import type { DbClient } from "../db/types.js";

export class SettingsRepository {
  constructor(private readonly db: DbClient) {}

  async getAll(): Promise<Record<string, string>> {
    const rows = await this.db.query<{ key: string; value: string }>("SELECT key, value FROM settings");
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async set(key: string, value: string, updatedAt: number): Promise<void> {
    const existing = await this.db.queryOne("SELECT key FROM settings WHERE key = ?", [key]);
    if (existing) {
      await this.db.execute("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?", [value, updatedAt, key]);
    } else {
      await this.db.execute("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", [key, value, updatedAt]);
    }
  }

  async read(env: AppEnv): Promise<AppSettings> {
    const map = await this.getAll();
    return {
      controllerStatus: (map["controller.status"] as ControllerStatus) ?? "STOPPED",
      maxJobRetries: Number(map.max_job_retries ?? env.MAX_JOB_RETRIES),
      heartbeatTimeoutMs: Number(map.heartbeat_timeout_ms ?? env.HEARTBEAT_TIMEOUT_MS),
      defaultIntervalMs: Number(map.default_interval_ms ?? env.DEFAULT_INTERVAL_MS),
      allowedDurationsMs: parseJson(map.allowed_durations_ms, env.ALLOWED_DURATIONS_MS),
      jobStaleMs: Number(map.job_stale_ms ?? env.JOB_STALE_MS),
      controllerTickMs: Number(map.controller_tick_ms ?? env.CONTROLLER_TICK_MS)
    };
  }
}
