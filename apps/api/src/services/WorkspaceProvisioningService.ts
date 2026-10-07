import type { AppEnv } from "@weplay/config";
import {
  WORKSPACE_DIRECTORY_SCOPE,
  WORKSPACE_LICENSE_WARNING,
  buildWorkspaceEmail,
  createId,
  exponentialBackoffMs,
  isWorkspaceUserTerminal,
  now,
  parseWorkspaceCsv,
  validateWorkspaceDomain,
  validateWorkspaceUsername
} from "@weplay/shared";
import type {
  ErrorCode,
  Job,
  WorkspaceConnectionStatus,
  WorkspaceProvisioningBatch,
  WorkspaceProvisioningStats,
  WorkspaceUsage,
  WorkspaceUserProvisioning
} from "@weplay/types";
import { HttpError } from "../http.js";
import type { EventBus } from "../events/bus.js";
import {
  generateWorkspacePassword,
  isDirectoryError,
  mapGoogleDirectoryError,
  type GoogleDirectoryClient
} from "../google/directory.js";
import { workspaceCredentialsConfigured } from "../google/googleDirectoryClient.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { WorkspaceProvisioningRepository } from "../repositories/WorkspaceProvisioningRepository.js";
import type { JobService } from "./JobService.js";
import type { LogService } from "./LogService.js";

function statsFromCounts(requested: number, counts: Record<string, number>): WorkspaceProvisioningStats {
  const created = counts.CREATED ?? 0;
  const alreadyExists = counts.ALREADY_EXISTS ?? 0;
  const failed = counts.FAILED ?? 0;
  const creating = counts.CREATING ?? 0;
  const retrying = counts.RETRYING ?? 0;
  const pending = counts.PENDING ?? 0;
  const validating = counts.VALIDATING ?? 0;
  const remaining = pending + validating + retrying + creating;
  return {
    requested,
    valid: requested - failed,
    creating,
    created,
    alreadyExists,
    failed,
    remaining,
    retrying
  };
}

function batchComplete(stats: WorkspaceProvisioningStats): boolean {
  return stats.remaining === 0;
}

