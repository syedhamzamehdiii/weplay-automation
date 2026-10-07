import { createId, now } from "@weplay/shared";
import type { Run, RunConfiguration } from "@weplay/types";
import { HttpError } from "../http.js";
import type { RunRepository } from "../repositories/RunRepository.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { SettingsService } from "./SettingsService.js";
import type { LogService } from "./LogService.js";
import type { EventBus } from "../events/bus.js";

export class RunService {
  constructor(
    private readonly runs: RunRepository,
    private readonly jobs: JobRepository,
    private readonly settings: SettingsService,
    private readonly logs: LogService,
    private readonly bus: EventBus
  ) {}

  list() {
    return this.runs.list();
  }

  async get(id: string): Promise<Run> {
    const run = await this.runs.getById(id);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  async create(input: { name: string; configuration: RunConfiguration }): Promise<Run> {
    const settings = await this.settings.read();
    if (!settings.allowedDurationsMs.includes(input.configuration.durationMs)) {
      throw new HttpError(400, "Duration is not in the allowed list", "INVALID_CONFIGURATION");
    }
    if (input.configuration.intervalMs < 0) {
      throw new HttpError(400, "Interval must be >= 0", "INVALID_CONFIGURATION");
    }
    if (!input.configuration.roomId.trim()) {
      throw new HttpError(400, "Room ID is required", "INVALID_CONFIGURATION");
    }
    if (input.configuration.kind === "support" && !input.configuration.supportTarget.trim()) {
      throw new HttpError(400, "Support target is required for support runs", "INVALID_CONFIGURATION");
    }
    if (input.configuration.accountIds.length === 0) {
      throw new HttpError(400, "Select at least one account", "INVALID_CONFIGURATION");
    }
    const ts = now();
    const run: Run = {
      id: createId(),
      name: input.name,
      configuration: {
        ...input.configuration,
        kind: input.configuration.kind ?? "join_room",
        supportTarget: input.configuration.supportTarget ?? ""
      },
      status: "DRAFT",
      startedAt: null,
      endsAt: null,
      createdAt: ts,
      updatedAt: ts
    };
    await this.runs.insert(run);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: run.id,
      event: "RUN_CREATED",
      status: run.status,
      error: null,
      message: `Run ${run.name} created`
    });
    this.bus.publish("changed", { source: "run" });
    return run;
  }

  async start(id: string): Promise<Run> {
    const run = await this.get(id);
    if (run.status !== "DRAFT" && run.status !== "PAUSED" && run.status !== "STOPPED") {
      throw new HttpError(409, `Run cannot start from ${run.status}`);
    }
    const ts = now();
    run.status = "ACTIVE";
    run.startedAt = ts;
    run.endsAt = ts + run.configuration.durationMs;
    run.updatedAt = ts;
    await this.runs.update(run);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: run.id,
      event: "RUN_STARTED",
      status: run.status,
      error: null,
      message: "Run started"
    });
    this.bus.publish("changed", { source: "run" });
    return run;
  }

  async pause(id: string): Promise<Run> {
    const run = await this.get(id);
    if (run.status !== "ACTIVE") {
      throw new HttpError(409, "Only active runs can be paused");
    }
    run.status = "PAUSED";
    run.updatedAt = now();
    await this.runs.update(run);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: run.id,
      event: "RUN_PAUSED",
      status: run.status,
      error: null,
      message: "Run paused"
    });
    this.bus.publish("changed", { source: "run" });
    return run;
  }

  async resume(id: string): Promise<Run> {
    const run = await this.get(id);
    if (run.status !== "PAUSED") {
      throw new HttpError(409, "Only paused runs can be resumed");
    }
    run.status = "ACTIVE";
    run.updatedAt = now();
    await this.runs.update(run);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: run.id,
      event: "RUN_RESUMED",
      status: run.status,
      error: null,
      message: "Run resumed"
    });
    this.bus.publish("changed", { source: "run" });
    return run;
  }

  async stop(id: string): Promise<Run> {
    const run = await this.get(id);
    const ts = now();
    run.status = "STOPPED";
    run.updatedAt = ts;
    await this.runs.update(run);
    await this.jobs.cancelQueuedForRun(run.id, ts);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: run.id,
      event: "RUN_STOPPED",
      status: run.status,
      error: null,
      message: "Run stopped"
    });
    this.bus.publish("changed", { source: "run" });
    return run;
  }

  async completeIfExpired(run: Run, ts: number): Promise<Run> {
    if (run.status === "ACTIVE" && run.endsAt !== null && ts >= run.endsAt) {
      run.status = "COMPLETED";
      run.updatedAt = ts;
      await this.runs.update(run);
      await this.jobs.cancelQueuedForRun(run.id, ts);
      await this.logs.record({
        accountId: null,
        jobId: null,
        workerId: null,
        runId: run.id,
        event: "RUN_COMPLETED",
        status: run.status,
        error: null,
        message: "Run duration elapsed"
      });
      this.bus.publish("changed", { source: "run" });
    }
    return run;
  }
}
