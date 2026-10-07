import { assertAccountTransition, assertJobTransition, createId, now, requiresHumanAction, shouldRetry } from "@weplay/shared";
import type { Account, ErrorCode, Job, JobConfiguration, Worker } from "@weplay/types";
import { HttpError } from "../http.js";
import type { DbClient } from "../db/types.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { AccountRepository } from "../repositories/AccountRepository.js";
import type { WorkerRepository } from "../repositories/WorkerRepository.js";
import type { LogService } from "./LogService.js";
import type { EventBus } from "../events/bus.js";
import type { SettingsService } from "./SettingsService.js";

function jobMatchesWorker(job: Job, account: Account, worker: Worker): boolean {
  if (account.workerId && account.workerId !== worker.id) {
    return false;
  }
  if (!account.workerId) {
    return (
      job.configuration.kind === "setup" ||
      job.configuration.kind === "reauth" ||
      job.configuration.kind === "join_room" ||
      job.configuration.kind === "create_account"
    );
  }
  return true;
}

export class JobService {
  constructor(
    private readonly db: DbClient,
    private readonly jobs: JobRepository,
    private readonly accounts: AccountRepository,
    private readonly workers: WorkerRepository,
    private readonly logs: LogService,
    private readonly bus: EventBus,
    private readonly settings: SettingsService
  ) {}

  list(filters: { status?: string; accountId?: string; runId?: string; kind?: string; limit?: number }) {
    return this.jobs.list(filters);
  }

  async get(id: string): Promise<Job> {
    const job = await this.jobs.getById(id);
    if (!job) {
      throw new HttpError(404, "Job not found");
    }
    return job;
  }

  async create(input: {
    accountId: string | null;
    runId: string | null;
    configuration: JobConfiguration;
    scheduledAt?: number;
    attemptCount?: number;
  }): Promise<Job> {
    const ts = now();
    const job: Job = {
      id: createId(),
      accountId: input.accountId,
      workerId: null,
      runId: input.runId,
      executionId: createId(),
      configuration: input.configuration,
      status: "QUEUED",
      attemptCount: input.attemptCount ?? 0,
      createdAt: ts,
      scheduledAt: input.scheduledAt ?? ts,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: ts
    };
    await this.jobs.insert(job);
    await this.logs.record({
      accountId: job.accountId,
      jobId: job.id,
      workerId: null,
      runId: job.runId,
      event: "JOB_CREATED",
      status: job.status,
      error: null,
      message: `Job ${job.configuration.kind} created`
    });
    this.bus.publish("changed", { source: "job" });
    return job;
  }

  async claim(worker: Worker): Promise<Job | null> {
    return this.db.transaction(async () => {
      const due = await this.jobs.listQueuedDueForWorker(now(), worker.id, 100);
      for (const job of due) {
        if (job.configuration.kind === "workspace_provision" || job.configuration.kind === "devicefarm_provision" || job.configuration.kind === "devicefarm_join" || !job.accountId) {
          continue;
        }
        const account = job.accountId ? await this.accounts.getById(job.accountId) : undefined;
        if (!account || !jobMatchesWorker(job, account, worker)) {
          continue;
        }
        if (
          (job.configuration.kind === "setup" || job.configuration.kind === "reauth") &&
          account.setupStatus === "COMPLETED"
        ) {
          job.status = "CANCELLED";
          job.completedAt = now();
          job.updatedAt = now();
          job.errorCode = "CANCELLED";
          job.errorMessage = "Setup already confirmed";
          await this.jobs.update(job);
          continue;
        }
        const claimed = await this.jobs.tryClaim(job.id, worker.id, now());
        if (!claimed) {
          continue;
        }
        const latest = await this.jobs.getById(job.id);
        if (!latest) {
          continue;
        }
        worker.status = "BUSY";
        worker.currentJobId = latest.id;
        worker.updatedAt = now();
        await this.workers.update(worker);

        if (latest.configuration.kind === "support" || latest.configuration.kind === "join_room") {
          account.status = "PROCESSING";
          account.updatedAt = now();
          await this.accounts.update(account);
        }
        if (latest.configuration.kind === "create_account") {
          account.metadata = { ...account.metadata, creationProgress: "Claimed by worker" };
          account.updatedAt = now();
          await this.accounts.update(account);
        }
        if (latest.configuration.kind === "setup" || latest.configuration.kind === "reauth") {
          if (!account.workerId) {
            account.workerId = worker.id;
          }
          account.metadata = { ...account.metadata, setupProgress: `Assigned to ${worker.name}` };
          account.updatedAt = now();
          await this.accounts.update(account);
        }

        await this.logs.record({
          accountId: latest.accountId,
          jobId: latest.id,
          workerId: worker.id,
          runId: latest.runId,
          event: "JOB_ASSIGNED",
          status: latest.status,
          error: null,
          message: "Job assigned"
        });
        this.bus.publish("changed", { source: "job" });
        return latest;
      }
      return null;
    });
  }

