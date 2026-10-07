import type { AppEnv } from "@weplay/config";
import { now } from "@weplay/shared";
import type { AppSettings, ControllerStatus } from "@weplay/types";
import type { SettingsRepository } from "../repositories/SettingsRepository.js";
import type { LogService } from "./LogService.js";

export class SettingsService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly env: AppEnv,
    private readonly logs: LogService
  ) {}

  read(): Promise<AppSettings> {
    return this.settings.read(this.env);
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const ts = now();
    if (patch.controllerStatus) {
      await this.settings.set("controller.status", patch.controllerStatus, ts);
    }
    if (patch.maxJobRetries !== undefined) {
      await this.settings.set("max_job_retries", String(patch.maxJobRetries), ts);
    }
    if (patch.heartbeatTimeoutMs !== undefined) {
      await this.settings.set("heartbeat_timeout_ms", String(patch.heartbeatTimeoutMs), ts);
    }
    if (patch.defaultIntervalMs !== undefined) {
      await this.settings.set("default_interval_ms", String(patch.defaultIntervalMs), ts);
    }
    if (patch.allowedDurationsMs) {
      await this.settings.set("allowed_durations_ms", JSON.stringify(patch.allowedDurationsMs), ts);
    }
    if (patch.jobStaleMs !== undefined) {
      await this.settings.set("job_stale_ms", String(patch.jobStaleMs), ts);
    }
    if (patch.controllerTickMs !== undefined) {
      await this.settings.set("controller_tick_ms", String(patch.controllerTickMs), ts);
    }
    return this.read();
  }

  async setControllerStatus(status: ControllerStatus, event: string): Promise<AppSettings> {
    const updated = await this.update({ controllerStatus: status });
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: null,
      event,
      status,
      error: null,
      message: `Controller ${status.toLowerCase()}`
    });
    return updated;
  }
}