export class WorkspaceProvisioningService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly env: AppEnv,
    private readonly repo: WorkspaceProvisioningRepository,
    private readonly jobs: JobRepository,
    private readonly jobService: JobService,
    private readonly logs: LogService,
    private readonly bus: EventBus,
    private readonly directory: GoogleDirectoryClient
  ) {}

  async getUsage(): Promise<WorkspaceUsage> {
    return this.directory.getUsage();
  }

  connectionStatus(): WorkspaceConnectionStatus {
    const domain = this.env.GOOGLE_WORKSPACE_DOMAIN.trim() || null;
    return {
      configured: workspaceCredentialsConfigured(this.env) && this.directory.configured,
      domain,
      adminEmailConfigured: Boolean(this.env.GOOGLE_WORKSPACE_ADMIN_EMAIL.trim()),
      credentialsConfigured: Boolean(
        this.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE.trim() || this.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON.trim()
      ),
      scope: WORKSPACE_DIRECTORY_SCOPE,
      concurrency: this.env.GOOGLE_WORKSPACE_PROVISION_CONCURRENCY,
      maxRetries: this.env.GOOGLE_WORKSPACE_PROVISION_MAX_RETRIES,
      warning: WORKSPACE_LICENSE_WARNING
    };
  }

  requireConfiguredDomain(): string {
    const domain = this.env.GOOGLE_WORKSPACE_DOMAIN.trim().toLowerCase();
    const domainError = validateWorkspaceDomain(domain);
    if (domainError) {
      throw new HttpError(400, domainError, "WORKSPACE_NOT_CONFIGURED");
    }
    return domain;
  }

  async importCsv(csv: string, name?: string): Promise<{
    batch: WorkspaceProvisioningBatch;
    users: WorkspaceUserProvisioning[];
    stats: WorkspaceProvisioningStats;
    parseIssues: ReturnType<typeof parseWorkspaceCsv>["issues"];
  }> {
    const domain = this.requireConfiguredDomain();
    const parsed = parseWorkspaceCsv(csv);
    const ts = now();
    const batch: WorkspaceProvisioningBatch = {
      id: createId(),
      name: name?.trim() || `Workspace import ${new Date(ts).toISOString()}`,
      domain,
      status: "DRAFT",
      requestedCount: 0,
      createdAt: ts,
      updatedAt: ts,
      startedAt: null,
      completedAt: null
    };
    await this.repo.insertBatch(batch);

    const users: WorkspaceUserProvisioning[] = [];
    for (const row of parsed.rows) {
      const usernameError = validateWorkspaceUsername(row.username);
      const status = usernameError ? "FAILED" : "PENDING";
      users.push({
        id: createId(),
        batchId: batch.id,
        firstName: row.firstName,
        lastName: row.lastName,
        displayName: row.displayName,
        requestedUsername: row.username.trim().toLowerCase(),
        fullEmail: buildWorkspaceEmail(row.username, domain),
        status,
        googleUserId: null,
        errorCode: usernameError ? "WORKSPACE_USER_INVALID" : null,
        errorMessage: usernameError,
        attemptCount: 0,
        createdAt: ts,
        updatedAt: ts,
        completedAt: usernameError ? ts : null
      });
    }
    for (const issue of parsed.issues) {
      if (issue.code === "WORKSPACE_DUPLICATE_USERNAME" && issue.username) {
        continue;
      }
    }
    await this.repo.insertUsers(users);
    batch.requestedCount = users.length;
    batch.status = users.some((user) => user.status === "PENDING") ? "DRAFT" : "COMPLETED";
    batch.updatedAt = now();
    if (batch.status === "COMPLETED") {
      batch.completedAt = batch.updatedAt;
    }
    await this.repo.updateBatch(batch);

    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: null,
      event: "PROVISIONING_IMPORT_STARTED",
      status: batch.status,
      error: null,
      message: `Imported ${users.length} Workspace users for ${domain}`,
      metadata: { batchId: batch.id, requested: users.length, parseIssueCount: parsed.issues.length }
    });
    this.bus.publish("changed", { source: "workspace" });
    const counts = await this.repo.countsByStatus(batch.id);
    return { batch, users, stats: statsFromCounts(batch.requestedCount, counts), parseIssues: parsed.issues };
  }

  async getBatch(id: string): Promise<{
    batch: WorkspaceProvisioningBatch;
    users: WorkspaceUserProvisioning[];
    stats: WorkspaceProvisioningStats;
    connection: WorkspaceConnectionStatus;
  }> {
    const batch = await this.requireBatch(id);
    const users = await this.repo.listUsers(id);
    const counts = await this.repo.countsByStatus(id);
    return {
      batch,
      users,
      stats: statsFromCounts(batch.requestedCount, counts),
      connection: this.connectionStatus()
    };
  }

  async listBatches(): Promise<Array<WorkspaceProvisioningBatch & { stats: WorkspaceProvisioningStats }>> {
    const batches = await this.repo.listBatches();
    const result: Array<WorkspaceProvisioningBatch & { stats: WorkspaceProvisioningStats }> = [];
    for (const batch of batches) {
      const counts = await this.repo.countsByStatus(batch.id);
      result.push({ ...batch, stats: statsFromCounts(batch.requestedCount, counts) });
    }
    return result;
  }

  async validate(batchId: string, checkExisting = true): Promise<{
    batch: WorkspaceProvisioningBatch;
    users: WorkspaceUserProvisioning[];
    stats: WorkspaceProvisioningStats;
  }> {
    const batch = await this.requireBatch(batchId);
    if (batch.status === "RUNNING") {
      throw new HttpError(409, "Cannot validate while provisioning is running", "INVALID_CONFIGURATION");
    }
    if (batch.status === "CANCELLED") {
      throw new HttpError(409, "Cancelled batch cannot be validated", "CANCELLED");
    }
    const ts = now();
    batch.status = "VALIDATING";
    batch.updatedAt = ts;
    await this.repo.updateBatch(batch);

    const users = await this.repo.listUsers(batchId);
    const seen = new Map<string, string>();
    for (const user of users) {
      if (user.status === "CREATED" || user.status === "ALREADY_EXISTS") {
        continue;
      }
      user.status = "VALIDATING";
      user.updatedAt = ts;
      const usernameError = validateWorkspaceUsername(user.requestedUsername);
      if (usernameError) {
        this.failUser(user, "WORKSPACE_USER_INVALID", usernameError, ts);
        await this.repo.updateUser(user);
        continue;
      }
      const previous = seen.get(user.requestedUsername);
      if (previous) {
        this.failUser(user, "WORKSPACE_DUPLICATE_USERNAME", `Duplicate username ${user.requestedUsername}`, ts);
        await this.repo.updateUser(user);
        continue;
      }
      seen.set(user.requestedUsername, user.id);
      user.errorCode = null;
      user.errorMessage = null;
      user.completedAt = null;
      await this.repo.updateUser(user);
    }

    if (checkExisting && this.directory.configured) {
      const pending = (await this.repo.listUsers(batchId)).filter((user) => user.status === "VALIDATING");
      await this.mapPool(pending, this.env.GOOGLE_WORKSPACE_PROVISION_CONCURRENCY, async (user) => {
        try {
          const existing = await this.directory.getUser(user.fullEmail);
          if (existing) {
            user.status = "ALREADY_EXISTS";
            user.googleUserId = existing.id;
            user.errorCode = "ACCOUNT_ALREADY_EXISTS";
            user.errorMessage = `User already exists in Workspace as ${existing.primaryEmail}`;
            user.completedAt = now();
            user.updatedAt = now();
            await this.repo.updateUser(user);
            await this.logs.record({
              accountId: null,
              jobId: null,
              workerId: null,
              runId: null,
              event: "USER_ALREADY_EXISTS",
              status: "ALREADY_EXISTS",
              error: null,
              message: user.fullEmail,
              metadata: { batchId, workspaceUserId: user.id, googleUserId: existing.id }
            });
            return;
          }
          user.status = "PENDING";
          user.updatedAt = now();
          await this.repo.updateUser(user);
        } catch (error) {
          const mapped = isDirectoryError(error) ? error : mapGoogleDirectoryError(error);
          if (mapped.retryable) {
            user.status = "PENDING";
            user.errorCode = mapped.errorCode;
            user.errorMessage = mapped.message;
            user.updatedAt = now();
            await this.repo.updateUser(user);
            return;
          }
          this.failUser(user, mapped.errorCode, mapped.message, now());
          await this.repo.updateUser(user);
        }
      });
    } else {
      const validating = (await this.repo.listUsers(batchId)).filter((user) => user.status === "VALIDATING");
      for (const user of validating) {
        user.status = "PENDING";
        user.updatedAt = now();
        await this.repo.updateUser(user);
      }
    }

    const latest = await this.requireBatch(batchId);
    const counts = await this.repo.countsByStatus(batchId);
    const stats = statsFromCounts(latest.requestedCount, counts);
    latest.status = stats.remaining > 0 ? "READY" : "COMPLETED";
    latest.updatedAt = now();
    if (latest.status === "COMPLETED") {
      latest.completedAt = latest.updatedAt;
    }
    await this.repo.updateBatch(latest);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: null,
      event: "PROVISIONING_VALIDATION_COMPLETED",
      status: latest.status,
      error: null,
      message: `Validated ${latest.requestedCount} users`,
      metadata: { batchId, stats }
    });
    this.bus.publish("changed", { source: "workspace" });
    return { batch: latest, users: await this.repo.listUsers(batchId), stats };
  }

  async start(batchId: string): Promise<{ batch: WorkspaceProvisioningBatch; stats: WorkspaceProvisioningStats }> {
    let batch = await this.requireBatch(batchId);
    if (batch.status === "CANCELLED" || batch.status === "COMPLETED") {
      throw new HttpError(409, `Cannot start a ${batch.status.toLowerCase()} batch`, "INVALID_CONFIGURATION");
    }
    if (batch.status === "RUNNING") {
      const counts = await this.repo.countsByStatus(batchId);
      return { batch, stats: statsFromCounts(batch.requestedCount, counts) };
    }
    if (!this.directory.configured) {
      throw new HttpError(400, "Google Workspace Admin SDK credentials are not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    if (batch.status === "DRAFT" || batch.status === "VALIDATING") {
      await this.validate(batchId, true);
      batch = await this.requireBatch(batchId);
    }
    const ts = now();
    const pending = await this.repo.listUsersByStatuses(batchId, ["PENDING", "RETRYING"], 10_000);
    for (const user of pending) {
      await this.jobService.create({
        accountId: null,
        runId: null,
        configuration: {
          kind: "workspace_provision",
          workspaceUserId: user.id,
          workspaceBatchId: batch.id
        },
        attemptCount: user.attemptCount
      });
    }
    batch.status = "RUNNING";
    batch.startedAt = batch.startedAt ?? ts;
    batch.updatedAt = ts;
    await this.repo.updateBatch(batch);
    this.bus.publish("changed", { source: "workspace" });
    const counts = await this.repo.countsByStatus(batchId);
    return { batch, stats: statsFromCounts(batch.requestedCount, counts) };
  }

  async pause(batchId: string): Promise<WorkspaceProvisioningBatch> {
    const batch = await this.requireBatch(batchId);
    if (batch.status !== "RUNNING") {
      throw new HttpError(409, "Only a running batch can be paused", "INVALID_CONFIGURATION");
    }
    batch.status = "PAUSED";
    batch.updatedAt = now();
    await this.repo.updateBatch(batch);
    this.bus.publish("changed", { source: "workspace" });
    return batch;
  }

  async resume(batchId: string): Promise<WorkspaceProvisioningBatch> {
    const batch = await this.requireBatch(batchId);
    if (batch.status !== "PAUSED") {
      throw new HttpError(409, "Only a paused batch can be resumed", "INVALID_CONFIGURATION");
    }
    if (!this.directory.configured) {
      throw new HttpError(400, "Google Workspace Admin SDK credentials are not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    batch.status = "RUNNING";
    batch.updatedAt = now();
    await this.repo.updateBatch(batch);
    this.bus.publish("changed", { source: "workspace" });
    return batch;
  }

  async cancel(batchId: string): Promise<WorkspaceProvisioningBatch> {
    const batch = await this.requireBatch(batchId);
    if (batch.status === "COMPLETED") {
      return batch;
    }
    const ts = now();
    await this.cancelOpenJobs(batchId, ts);
    await this.repo.cancelOpenUsers(batchId, ts);
    batch.status = "CANCELLED";
    batch.updatedAt = ts;
    batch.completedAt = ts;
    await this.repo.updateBatch(batch);
    this.bus.publish("changed", { source: "workspace" });
    return batch;
  }

  async deleteBatch(batchId: string): Promise<{ deleted: true }> {
    const batch = await this.requireBatch(batchId);
    if (batch.status === "RUNNING") {
      throw new HttpError(409, "Cannot delete a running batch. Pause or cancel it first.", "INVALID_CONFIGURATION");
    }
    const ts = now();
    await this.cancelOpenJobs(batchId, ts);
    await this.repo.deleteBatch(batchId);
    this.bus.publish("changed", { source: "workspace" });
    return { deleted: true };
  }

  async deleteFailedUser(batchId: string, userId: string): Promise<{
    batch: WorkspaceProvisioningBatch;
    users: WorkspaceUserProvisioning[];
    stats: WorkspaceProvisioningStats;
    connection: WorkspaceConnectionStatus;
  }> {
    const user = await this.repo.getUser(userId);
    if (!user || user.batchId !== batchId) {
      throw new HttpError(404, "Provisioning user not found");
    }
    if (user.status !== "FAILED") {
      throw new HttpError(409, "Only failed users can be deleted from a batch", "INVALID_CONFIGURATION");
    }
    await this.repo.deleteUser(userId);
    const batch = await this.requireBatch(batchId);
    batch.requestedCount = Math.max(0, batch.requestedCount - 1);
    batch.updatedAt = now();
    await this.repo.updateBatch(batch);
    this.bus.publish("changed", { source: "workspace" });
    return this.getBatch(batchId);
  }

  exportCsv(users: WorkspaceUserProvisioning[]): string {
    const header = "firstName,lastName,username,fullEmail,status,googleUserId,errorCode,errorMessage";
    const lines = users.map((user) =>
      [
        user.firstName,
        user.lastName,
        user.requestedUsername,
        user.fullEmail,
        user.status,
        user.googleUserId ?? "",
        user.errorCode ?? "",
        user.errorMessage ?? ""
      ]
        .map((value) => this.csvCell(value))
        .join(",")
    );
    return [header, ...lines].join("\n");
  }

  async recover(): Promise<void> {
    const creating = await this.repo.listUsersByStatus("CREATING");
    for (const user of creating) {
      if (this.inFlight.has(user.id)) {
        continue;
      }
      await this.reconcileInterrupted(user);
    }
  }

  async processDue(): Promise<void> {
    const batches = await this.repo.listBatchesByStatus("RUNNING");
    if (batches.length === 0) {
      return;
    }
    const concurrency = this.env.GOOGLE_WORKSPACE_PROVISION_CONCURRENCY;
    const dueJobs = await this.jobs.listQueuedWorkspaceDue(now(), concurrency * 4);
    const started: Promise<void>[] = [];
    for (const job of dueJobs) {
      if (this.inFlight.size >= concurrency) {
        break;
      }
      const batchId = job.configuration.workspaceBatchId;
      const userId = job.configuration.workspaceUserId;
      if (!batchId || !userId) {
        continue;
      }
      const batch = await this.repo.getBatch(batchId);
      if (!batch || batch.status !== "RUNNING") {
        continue;
      }
      if (this.inFlight.has(userId)) {
        continue;
      }
      const claimed = await this.jobs.tryStartInternal(job.id, now());
      if (!claimed) {
        continue;
      }
      this.inFlight.add(userId);
      started.push(
        this.executeJob(job.id).finally(() => {
          this.inFlight.delete(userId);
        })
      );
    }
    if (started.length > 0) {
      await Promise.allSettled(started);
    }
    for (const batch of batches) {
      await this.completeBatchIfDone(batch.id);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = await this.jobs.getById(jobId);
    if (!job || !job.configuration.workspaceUserId) {
      return;
    }
    const user = await this.repo.getUser(job.configuration.workspaceUserId);
    if (!user) {
      return;
    }
    const latestBatch = await this.repo.getBatch(user.batchId);
    if (!latestBatch || latestBatch.status !== "RUNNING") {
      return;
    }
    if (isWorkspaceUserTerminal(user.status) && user.status !== "FAILED") {
      await this.finishJob(job, "SUCCEEDED", null, null);
      return;
    }
    const marked = await this.repo.tryMarkCreating(user.id, now());
    if (!marked) {
      const current = await this.repo.getUser(user.id);
      if (current && isWorkspaceUserTerminal(current.status)) {
        await this.finishJob(job, "SUCCEEDED", null, null);
      }
      return;
    }
    const current = await this.repo.getUser(user.id);
    if (!current) {
      return;
    }
    await this.provisionUser(current, job);
  }

  private async provisionUser(user: WorkspaceUserProvisioning, job: Job): Promise<void> {
    const ts = now();
    user.attemptCount += 1;
    user.updatedAt = ts;
    await this.repo.updateUser(user);
    await this.logs.record({
      accountId: null,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: "USER_CREATE_STARTED",
      status: "CREATING",
      error: null,
      message: user.fullEmail,
      metadata: { batchId: user.batchId, workspaceUserId: user.id, attemptCount: user.attemptCount }
    });
    this.bus.publish("changed", { source: "workspace" });

    try {
      const existing = await this.directory.getUser(user.fullEmail);
      if (existing) {
        user.status = "ALREADY_EXISTS";
        user.googleUserId = existing.id;
        user.errorCode = null;
        user.errorMessage = null;
        user.completedAt = now();
        user.updatedAt = now();
        await this.repo.updateUser(user);
        await this.finishJob(job, "SUCCEEDED", null, null);
        await this.logs.record({
          accountId: null,
          jobId: job.id,
          workerId: null,
          runId: null,
          event: "USER_ALREADY_EXISTS",
          status: "ALREADY_EXISTS",
          error: null,
          message: user.fullEmail,
          metadata: { batchId: user.batchId, workspaceUserId: user.id, googleUserId: existing.id }
        });
        this.bus.publish("changed", { source: "workspace" });
        return;
      }

      const batchNow = await this.repo.getBatch(user.batchId);
      if (!batchNow || batchNow.status !== "RUNNING") {
        if (batchNow?.status === "CANCELLED") {
          this.failUser(user, "CANCELLED", "Provisioning cancelled before completion", now());
          await this.repo.updateUser(user);
          await this.finishJob(job, "FAILED", "CANCELLED", "Provisioning cancelled");
          return;
        }
        user.status = "PENDING";
        user.updatedAt = now();
        await this.repo.updateUser(user);
        return;
      }

      const sharedPassword = this.env.WEPLAY_WORKSPACE_PASSWORD.trim();
      const created = await this.directory.insertUser({
        primaryEmail: user.fullEmail,
        givenName: user.firstName,
        familyName: user.lastName,
        password: sharedPassword || generateWorkspacePassword(),
        changePasswordAtNextLogin: !sharedPassword
      });
      if (!created.id) {
        throw mapGoogleDirectoryError(new Error("Google user insert returned no user id"));
      }
      user.status = "CREATED";
      user.googleUserId = created.id;
      user.errorCode = null;
      user.errorMessage = null;
      user.completedAt = now();
      user.updatedAt = now();
      await this.repo.updateUser(user);
      await this.finishJob(job, "SUCCEEDED", null, null);
      await this.logs.record({
        accountId: null,
        jobId: job.id,
        workerId: null,
        runId: null,
        event: "USER_CREATED",
        status: "CREATED",
        error: null,
        message: user.fullEmail,
        metadata: { batchId: user.batchId, workspaceUserId: user.id, googleUserId: created.id }
      });
      this.bus.publish("changed", { source: "workspace" });
    } catch (error) {
      const mapped = isDirectoryError(error) ? error : mapGoogleDirectoryError(error);
      if (mapped.errorCode === "ACCOUNT_ALREADY_EXISTS") {
        const existing = await this.directory.getUser(user.fullEmail).catch(() => null);
        user.status = "ALREADY_EXISTS";
        user.googleUserId = existing?.id ?? user.googleUserId;
        user.errorCode = null;
        user.errorMessage = null;
        user.completedAt = now();
        user.updatedAt = now();
        await this.repo.updateUser(user);
        await this.finishJob(job, "SUCCEEDED", null, null);
        await this.logs.record({
          accountId: null,
          jobId: job.id,
          workerId: null,
          runId: null,
          event: "USER_ALREADY_EXISTS",
          status: "ALREADY_EXISTS",
          error: null,
          message: user.fullEmail,
          metadata: { batchId: user.batchId, workspaceUserId: user.id, googleUserId: user.googleUserId }
        });
        this.bus.publish("changed", { source: "workspace" });
        return;
      }

      const maxRetries = this.env.GOOGLE_WORKSPACE_PROVISION_MAX_RETRIES;
      const retry = mapped.retryable && user.attemptCount < maxRetries;
      if (retry) {
        user.status = "RETRYING";
        user.errorCode = mapped.errorCode;
        user.errorMessage = mapped.message;
        user.updatedAt = now();
        user.completedAt = null;
        await this.repo.updateUser(user);
        job.status = "RETRYING";
        job.attemptCount = user.attemptCount;
        job.errorCode = mapped.errorCode;
        job.errorMessage = mapped.message;
        job.updatedAt = now();
        await this.jobs.update(job);
        const delay = exponentialBackoffMs(user.attemptCount - 1, this.env.GOOGLE_WORKSPACE_PROVISION_INITIAL_BACKOFF_MS);
        await this.jobService.create({
          accountId: null,
          runId: null,
          configuration: job.configuration,
          scheduledAt: now() + delay,
          attemptCount: user.attemptCount
        });
        await this.logs.record({
          accountId: null,
          jobId: job.id,
          workerId: null,
          runId: null,
          event: "USER_CREATE_FAILED",
          status: "RETRYING",
          error: mapped.errorCode,
          message: mapped.message,
          metadata: { batchId: user.batchId, workspaceUserId: user.id, attemptCount: user.attemptCount }
        });
      } else {
        this.failUser(user, mapped.errorCode, mapped.message, now());
        await this.repo.updateUser(user);
        await this.finishJob(job, "FAILED", mapped.errorCode, mapped.message);
        await this.logs.record({
          accountId: null,
          jobId: job.id,
          workerId: null,
          runId: null,
          event: "USER_CREATE_FAILED",
          status: "FAILED",
          error: mapped.errorCode,
          message: mapped.message,
          metadata: { batchId: user.batchId, workspaceUserId: user.id, attemptCount: user.attemptCount }
        });
      }
      this.bus.publish("changed", { source: "workspace" });
    }
  }

  private async reconcileInterrupted(user: WorkspaceUserProvisioning): Promise<void> {
    try {
      if (this.directory.configured) {
        const existing = await this.directory.getUser(user.fullEmail);
        if (existing) {
          user.status = "CREATED";
          user.googleUserId = existing.id;
          user.errorCode = null;
          user.errorMessage = null;
          user.completedAt = now();
          user.updatedAt = now();
          await this.repo.updateUser(user);
          this.bus.publish("changed", { source: "workspace" });
          return;
        }
      }
    } catch {
      // Fall through to retry from persisted PENDING/RETRYING state.
    }
    user.status = user.attemptCount > 0 ? "RETRYING" : "PENDING";
    user.updatedAt = now();
    await this.repo.updateUser(user);
    const jobs = (await this.jobs.list({ kind: "workspace_provision", limit: 2000 })).filter(
      (job) => job.configuration.workspaceUserId === user.id && (job.status === "RUNNING" || job.status === "QUEUED")
    );
    if (jobs.length === 0) {
      await this.jobService.create({
        accountId: null,
        runId: null,
        configuration: {
          kind: "workspace_provision",
          workspaceUserId: user.id,
          workspaceBatchId: user.batchId
        },
        attemptCount: user.attemptCount
      });
      return;
    }
    for (const job of jobs) {
      if (job.status === "RUNNING") {
        job.status = "QUEUED";
        job.startedAt = null;
        job.updatedAt = now();
        job.scheduledAt = now();
        await this.jobs.update(job);
      }
    }
  }

  private async completeBatchIfDone(batchId: string): Promise<void> {
    const batch = await this.repo.getBatch(batchId);
    if (!batch || batch.status !== "RUNNING") {
      return;
    }
    const counts = await this.repo.countsByStatus(batchId);
    const stats = statsFromCounts(batch.requestedCount, counts);
    if (!batchComplete(stats)) {
      return;
    }
    batch.status = "COMPLETED";
    batch.updatedAt = now();
    batch.completedAt = batch.updatedAt;
    await this.repo.updateBatch(batch);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: null,
      event: "PROVISIONING_COMPLETED",
      status: "COMPLETED",
      error: null,
      message: `Provisioning completed for ${batch.requestedCount} users`,
      metadata: { batchId, stats }
    });
    this.bus.publish("changed", { source: "workspace" });
  }

  private async finishJob(job: Job, status: "SUCCEEDED" | "FAILED", errorCode: ErrorCode | null, errorMessage: string | null): Promise<void> {
    const ts = now();
    job.status = status;
    job.completedAt = ts;
    job.updatedAt = ts;
    job.errorCode = errorCode;
    job.errorMessage = errorMessage;
    await this.jobs.update(job);
  }

  private failUser(user: WorkspaceUserProvisioning, errorCode: ErrorCode, message: string, ts: number): void {
    user.status = "FAILED";
    user.errorCode = errorCode;
    user.errorMessage = message;
    user.updatedAt = ts;
    user.completedAt = ts;
  }

  private async cancelOpenJobs(batchId: string, ts: number): Promise<void> {
    const jobs = await this.jobs.list({ kind: "workspace_provision", limit: 5000 });
    for (const job of jobs) {
      if (job.configuration.workspaceBatchId !== batchId) {
        continue;
      }
      if (job.status === "QUEUED" || job.status === "RETRYING" || job.status === "ASSIGNED") {
        job.status = "CANCELLED";
        job.completedAt = ts;
        job.updatedAt = ts;
        job.errorCode = "CANCELLED";
        job.errorMessage = "Provisioning cancelled";
        await this.jobs.update(job);
      }
    }
  }

  private async requireBatch(id: string): Promise<WorkspaceProvisioningBatch> {
    const batch = await this.repo.getBatch(id);
    if (!batch) {
      throw new HttpError(404, "Provisioning batch not found");
    }
    return batch;
  }

  private csvCell(value: string): string {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private async mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        if (current) {
          await fn(current);
        }
      }
    });
    await Promise.all(workers);
  }
}