  async markRunning(jobId: string, worker: Worker, executionId: string): Promise<Job> {
    const job = await this.get(jobId);
    if (job.workerId !== worker.id) {
      throw new HttpError(409, "Job not assigned to this worker");
    }
    if (job.executionId !== executionId) {
      throw new HttpError(409, "Stale execution id");
    }
    assertJobTransition(job.status, "RUNNING");
    job.status = "RUNNING";
    job.startedAt = now();
    job.updatedAt = now();
    await this.jobs.update(job);
    await this.logs.record({
      accountId: job.accountId,
      jobId: job.id,
      workerId: worker.id,
      runId: job.runId,
      event: "JOB_STARTED",
      status: job.status,
      error: null,
      message: "Job started"
    });
    this.bus.publish("changed", { source: "job" });
    return job;
  }

  async progress(
    jobId: string,
    worker: Worker,
    executionId: string,
    event: string,
    message?: string
  ): Promise<void> {
    const job = await this.get(jobId);
    if (job.workerId !== worker.id || job.executionId !== executionId) {
      throw new HttpError(409, "Stale execution");
    }
    await this.logs.record({
      accountId: job.accountId,
      jobId: job.id,
      workerId: worker.id,
      runId: job.runId,
      event:
        job.configuration.kind === "create_account"
          ? "ACCOUNT_CREATION_PROGRESS"
          : job.configuration.kind === "setup" || job.configuration.kind === "reauth"
            ? "ACCOUNT_SETUP_PROGRESS"
            : event,
      status: job.status,
      error: null,
      message: message ?? event
    });
    if (job.configuration.kind === "create_account" && job.accountId) {
      const account = job.accountId ? await this.accounts.getById(job.accountId) : undefined;
      if (account) {
        account.metadata = { ...account.metadata, creationProgress: message ?? event };
        account.updatedAt = now();
        await this.accounts.update(account);
        this.bus.publish("changed", { source: "account" });
      }
    }
    if ((job.configuration.kind === "setup" || job.configuration.kind === "reauth") && job.accountId) {
      const account = job.accountId ? await this.accounts.getById(job.accountId) : undefined;
      if (account) {
        account.metadata = { ...account.metadata, setupProgress: message ?? event, setupScreen: message ?? event };
        account.updatedAt = now();
        await this.accounts.update(account);
        this.bus.publish("changed", { source: "account" });
      }
    }
  }

