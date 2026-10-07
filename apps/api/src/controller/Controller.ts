import { isAccountEligibleForSupport, now } from "@weplay/shared";
import type { AccountRepository } from "../repositories/AccountRepository.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { WorkerRepository } from "../repositories/WorkerRepository.js";
import type { RunRepository } from "../repositories/RunRepository.js";
import type { JobService } from "../services/JobService.js";
import type { RunService } from "../services/RunService.js";
import type { SettingsService } from "../services/SettingsService.js";
import type { LogService } from "../services/LogService.js";
import type { WorkspaceProvisioningService } from "../services/WorkspaceProvisioningService.js";
import type { DeviceFarmProvisioningService } from "../services/DeviceFarmProvisioningService.js";
import type { EventBus } from "../events/bus.js";

export class Controller {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly jobs: JobRepository,
    private readonly workers: WorkerRepository,
    private readonly runs: RunRepository,
    private readonly jobService: JobService,
    private readonly runService: RunService,
    private readonly settings: SettingsService,
    private readonly logs: LogService,
    private readonly bus: EventBus,
    private readonly workspace: WorkspaceProvisioningService,
    private readonly deviceFarm: DeviceFarmProvisioningService
  ) {}

  startLoop(tickMs: number): void {
    this.stopLoop();
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref?.();
  }

  stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async recover(): Promise<void> {
    const settings = await this.settings.read();
    const ts = now();
    await this.recoverStaleJobs(ts, settings.jobStaleMs, settings.heartbeatTimeoutMs);
    await this.markStaleWorkers(ts, settings.heartbeatTimeoutMs);
    const active = await this.runs.listByStatus("ACTIVE");
    for (const run of active) {
      await this.runService.completeIfExpired(run, ts);
    }
    await this.workspace.recover();
    await this.deviceFarm.recover();
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: null,
      event: "RECOVERY_COMPLETED",
      status: settings.controllerStatus,
      error: null,
      message: "Startup recovery completed"
    });
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.workspace.processDue();
      await this.deviceFarm.processDue();
      const settings = await this.settings.read();
      const ts = now();
      await this.recoverStaleJobs(ts, settings.jobStaleMs, settings.heartbeatTimeoutMs);
      await this.markStaleWorkers(ts, settings.heartbeatTimeoutMs);

      if (settings.controllerStatus === "STOPPED") {
        return;
      }

      const active = await this.runs.listByStatus("ACTIVE");
      for (const run of active) {
        await this.runService.completeIfExpired(run, ts);
      }

      if (settings.controllerStatus === "PAUSED") {
        return;
      }

      await this.enqueueFromActiveRuns(ts);
    } catch (error) {
      await this.logs.record({
        accountId: null,
        jobId: null,
        workerId: null,
        runId: null,
        event: "WORKER_ERROR",
        status: "ERROR",
        error: "UNKNOWN_STATE",
        message: error instanceof Error ? error.message : "Controller tick failed"
      });
    } finally {
      this.ticking = false;
    }
  }

  private async markStaleWorkers(ts: number, heartbeatTimeoutMs: number): Promise<void> {
    const stale = await this.workers.listStale(ts - heartbeatTimeoutMs);
    for (const worker of stale) {
      worker.status = "OFFLINE";
      worker.updatedAt = ts;
      await this.workers.update(worker);
      await this.logs.record({
        accountId: null,
        jobId: worker.currentJobId,
        workerId: worker.id,
        runId: null,
        event: "WORKER_DISCONNECTED",
        status: "OFFLINE",
        error: "WORKER_OFFLINE",
        message: "Heartbeat expired"
      });
      const accounts = await this.accounts.list();
      for (const account of accounts) {
        if (account.workerId === worker.id && (account.status === "PROCESSING" || account.status === "READY" || account.status === "SUCCESS")) {
          account.status = "OFFLINE";
          account.updatedAt = ts;
          await this.accounts.update(account);
        }
        if (account.workerId === worker.id && account.status === "CREATING") {
          account.status = "CREATION_FAILED";
          account.updatedAt = ts;
          await this.accounts.update(account);
        }
        if (account.workerId === worker.id && account.status === "SETUP_IN_PROGRESS") {
          account.status = "SETUP_REQUIRED";
          account.setupStatus = "REQUIRED";
          account.updatedAt = ts;
          await this.accounts.update(account);
        }
      }
      this.bus.publish("changed", { source: "worker" });
    }
  }

  private async recoverStaleJobs(ts: number, jobStaleMs: number, heartbeatTimeoutMs: number): Promise<void> {
    const inflight = await this.jobs.listAssignedOrRunning();
    for (const job of inflight) {
      const worker = job.workerId ? await this.workers.getById(job.workerId) : undefined;
      if (job.configuration.kind === "workspace_provision" || job.configuration.kind === "devicefarm_provision") {
        continue;
      }
      if (
        (job.configuration.kind === "devicefarm_join" || job.configuration.kind === "join_room") &&
        !job.workerId
      ) {
        continue;
      }
      const workerGone =
        !worker ||
        worker.status === "OFFLINE" ||
        worker.lastHeartbeat === null ||
        worker.lastHeartbeat < ts - heartbeatTimeoutMs;
      const tooOld = job.updatedAt < ts - jobStaleMs;
      if (workerGone || tooOld) {
        job.status = "FAILED";
        job.completedAt = ts;
        job.errorCode = "WORKER_OFFLINE";
        job.errorMessage = "Worker disappeared during execution";
        job.updatedAt = ts;
        await this.jobs.update(job);
        await this.logs.record({
          accountId: job.accountId,
          jobId: job.id,
          workerId: job.workerId,
          runId: job.runId,
          event: "JOB_FAILED",
          status: "FAILED",
          error: "WORKER_OFFLINE",
          message: job.errorMessage
        });
        if (worker) {
          worker.status = "OFFLINE";
          worker.currentJobId = null;
          worker.updatedAt = ts;
          await this.workers.update(worker);
        }
        const account = job.accountId ? await this.accounts.getById(job.accountId) : undefined;
        if (account && account.status === "PROCESSING") {
          account.status = "FAILED";
          account.lastFailureAt = ts;
          account.lastErrorCode = "WORKER_OFFLINE";
          account.lastErrorMessage = job.errorMessage;
          account.updatedAt = ts;
          await this.accounts.update(account);
        }
        const settings = await this.settings.read();
        if (job.attemptCount + 1 < settings.maxJobRetries) {
          await this.jobService.create({
            accountId: job.accountId,
            runId: job.runId,
            configuration: job.configuration,
            scheduledAt: ts
          });
        }
      }
    }
  }

  private async enqueueFromActiveRuns(ts: number): Promise<void> {
    const active = await this.runs.listByStatus("ACTIVE");
    for (const run of active) {
      if (run.endsAt !== null && ts >= run.endsAt) {
        continue;
      }
      for (const accountId of run.configuration.accountIds) {
        const account = await this.accounts.getById(accountId);
        if (!account || !isAccountEligibleForSupport(account)) {
          continue;
        }
        if (await this.jobs.hasInFlightForAccountRun(accountId, run.id)) {
          continue;
        }
        const kind = run.configuration.kind ?? "join_room";
        const last = await this.jobs.latestCompletedForAccountRun(accountId, run.id);
        if (kind === "join_room") {
          if (last) {
            continue;
          }
        } else if (last?.completedAt && ts < last.completedAt + run.configuration.intervalMs) {
          continue;
        }
        await this.jobService.create({
          accountId,
          runId: run.id,
          configuration: {
            kind,
            roomId: run.configuration.roomId,
            supportTarget: run.configuration.supportTarget,
            durationMs: run.configuration.durationMs,
            intervalMs: run.configuration.intervalMs
          },
          scheduledAt: ts
        });
      }
    }
  }
}