  async complete(
    jobId: string,
    worker: Worker,
    executionId: string,
    verified: boolean,
    result?: { displayName?: string; weplayUserId?: string }
  ): Promise<Job> {
    const job = await this.get(jobId);
    if (!verified) {
      const code = job.configuration.kind === "create_account" ? "SIGNUP_FAILED" : "SUPPORT_FAILED";
      return this.fail(jobId, worker, executionId, code, "Worker reported complete without verification");
    }
    if (job.workerId !== worker.id || job.executionId !== executionId) {
      throw new HttpError(409, "Stale execution");
    }
    assertJobTransition(job.status, "SUCCEEDED");
    const ts = now();
    job.status = "SUCCEEDED";
    job.completedAt = ts;
    job.updatedAt = ts;
    job.errorCode = null;
    job.errorMessage = null;
    await this.jobs.update(job);

    const account = job.accountId ? await this.accounts.getById(job.accountId) : undefined;
    if (account) {
      if (job.configuration.kind === "setup" || job.configuration.kind === "reauth") {
        account.status = "READY";
        account.setupStatus = "COMPLETED";
        if (!account.workerId) {
          account.workerId = worker.id;
        }
        account.metadata = {
          ...account.metadata,
          setupProgress: "Verified WePlay session on device",
          setupVerifiedBy: "worker",
          sessionVerified: true,
          sessionVerifiedAt: ts,
          sessionWorkerId: worker.id,
          weplayUserId: result?.weplayUserId ?? account.metadata.weplayUserId
        };
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "ACCOUNT_SETUP_COMPLETED",
          status: account.status,
          error: null,
          message: "Setup completed by worker after verified WePlay session"
        });
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "ACCOUNT_READY",
          status: account.status,
          error: null,
          message: "Account ready"
        });
      } else if (job.configuration.kind === "create_account") {
        assertAccountTransition(account.status, "SETUP_REQUIRED");
        account.status = "SETUP_REQUIRED";
        account.setupStatus = "REQUIRED";
        if (!account.workerId) {
          account.workerId = worker.id;
        }
        if (result?.displayName) {
          account.displayName = result.displayName;
        } else if (account.displayName === "Creating…") {
          account.displayName = `WePlay ${account.loginProvider}`;
        }
        account.metadata = {
          ...account.metadata,
          origin: "weplay_create",
          weplayCreated: true,
          weplayUserId: result?.weplayUserId ?? account.metadata.weplayUserId,
          creationProgress: "Verified on device"
        };
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "ACCOUNT_CREATION_SUCCEEDED",
          status: account.status,
          error: null,
          message: "WePlay account creation verified"
        });
      } else if (job.configuration.kind === "join_room") {
        account.status = "SUCCESS";
        account.lastSuccessAt = ts;
        if (!account.workerId) {
          account.workerId = worker.id;
        }
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "ROOM_OPENED",
          status: "SUCCEEDED",
          error: null,
          message: "Room join verified"
        });
      } else {
        account.status = "SUCCESS";
        account.lastSuccessAt = ts;
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "SUPPORT_SUCCEEDED",
          status: "SUCCEEDED",
          error: null,
          message: "Support verified"
        });
      }
      account.lastUsedAt = ts;
      account.lastErrorCode = null;
      account.lastErrorMessage = null;
      account.updatedAt = ts;
      await this.accounts.update(account);
    }

    worker.status = "IDLE";
    worker.currentJobId = null;
    worker.updatedAt = ts;
    await this.workers.update(worker);

    if (account && job.configuration.kind === "create_account") {
      assertAccountTransition(account.status, "SETUP_IN_PROGRESS");
      account.status = "SETUP_IN_PROGRESS";
      account.setupStatus = "IN_PROGRESS";
      account.updatedAt = now();
      await this.accounts.update(account);
      await this.logs.record({
        accountId: account.id,
        jobId: job.id,
        workerId: worker.id,
        runId: null,
        event: "ACCOUNT_SETUP_STARTED",
        status: account.status,
        error: null,
        message: "Initial setup started after verified WePlay creation"
      });
      await this.create({
        accountId: account.id,
        runId: null,
        configuration: { kind: "setup" }
      });
    }

    await this.logs.record({
      accountId: job.accountId,
      jobId: job.id,
      workerId: worker.id,
      runId: job.runId,
      event: "JOB_COMPLETED",
      status: job.status,
      error: null,
      message: "Job succeeded"
    });
    this.bus.publish("changed", { source: "job" });
    return job;
  }

  async fail(
    jobId: string,
    worker: Worker,
    executionId: string,
    errorCode: ErrorCode,
    errorMessage: string
  ): Promise<Job> {
    const job = await this.get(jobId);
    if (job.workerId !== worker.id || job.executionId !== executionId) {
      throw new HttpError(409, "Stale execution");
    }
    const settings = await this.settings.read();
    const ts = now();
    const nextAttempt = job.attemptCount + 1;
    const retry = shouldRetry(errorCode, nextAttempt, settings.maxJobRetries);

    if (retry) {
      assertJobTransition(job.status === "RUNNING" || job.status === "ASSIGNED" ? job.status : "RUNNING", "FAILED");
      job.status = "FAILED";
      job.attemptCount = nextAttempt;
      job.completedAt = ts;
      job.errorCode = errorCode;
      job.errorMessage = errorMessage;
      job.updatedAt = ts;
      await this.jobs.update(job);

      const retryJob: Job = {
        ...job,
        id: createId(),
        executionId: createId(),
        status: "QUEUED",
        workerId: job.workerId,
        startedAt: null,
        completedAt: null,
        scheduledAt: ts,
        createdAt: ts,
        updatedAt: ts,
        attemptCount: nextAttempt
      };
      retryJob.status = "RETRYING";
      await this.jobs.insert({ ...retryJob, status: "QUEUED" });
      await this.logs.record({
        accountId: job.accountId,
        jobId: retryJob.id,
        workerId: worker.id,
        runId: job.runId,
        event: "JOB_RETRYING",
        status: "QUEUED",
        error: errorCode,
        message: errorMessage
      });
    } else {
      if (job.status === "RUNNING" || job.status === "ASSIGNED") {
        assertJobTransition(job.status, "FAILED");
      }
      job.status = "FAILED";
      job.attemptCount = nextAttempt;
      job.completedAt = ts;
      job.errorCode = nextAttempt >= settings.maxJobRetries && shouldRetry(errorCode, 0, settings.maxJobRetries)
        ? "MAX_RETRIES_EXCEEDED"
        : errorCode;
      job.errorMessage = errorMessage;
      job.updatedAt = ts;
      await this.jobs.update(job);
      await this.logs.record({
        accountId: job.accountId,
        jobId: job.id,
        workerId: worker.id,
        runId: job.runId,
        event: "JOB_FAILED",
        status: job.status,
        error: job.errorCode,
        message: errorMessage
      });
    }

    const account = job.accountId ? await this.accounts.getById(job.accountId) : undefined;
    if (account) {
      account.lastFailureAt = ts;
      account.lastUsedAt = ts;
      account.lastErrorCode = errorCode;
      account.lastErrorMessage = errorMessage;
      if (job.configuration.kind === "create_account") {
        account.status = retry ? "CREATING" : "CREATION_FAILED";
        account.metadata = { ...account.metadata, creationProgress: errorMessage };
        if (!retry) {
          await this.logs.record({
            accountId: account.id,
            jobId: job.id,
            workerId: worker.id,
            runId: job.runId,
            event: "ACCOUNT_CREATION_FAILED",
            status: account.status,
            error: errorCode,
            message: errorMessage
          });
        }
      } else if (
        requiresHumanAction(errorCode) ||
        ((job.configuration.kind === "setup" || job.configuration.kind === "reauth") &&
          (errorCode === "AUTOMATION_NOT_INSPECTED" || errorCode === "UNEXPECTED_SCREEN"))
      ) {
        account.status = "ACTION_REQUIRED";
        account.setupStatus = "ACTION_REQUIRED";
        if (!account.workerId) {
          account.workerId = worker.id;
        }
        account.metadata = {
          ...account.metadata,
          setupProgress: errorMessage,
          setupScreen: errorMessage
        };
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "ACCOUNT_ACTION_REQUIRED",
          status: account.status,
          error: errorCode,
          message: errorMessage
        });
      } else if (errorCode === "AUTH_REQUIRED" || errorCode === "NEEDS_REAUTH") {
        account.status = "NEEDS_REAUTH";
        await this.logs.record({
          accountId: account.id,
          jobId: job.id,
          workerId: worker.id,
          runId: job.runId,
          event: "ACCOUNT_NEEDS_REAUTH",
          status: account.status,
          error: errorCode,
          message: errorMessage
        });
      } else if (errorCode === "SETUP_REQUIRED") {
        account.status = "SETUP_REQUIRED";
        account.setupStatus = "REQUIRED";
      } else if (job.configuration.kind === "setup" || job.configuration.kind === "reauth") {
        account.status = "SETUP_REQUIRED";
        account.setupStatus = "REQUIRED";
      } else {
        account.status = "FAILED";
      }
      account.updatedAt = ts;
      await this.accounts.update(account);
    }

    if (errorCode === "SUPPORT_FAILED") {
      await this.logs.record({
        accountId: job.accountId,
        jobId: job.id,
        workerId: worker.id,
        runId: job.runId,
        event: "SUPPORT_FAILED",
        status: "FAILED",
        error: errorCode,
        message: errorMessage
      });
    }

    worker.status = "IDLE";
    worker.currentJobId = null;
    worker.updatedAt = ts;
    await this.workers.update(worker);
    this.bus.publish("changed", { source: "job" });
    return job;
  }
}
