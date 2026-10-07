import type { AppEnv } from "@weplay/config";
import { createId, now } from "@weplay/shared";
import type {
  Account,
  DeviceFarmConnectionStatus,
  DeviceFarmProvisioning,
  ErrorCode,
  Job
} from "@weplay/types";
import type { GoogleDirectoryClient } from "../google/directory.js";
import { HttpError } from "../http.js";
import type { DeviceFarmRunProgress, DeviceFarmWorkerClient, DeviceFarmWorkerResult } from "../devicefarm/client.js";
import { DeviceFarmNotConfiguredError } from "../devicefarm/client.js";
import { resolvePlayStoreEmail, sanitizeGameCode } from "../devicefarm/spec.js";
import { deviceFarmConfigured } from "../devicefarm/paths.js";
import { describeAwsCredentials } from "../devicefarm/credentials.js";
import { isTransientAwsNetworkError } from "../devicefarm/networkError.js";
import type { EventBus } from "../events/bus.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { DeviceFarmProvisioningRepository } from "../repositories/DeviceFarmProvisioningRepository.js";
import type { AccountRepository } from "../repositories/AccountRepository.js";
import type { AccountService } from "./AccountService.js";
import type { JobService } from "./JobService.js";
import type { LogService } from "./LogService.js";

const VERIFIED_SCREENS = new Set(["weplay_main", "weplay_room"]);

function uniqueLowerEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of values) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function deviceFarmJobTimeoutMinutes(baseMinutes: number, accountCount: number): number {
  return Math.min(150, Math.max(baseMinutes, 20 + accountCount * 8));
}

export class DeviceFarmProvisioningService {
  private readonly inFlight = new Set<string>();
  private readonly lastProgressKey = new Map<string, string>();

  constructor(
    private readonly env: AppEnv,
    private readonly repo: DeviceFarmProvisioningRepository,
    private readonly accounts: AccountService,
    private readonly accountRepo: AccountRepository,
    private readonly jobs: JobRepository,
    private readonly jobService: JobService,
    private readonly logs: LogService,
    private readonly bus: EventBus,
    private readonly directory: GoogleDirectoryClient,
    private readonly deviceFarm: DeviceFarmWorkerClient
  ) {}

  connectionStatus(): DeviceFarmConnectionStatus {
    const credentials = describeAwsCredentials(this.env);
    const arnsConfigured = deviceFarmConfigured(this.env) && this.deviceFarm.configured;
    const configured = arnsConfigured && credentials.credentialsAvailable;
    return {
      configured,
      region: credentials.region,
      projectConfigured: Boolean(this.env.DEVICEFARM_PROJECT_ARN.trim()),
      devicePoolConfigured: Boolean(this.env.DEVICEFARM_DEVICE_POOL_ARN.trim()),
      appConfigured: Boolean(this.env.DEVICEFARM_APP_ARN.trim() || this.env.DEVICEFARM_APP_PATH.trim()),
      credentialsAvailable: credentials.credentialsAvailable,
      credentialsSource: credentials.credentialsSource,
      envAccessKeyIdSet: credentials.envAccessKeyIdSet,
      envStaticKeyPairSet: credentials.envStaticKeyPairSet,
      envProfileSet: credentials.envProfileSet,
      sharedCredentialsFilePresent: credentials.sharedCredentialsFilePresent,
      singleWorkerOnly: true,
      inFlight: 0,
      availability: configured ? "Active" : "Inactive",
      warning: credentials.credentialsAvailable
        ? "Locked Pixel flow: one Device Farm run. Play identity and Play Store WePlay install once, then each selected Workspace account is added and signed into WePlay on that Pixel. READY after a WePlay user id is stored. Join a room later from Jobs."
        : "AWS credentials are not available. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the API .env (or configure ~/.aws/credentials), then restart the API. Device Farm ARNs alone are not enough."
    };
  }

  async status(): Promise<DeviceFarmConnectionStatus> {
    const base = this.connectionStatus();
    const inFlight = await this.repo.countInFlight();
    return {
      ...base,
      inFlight,
      availability: !base.configured ? "Inactive" : inFlight > 0 ? "Running" : "Active"
    };
  }

  async getForAccount(accountId: string): Promise<DeviceFarmProvisioning | null> {
    return (await this.repo.latestByAccount(accountId)) ?? null;
  }

  async start(emailOrEmails: string | string[]): Promise<{
    account: Account;
    accounts: Account[];
    provisioning: DeviceFarmProvisioning;
    job: Job;
    skipped: Array<{ email: string; reason: string }>;
  }> {
    const emails = uniqueLowerEmails(Array.isArray(emailOrEmails) ? emailOrEmails : [emailOrEmails]);
    if (emails.length === 0) {
      throw new HttpError(400, "Select at least one Workspace email", "INVALID_CONFIGURATION");
    }
    if (emails.length > 20) {
      throw new HttpError(400, "At most 20 Workspace accounts can share one Pixel run", "INVALID_CONFIGURATION");
    }
    const status = this.connectionStatus();
    if (!status.configured) {
      throw new HttpError(
        400,
        "AWS Device Farm is not configured. Set DEVICEFARM_PROJECT_ARN, DEVICEFARM_DEVICE_POOL_ARN, DEVICEFARM_APP_ARN, and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or ~/.aws/credentials).",
        "DEVICEFARM_NOT_CONFIGURED"
      );
    }
    if (!this.directory.configured) {
      throw new HttpError(400, "Google Workspace Admin SDK credentials are not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    const workspacePassword = this.requireSharedWorkspacePassword();
    const applied = await this.applySharedPasswordToDirectoryUsers(workspacePassword);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: null,
      runId: null,
      event: "DEVICEFARM_PROVISION_PROGRESS",
      status: "PENDING",
      error: null,
      message: `Applied the shared Workspace password to ${applied} Directory user${applied === 1 ? "" : "s"}`
    });
    if ((await this.repo.countInFlight()) > 0) {
      throw new HttpError(
        409,
        "A Device Farm worker is already running. One Pixel at a time; wait for this run to finish, then start the next selection.",
        "DEVICEFARM_IN_PROGRESS"
      );
    }

    for (const email of emails) {
      const existing = await this.accountRepo.findByWorkspaceEmail(email);
      if (!existing) {
        continue;
      }
      await this.jobs.cancelQueuedUsbJobsForAccount(existing.id, now());
      const latest = await this.accountRepo.getById(existing.id);
      if (!latest) {
        continue;
      }
      const resettable =
        latest.status === "SETUP_IN_PROGRESS" ||
        latest.status === "ACTION_REQUIRED" ||
        latest.status === "FAILED";
      if (resettable) {
        latest.status = "SETUP_REQUIRED";
        latest.setupStatus = "REQUIRED";
        latest.metadata = {
          ...latest.metadata,
          setupProgress: "Starting Device Farm worker"
        };
        latest.updatedAt = now();
        await this.accountRepo.update(latest);
      } else if (latest.status === "NEEDS_REAUTH") {
        latest.metadata = {
          ...latest.metadata,
          sessionVerified: false,
          setupProgress: "Device Farm re-auth queued"
        };
        latest.updatedAt = now();
        await this.accountRepo.update(latest);
      }
    }

    const prepared = await this.accounts.startWorkspaceWePlaySetup({ emails });
    if (prepared.started.length === 0) {
      const reason = prepared.skipped[0]?.reason ?? "Account is not eligible";
      throw new HttpError(409, reason, "INVALID_CONFIGURATION");
    }
    const ts = now();
    const provisionings: DeviceFarmProvisioning[] = [];
    for (const account of prepared.started) {
      const workspaceEmail = String(account.metadata.workspaceEmail ?? "").toLowerCase();
      const provisioning: DeviceFarmProvisioning = {
        id: createId(),
        accountId: account.id,
        workspaceUserId: String(account.metadata.workspaceUserId ?? ""),
        workspaceEmail,
        deviceFarmRunArn: null,
        deviceFarmJobArn: null,
        deviceArn: null,
        deviceName: null,
        weplayUserId: null,
        provisioningStatus: "PENDING",
        errorCode: null,
        errorMessage: null,
        createdAt: ts,
        updatedAt: ts,
        startedAt: null,
        completedAt: null
      };
      await this.repo.insert(provisioning);
      provisionings.push(provisioning);
      account.metadata = {
        ...account.metadata,
        provisioningStatus: "PENDING",
        deviceFarmProvisioningId: provisioning.id,
        setupProgress:
          prepared.started.length > 1
            ? `Device Farm batch queued (${prepared.started.length} accounts, one Pixel)`
            : "Device Farm worker queued"
      };
      account.updatedAt = now();
      await this.accountRepo.update(account);
    }
    const account = prepared.started[0]!;
    const provisioning = provisionings[0]!;
    const workspaceEmails = provisionings.map((row) => row.workspaceEmail);
    const job = await this.jobService.create({
      accountId: account.id,
      runId: null,
      configuration: {
        kind: "devicefarm_provision",
        loginProvider: "GOOGLE",
        workspaceEmail: provisioning.workspaceEmail,
        workspaceEmails,
        deviceFarmProvisioningId: provisioning.id,
        deviceFarmProvisioningIds: provisionings.map((row) => row.id)
      }
    });
    await this.logs.record({
      accountId: account.id,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: "DEVICEFARM_PROVISION_STARTED",
      status: "PENDING",
      error: null,
      message:
        workspaceEmails.length > 1
          ? `Device Farm worker queued for ${workspaceEmails.length} Workspace accounts on one Pixel`
          : `Device Farm worker queued for ${provisioning.workspaceEmail}`
    });
    this.bus.publish("changed", { source: "devicefarm" });
    const accounts = await Promise.all(prepared.started.map((row) => this.accounts.get(row.id)));
    return {
      account: accounts[0]!,
      accounts,
      provisioning,
      job,
      skipped: prepared.skipped
    };
  }

  async recover(): Promise<void> {
    const open = await this.repo.listInFlight();
    const resumed: Promise<void>[] = [];
    const seenRunArns = new Set<string>();
    for (const row of open) {
      if (row.provisioningStatus === "RUNNING" && row.deviceFarmRunArn) {
        if (seenRunArns.has(row.deviceFarmRunArn) || this.inFlight.has(row.deviceFarmRunArn)) {
          continue;
        }
        seenRunArns.add(row.deviceFarmRunArn);
        this.inFlight.add(row.deviceFarmRunArn);
        resumed.push(
          this.resumeScheduledRun(row).finally(() => {
            this.inFlight.delete(row.deviceFarmRunArn!);
          })
        );
        continue;
      }
      if (row.provisioningStatus === "RUNNING" && !row.deviceFarmRunArn) {
        row.provisioningStatus = "FAILED";
        row.errorCode = "NETWORK_ERROR";
        row.errorMessage = "API restarted before the Device Farm run was scheduled";
        row.updatedAt = now();
        row.completedAt = row.updatedAt;
        await this.repo.update(row);
      }
    }
    if (resumed.length > 0 && this.env.NODE_ENV === "test") {
      await Promise.allSettled(resumed);
    }
    await this.resetOrphanedSetupInProgress();
  }

  private async resetOrphanedSetupInProgress(): Promise<void> {
    const inFlight = await this.repo.listInFlight();
    const inFlightAccountIds = new Set(inFlight.map((row) => row.accountId));
    const accounts = await this.accountRepo.list();
    const ts = now();
    for (const account of accounts) {
      if (account.status !== "SETUP_IN_PROGRESS" || inFlightAccountIds.has(account.id)) {
        continue;
      }
      account.status = "SETUP_REQUIRED";
      account.setupStatus = "REQUIRED";
      account.metadata = {
        ...account.metadata,
        setupProgress: "Previous Device Farm run ended; ready to retry"
      };
      account.updatedAt = ts;
      await this.accountRepo.update(account);
    }
  }

  async processDue(): Promise<void> {
    if (this.inFlight.size >= 1) {
      return;
    }
    const due = await this.jobs.listQueuedDeviceFarmDue(now(), 1);
    const started: Promise<void>[] = [];
    for (const job of due) {
      if (this.inFlight.size >= 1) {
        break;
      }
      const provisioningId = job.configuration.deviceFarmProvisioningId;
      if (!provisioningId) {
        continue;
      }
      const claimed = await this.jobs.tryStartInternal(job.id, now());
      if (!claimed) {
        continue;
      }
      this.inFlight.add(provisioningId);
      started.push(
        this.executeJob(job.id).finally(() => {
          this.inFlight.delete(provisioningId);
        })
      );
    }
    if (started.length === 0) {
      await this.processJoinDue();
    }
    if (started.length > 0 && this.env.NODE_ENV === "test") {
      await Promise.allSettled(started);
    }
  }

  async processJoinDue(): Promise<void> {
    if (this.inFlight.size >= 1) {
      return;
    }
    if ((await this.repo.countInFlight()) > 0) {
      return;
    }
    await this.ensureJoinBatchFromQueuedJobs();
    const due = await this.jobs.listQueuedDeviceFarmJoinDue(now(), 1);
    if (due.length === 0) {
      return;
    }
    const job = due[0]!;
    const claimed = await this.jobs.tryStartInternal(job.id, now());
    if (!claimed) {
      return;
    }
    this.inFlight.add(job.id);
    const run = this.executeJoinJob(job.id).finally(() => {
      this.inFlight.delete(job.id);
    });
    if (this.env.NODE_ENV === "test") {
      await run;
    }
  }

  async startJoin(input: {
    emails: string[];
    roomId: string;
    supportTarget?: string;
  }): Promise<{ job: Job; accounts: Account[]; joinJobIds: string[] }> {
    const emails = uniqueLowerEmails(input.emails);
    const roomId = sanitizeGameCode(input.roomId);
    if (emails.length === 0) {
      throw new HttpError(400, "Select at least one Workspace email", "INVALID_CONFIGURATION");
    }
    if (!roomId) {
      throw new HttpError(400, "Room ID / game code is required", "INVALID_CONFIGURATION");
    }
    const status = this.connectionStatus();
    if (!status.configured) {
      throw new HttpError(400, "AWS Device Farm is not configured", "DEVICEFARM_NOT_CONFIGURED");
    }
    if ((await this.repo.countInFlight()) > 0 || this.inFlight.size > 0) {
      throw new HttpError(409, "A Device Farm worker is already running", "DEVICEFARM_IN_PROGRESS");
    }
    this.requireSharedWorkspacePassword();
    const accounts: Account[] = [];
    for (const email of emails) {
      const account = await this.accountRepo.findByWorkspaceEmail(email);
      if (!account) {
        throw new HttpError(404, `No account for ${email}`, "NOT_FOUND");
      }
      if (account.setupStatus !== "COMPLETED") {
        throw new HttpError(400, `${email} is not ready for join (setup incomplete)`, "INVALID_CONFIGURATION");
      }
      accounts.push(account);
    }
    const ts = now();
    const joinJobIds: string[] = [];
    for (const account of accounts) {
      const joinJob = await this.jobService.create({
        accountId: account.id,
        runId: null,
        configuration: {
          kind: "join_room",
          roomId,
          supportTarget: input.supportTarget?.trim() ?? ""
        },
        scheduledAt: ts
      });
      joinJobIds.push(joinJob.id);
      await this.jobs.tryStartInternal(joinJob.id, ts);
    }
    const coordinator = await this.jobService.create({
      accountId: accounts[0]!.id,
      runId: null,
      configuration: {
        kind: "devicefarm_join",
        roomId,
        supportTarget: input.supportTarget?.trim() ?? "",
        workspaceEmails: emails,
        deviceFarmJoinJobIds: joinJobIds
      },
      scheduledAt: ts
    });
    await this.logs.record({
      accountId: accounts[0]!.id,
      jobId: coordinator.id,
      workerId: null,
      runId: null,
      event: "DEVICEFARM_PROVISION_STARTED",
      status: "PENDING",
      error: null,
      message: `Device Farm join queued for ${emails.length} account(s) on one Pixel (room ${roomId})`
    });
    this.bus.publish("changed", { source: "devicefarm" });
    void this.processJoinDue();
    return { job: coordinator, accounts, joinJobIds };
  }

  private async ensureJoinBatchFromQueuedJobs(): Promise<void> {
    const existing = await this.jobs.listQueuedDeviceFarmJoinDue(now(), 1);
    if (existing.length > 0) {
      return;
    }
    const batchSize = this.env.DEVICEFARM_JOIN_BATCH_SIZE;
    const queued = await this.jobs.listQueuedJoinRoomDue(now(), batchSize);
    if (queued.length === 0) {
      return;
    }
    const roomId = sanitizeGameCode(String(queued[0]?.configuration.roomId ?? ""));
    if (!roomId) {
      return;
    }
    const supportTarget = String(queued[0]?.configuration.supportTarget ?? "").trim();
    const emails: string[] = [];
    const joinJobIds: string[] = [];
    const ts = now();
    for (const job of queued) {
      if (sanitizeGameCode(String(job.configuration.roomId ?? "")) !== roomId) {
        continue;
      }
      if (!job.accountId) {
        continue;
      }
      const account = await this.accountRepo.getById(job.accountId);
      const email = String(account?.metadata.workspaceEmail ?? "").trim().toLowerCase();
      if (!email) {
        continue;
      }
      emails.push(email);
      joinJobIds.push(job.id);
      await this.jobs.tryStartInternal(job.id, ts);
    }
    if (emails.length === 0) {
      return;
    }
    await this.jobService.create({
      accountId: queued[0]!.accountId,
      runId: queued[0]!.runId,
      configuration: {
        kind: "devicefarm_join",
        roomId,
        supportTarget,
        workspaceEmails: uniqueLowerEmails(emails),
        deviceFarmJoinJobIds: joinJobIds
      },
      scheduledAt: ts
    });
  }

  private async executeJoinJob(jobId: string): Promise<void> {
    const job = await this.jobs.getById(jobId);
    if (!job || job.configuration.kind !== "devicefarm_join") {
      return;
    }
    const workspaceEmails = uniqueLowerEmails(job.configuration.workspaceEmails ?? []);
    const roomId = sanitizeGameCode(String(job.configuration.roomId ?? ""));
    const supportTarget = String(job.configuration.supportTarget ?? "").trim();
    const joinJobIds = job.configuration.deviceFarmJoinJobIds ?? [];
    if (workspaceEmails.length === 0 || !roomId) {
      await this.failJoinCoordinator(job, "INVALID_CONFIGURATION", "Join batch is missing emails or room ID");
      return;
    }
    const workspacePassword = this.requireSharedWorkspacePassword();
    const pin = this.env.DEVICEFARM_DEVICE_PIN || "1234";
    const primaryEmail = workspaceEmails[0]!;
    const startedAt = now();
    await this.logs.record({
      accountId: job.accountId,
      jobId: job.id,
      workerId: null,
      runId: job.runId,
      event: "DEVICEFARM_PROVISION_PROGRESS",
      status: "RUNNING",
      error: null,
      message: `Scheduling Device Farm Pixel join for ${workspaceEmails.length} account(s)`
    });
    try {
      const jobTimeoutMinutes = deviceFarmJobTimeoutMinutes(this.env.DEVICEFARM_JOB_TIMEOUT_MINUTES, workspaceEmails.length);
      const scheduled = await this.deviceFarm.scheduleProvision({
        workspaceEmail: primaryEmail,
        workspaceEmails,
        workspacePassword,
        playStoreEmail: resolvePlayStoreEmail(this.env, primaryEmail),
        devicePin: pin,
        runName: `weplay-join-${job.id.slice(0, 8)}`,
        gameCode: roomId,
        runMode: "join_batch",
        supportTarget,
        jobTimeoutMinutes
      });
      await this.logs.record({
        accountId: job.accountId,
        jobId: job.id,
        workerId: null,
        runId: job.runId,
        event: "DEVICEFARM_PROVISION_PROGRESS",
        status: "RUNNING",
        error: null,
        message: "Device Farm join run scheduled",
        metadata: { deviceFarmRunArn: scheduled.runArn, startedAt }
      });
      const outcome = await this.deviceFarm.waitForRun(
        scheduled.runArn,
        jobTimeoutMinutes * 60_000,
        async (update) => {
          await this.logs.record({
            accountId: job.accountId,
            jobId: job.id,
            workerId: null,
            runId: job.runId,
            event: "DEVICEFARM_PROVISION_PROGRESS",
            status: update.status ?? "RUNNING",
            error: null,
            message: update.deviceName
              ? `Device Farm ${update.status ?? "RUNNING"} on ${update.deviceName}`
              : `Device Farm run ${update.status ?? "RUNNING"}`
          });
        }
      );
      await this.applyJoinOutcome(job, joinJobIds, outcome, startedAt);
    } catch (error) {
      const mapped = this.mapError(error);
      await this.failJoinCoordinator(job, mapped.code, mapped.message, joinJobIds);
    }
  }

  private async applyJoinOutcome(
    coordinator: Job,
    joinJobIds: string[],
    outcome: Awaited<ReturnType<DeviceFarmWorkerClient["waitForRun"]>>,
    startedAt: number
  ): Promise<void> {
    const worker = outcome.worker;
    const members = worker?.accounts?.length ? worker.accounts : [];
    const joinJobs = (
      await Promise.all(joinJobIds.map((id) => this.jobs.getById(id)))
    ).filter((row): row is Job => Boolean(row));
    let anyOk = false;
    const ts = now();
    const totalMs = worker?.totalDurationMs ?? ts - startedAt;
    for (const joinJob of joinJobs) {
      const account = joinJob.accountId ? await this.accountRepo.getById(joinJob.accountId) : undefined;
      if (!account) {
        continue;
      }
      const email = String(account.metadata.workspaceEmail ?? "").trim().toLowerCase();
      const member = members.find((row) => String(row.workspaceEmail ?? "").toLowerCase() === email);
      const joined = member?.joinedRoom === true;
      const supportOk = member?.supportClicked === true;
      const ok = member?.ok === true && joined && supportOk;
      joinJob.completedAt = ts;
      joinJob.updatedAt = ts;
      if (ok) {
        anyOk = true;
        joinJob.status = "SUCCEEDED";
        joinJob.errorCode = null;
        joinJob.errorMessage = null;
        account.status = "SUCCESS";
        account.lastSuccessAt = ts;
        account.lastUsedAt = ts;
        account.lastErrorCode = null;
        account.lastErrorMessage = null;
        account.metadata = {
          ...account.metadata,
          joinedRoom: true,
          supportClicked: member?.supportClicked === true,
          lastJoinDurationMs: member?.joinDurationMs ?? member?.durationMs ?? null,
          deviceFarmRunArn: outcome.runArn,
          deviceName: outcome.deviceName
        };
        account.updatedAt = ts;
        await this.accountRepo.update(account);
        await this.logs.record({
          accountId: account.id,
          jobId: joinJob.id,
          workerId: null,
          runId: joinJob.runId,
          event: "ROOM_OPENED",
          status: "SUCCEEDED",
          error: null,
          message: `Joined room on ${outcome.deviceName ?? "Pixel"} in ${member?.joinDurationMs ?? "?"}ms (account ${member?.durationMs ?? "?"}ms total)`
        });
      } else {
        const mapped = member
          ? this.mapWorkerFailure(
              {
                ok: false,
                joinedRoom: member.joinedRoom,
                error: member.error,
                errorMessage: member.errorMessage
              },
              outcome.result
            )
          : { code: "DEVICEFARM_RUN_FAILED" as ErrorCode, message: "No join result for this account on the Pixel" };
        joinJob.status = "FAILED";
        joinJob.errorCode = mapped.code;
        joinJob.errorMessage = mapped.message;
        account.lastFailureAt = ts;
        account.lastUsedAt = ts;
        account.lastErrorCode = mapped.code;
        account.lastErrorMessage = mapped.message;
        account.updatedAt = ts;
        await this.accountRepo.update(account);
        await this.logs.record({
          accountId: account.id,
          jobId: joinJob.id,
          workerId: null,
          runId: joinJob.runId,
          event: "JOB_FAILED",
          status: "FAILED",
          error: mapped.code,
          message: mapped.message
        });
      }
      await this.jobs.update(joinJob);
    }
    coordinator.status = anyOk ? "SUCCEEDED" : "FAILED";
    coordinator.completedAt = ts;
    coordinator.updatedAt = ts;
    coordinator.errorCode = anyOk ? null : "DEVICEFARM_RUN_FAILED";
    coordinator.errorMessage = anyOk
      ? null
      : worker?.errorMessage || "Device Farm join batch did not verify room entry";
    await this.jobs.update(coordinator);
    await this.logs.record({
      accountId: coordinator.accountId,
      jobId: coordinator.id,
      workerId: null,
      runId: coordinator.runId,
      event: anyOk ? "DEVICEFARM_PROVISION_SUCCEEDED" : "DEVICEFARM_PROVISION_FAILED",
      status: coordinator.status,
      error: coordinator.errorCode,
      message: anyOk
        ? `Device Farm join completed in ${totalMs}ms on ${outcome.deviceName ?? "Pixel"}`
        : coordinator.errorMessage
    });
    this.bus.publish("changed", { source: "devicefarm" });
  }

  private async failJoinCoordinator(
    job: Job,
    errorCode: ErrorCode,
    errorMessage: string,
    joinJobIds: string[] = job.configuration.deviceFarmJoinJobIds ?? []
  ): Promise<void> {
    const ts = now();
    for (const joinJobId of joinJobIds) {
      const joinJob = await this.jobs.getById(joinJobId);
      if (!joinJob || joinJob.status === "SUCCEEDED") {
        continue;
      }
      joinJob.status = "FAILED";
      joinJob.completedAt = ts;
      joinJob.updatedAt = ts;
      joinJob.errorCode = errorCode;
      joinJob.errorMessage = errorMessage;
      await this.jobs.update(joinJob);
    }
    job.status = "FAILED";
    job.completedAt = ts;
    job.updatedAt = ts;
    job.errorCode = errorCode;
    job.errorMessage = errorMessage;
    await this.jobs.update(job);
    this.bus.publish("changed", { source: "devicefarm" });
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = await this.jobs.getById(jobId);
    if (!job?.configuration.deviceFarmProvisioningId) {
      return;
    }
    const provisioning = await this.repo.getById(job.configuration.deviceFarmProvisioningId);
    const account = job.accountId ? await this.accountRepo.getById(job.accountId) : undefined;
    if (!provisioning || !account) {
      return;
    }
    const email = provisioning.workspaceEmail;
    const workspacePassword = this.env.WEPLAY_WORKSPACE_PASSWORD.trim();
    const pin = this.env.DEVICEFARM_DEVICE_PIN || "1234";
    const ts = now();
    const batch = await this.batchProvisionings(job, provisioning);
    const workspaceEmails = uniqueLowerEmails(
      job.configuration.workspaceEmails?.length ? job.configuration.workspaceEmails : batch.map((row) => row.workspaceEmail)
    );
    for (const row of batch) {
      row.provisioningStatus = "RUNNING";
      row.startedAt = ts;
      row.updatedAt = ts;
      await this.repo.update(row);
      const batchAccount = await this.accountRepo.getById(row.accountId);
      if (batchAccount) {
        batchAccount.metadata = {
          ...batchAccount.metadata,
          provisioningStatus: "RUNNING",
          setupProgress:
            batch.length > 1
              ? `One Pixel run: Play identity + WePlay install once, then ${batch.length} Google accounts`
              : "Starting AWS Device Farm Android worker"
        };
        batchAccount.updatedAt = ts;
        await this.accountRepo.update(batchAccount);
      }
    }
    await this.logs.record({
      accountId: account.id,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: "DEVICEFARM_PROVISION_PROGRESS",
      status: "RUNNING",
      error: null,
      message:
        batch.length > 1
          ? `Scheduling one Device Farm Pixel for ${batch.length} Workspace accounts`
          : "Scheduling the Device Farm worker"
    });
    this.bus.publish("changed", { source: "devicefarm" });

    try {
      if (!workspacePassword) {
        throw new HttpError(
          400,
          "Set WEPLAY_WORKSPACE_PASSWORD in the API .env to the Google Workspace password every account should use.",
          "INVALID_CONFIGURATION"
        );
      }
      const jobTimeoutMinutes = deviceFarmJobTimeoutMinutes(this.env.DEVICEFARM_JOB_TIMEOUT_MINUTES, workspaceEmails.length);
      const scheduled = await this.deviceFarm.scheduleProvision({
        workspaceEmail: email,
        workspaceEmails,
        workspacePassword,
        playStoreEmail: resolvePlayStoreEmail(this.env, email),
        devicePin: pin,
        runName: `weplay-provision-${account.id.slice(0, 8)}`,
        gameCode: sanitizeGameCode(this.env.WEPLAY_GAME_CODE),
        jobTimeoutMinutes
      });
      for (const row of batch) {
        row.deviceFarmRunArn = scheduled.runArn;
        row.updatedAt = now();
        await this.repo.update(row);
        const batchAccount = await this.accountRepo.getById(row.accountId);
        if (batchAccount) {
          batchAccount.metadata = {
            ...batchAccount.metadata,
            deviceFarmRunArn: scheduled.runArn,
            setupProgress: "Device Farm run scheduled; waiting for the Android worker"
          };
          batchAccount.updatedAt = now();
          await this.accountRepo.update(batchAccount);
        }
      }
      await this.logs.record({
        accountId: account.id,
        jobId: job.id,
        workerId: null,
        runId: null,
        event: "DEVICEFARM_PROVISION_PROGRESS",
        status: "RUNNING",
        error: null,
        message: "Device Farm run scheduled",
        metadata: { deviceFarmRunArn: scheduled.runArn }
      });

      const outcome = await this.deviceFarm.waitForRun(
        scheduled.runArn,
        jobTimeoutMinutes * 60_000,
        (update) => this.recordRunProgress(account, provisioning, update)
      );
      await this.applyOutcome(account, job, provisioning, outcome);
    } catch (error) {
      const mapped = this.mapError(error);
      for (const row of batch) {
        const batchAccount = (await this.accountRepo.getById(row.accountId)) ?? account;
        await this.fail(batchAccount, job, row, mapped.code, mapped.message);
      }
    }
  }

  private async resumeScheduledRun(provisioning: DeviceFarmProvisioning): Promise<void> {
    const runArn = provisioning.deviceFarmRunArn;
    if (!runArn) {
      return;
    }
    const account = await this.accountRepo.getById(provisioning.accountId);
    const jobs = await this.jobs.list({
      accountId: provisioning.accountId,
      kind: "devicefarm_provision",
      limit: 20
    });
    const job = jobs.find(
      (row) =>
        (row.configuration.deviceFarmProvisioningId === provisioning.id ||
          row.configuration.deviceFarmProvisioningIds?.includes(provisioning.id)) &&
        (row.status === "RUNNING" || row.status === "ASSIGNED")
    );
    if (!account || !job) {
      return;
    }
    const batch = await this.batchProvisionings(job, provisioning);
    const accountCount = job.configuration.workspaceEmails?.length || batch.length;
    try {
      const outcome = await this.deviceFarm.waitForRun(
        runArn,
        deviceFarmJobTimeoutMinutes(this.env.DEVICEFARM_JOB_TIMEOUT_MINUTES, accountCount) * 60_000,
        (update) => this.recordRunProgress(account, provisioning, update)
      );
      await this.applyOutcome(account, job, provisioning, outcome);
    } catch (error) {
      const mapped = this.mapError(error);
      for (const [index, row] of batch.entries()) {
        const batchAccount = (await this.accountRepo.getById(row.accountId)) ?? account;
        await this.fail(batchAccount, job, row, mapped.code, mapped.message, {
          updateJob: index === batch.length - 1
        });
      }
    }
  }

  private async recordRunProgress(
    account: Account,
    provisioning: DeviceFarmProvisioning,
    update: DeviceFarmRunProgress
  ): Promise<void> {
    const deviceName = update.deviceName?.trim() || null;
    const status = update.status?.trim() || "PENDING";
    const key = `${status}|${deviceName ?? ""}`;
    const changed = this.lastProgressKey.get(provisioning.id) !== key;
    if (deviceName && provisioning.deviceName !== deviceName) {
      provisioning.deviceArn = update.deviceArn ?? provisioning.deviceArn;
      provisioning.deviceName = deviceName;
      provisioning.updatedAt = now();
      await this.repo.update(provisioning);
    }
    if (!changed) {
      return;
    }
    this.lastProgressKey.set(provisioning.id, key);
    const setupProgress = deviceName ? `Device Farm ${status} on ${deviceName}` : `Device Farm run ${status}`;
    account.metadata = {
      ...account.metadata,
      deviceArn: provisioning.deviceArn,
      deviceName: provisioning.deviceName,
      setupProgress
    };
    account.updatedAt = now();
    await this.accountRepo.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: null,
      runId: null,
      event: "DEVICEFARM_PROVISION_PROGRESS",
      status,
      error: null,
      message: setupProgress
    });
    this.bus.publish("changed", { source: "devicefarm" });
  }

  private async batchProvisionings(job: Job, primary: DeviceFarmProvisioning): Promise<DeviceFarmProvisioning[]> {
    const ids = job.configuration.deviceFarmProvisioningIds ?? [];
    const rows: DeviceFarmProvisioning[] = [];
    for (const id of ids) {
      const row = await this.repo.getById(id);
      if (row) {
        rows.push(row);
      }
    }
    if (rows.length > 0) {
      return rows;
    }
    if (primary.deviceFarmRunArn) {
      const byRun = await this.repo.listByRunArn(primary.deviceFarmRunArn);
      if (byRun.length > 0) {
        return byRun;
      }
    }
    return [primary];
  }

  private async applyOutcome(
    account: Account,
    job: Job,
    provisioning: DeviceFarmProvisioning,
    outcome: Awaited<ReturnType<DeviceFarmWorkerClient["waitForRun"]>>
  ): Promise<void> {
    const worker = outcome.worker;
    const batch = await this.batchProvisionings(job, provisioning);
    const members = worker?.accounts?.length
      ? worker.accounts
      : [
          {
            workspaceEmail: worker?.workspaceEmail ?? provisioning.workspaceEmail,
            ok: worker?.ok,
            weplayUserId: worker?.weplayUserId,
            googleAccountPresent: worker?.googleAccountPresent,
            screen: worker?.screen,
            activity: worker?.activity,
            error: worker?.error,
            errorMessage: worker?.errorMessage
          }
        ];
    const playIdentityOk =
      worker?.playStoreIdentityOk === true || worker?.playStoreAccountMatchesExpected === true;
    let anyReady = false;
    let lastError = "";
    for (const row of batch) {
      const accountRow = (await this.accountRepo.getById(row.accountId)) ?? (row.id === provisioning.id ? account : null);
      if (!accountRow) {
        continue;
      }
      const member =
        members.find((item) => String(item.workspaceEmail ?? "").toLowerCase() === row.workspaceEmail) ??
        (batch.length === 1 ? members[0] : undefined);
      const joinOk =
        worker?.gameCodeSet === true
          ? member?.joinedRoom === true || (batch.length === 1 && worker.joinedRoom === true)
          : true;
      row.deviceFarmRunArn = outcome.runArn;
      row.deviceFarmJobArn = outcome.jobArn;
      row.deviceArn = outcome.deviceArn;
      row.deviceName = outcome.deviceName;
      row.weplayUserId = member?.weplayUserId ?? null;
      row.updatedAt = now();
      const memberOk = member?.ok === true;
      const verified =
        memberOk &&
        Boolean(worker?.weplayInstalled) &&
        Boolean(member?.googleAccountPresent ?? worker?.googleAccountPresent) &&
        playIdentityOk &&
        Boolean(member?.weplayUserId?.trim()) &&
        joinOk &&
        VERIFIED_SCREENS.has(String(member?.screen ?? worker?.screen ?? ""));
      if (verified) {
        await this.markReady(accountRow, job, row, outcome, {
          weplayUserId: member?.weplayUserId,
          joinedRoom: worker?.joinedRoom === true,
          playStoreChannel: worker?.playStoreChannel ?? null,
          playIdentityOk
        });
        anyReady = true;
        continue;
      }
      const mapped = member
        ? this.mapWorkerFailure(
            {
              ok: false,
              weplayInstalled: worker?.weplayInstalled,
              googleAccountPresent: member.googleAccountPresent,
              playStoreIdentityOk: worker?.playStoreIdentityOk,
              playStoreAccountMatchesExpected: worker?.playStoreAccountMatchesExpected,
              weplayUserId: member.weplayUserId,
              screen: member.screen,
              error: member.error,
              errorMessage: member.errorMessage
            },
            outcome.result
          )
        : {
            code: "DEVICEFARM_RUN_FAILED" as ErrorCode,
            message: "This Pixel run did not return a result for this Workspace account"
          };
      lastError = mapped.message;
      await this.fail(accountRow, job, row, mapped.code, mapped.message, { updateJob: false });
    }
    const ts = now();
    job.status = anyReady ? "SUCCEEDED" : "FAILED";
    job.completedAt = ts;
    job.updatedAt = ts;
    job.errorCode = anyReady ? null : "DEVICEFARM_RUN_FAILED";
    job.errorMessage = anyReady ? null : lastError || "Device Farm did not verify a WePlay session";
    await this.jobs.update(job);
    this.bus.publish("changed", { source: "devicefarm" });
  }

  private async markReady(
    account: Account,
    job: Job,
    provisioning: DeviceFarmProvisioning,
    outcome: Awaited<ReturnType<DeviceFarmWorkerClient["waitForRun"]>>,
    details: {
      weplayUserId?: string | null;
      joinedRoom: boolean;
      playStoreChannel: string | null;
      playIdentityOk: boolean;
    }
  ): Promise<void> {
    const ts = now();
    provisioning.provisioningStatus = "SUCCEEDED";
    provisioning.completedAt = ts;
    provisioning.errorCode = null;
    provisioning.errorMessage = null;
    provisioning.weplayUserId = details.weplayUserId ?? provisioning.weplayUserId;
    await this.repo.update(provisioning);
    account.status = "READY";
    account.setupStatus = "COMPLETED";
    account.lastSuccessAt = ts;
    account.lastUsedAt = ts;
    account.lastErrorCode = null;
    account.lastErrorMessage = null;
    account.metadata = {
      ...account.metadata,
      setupProgress: "Verified WePlay login and Play Store identity on Device Farm",
      setupVerifiedBy: "devicefarm_worker",
      sessionVerified: true,
      sessionVerifiedAt: ts,
      deviceFarmRunArn: outcome.runArn,
      deviceFarmJobArn: outcome.jobArn,
      deviceArn: outcome.deviceArn,
      deviceName: outcome.deviceName,
      weplayUserId: details.weplayUserId ?? account.metadata.weplayUserId,
      weplayName: String(account.metadata.weplayName ?? account.displayName),
      joinedRoom: details.joinedRoom,
      playStoreChannel: details.playStoreChannel,
      playStoreIdentityOk: details.playIdentityOk,
      provisioningStatus: "SUCCEEDED"
    };
    account.updatedAt = ts;
    await this.accountRepo.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: "DEVICEFARM_PROVISION_SUCCEEDED",
      status: "SUCCEEDED",
      error: null,
      message: `WePlay login verified on ${outcome.deviceName ?? "Device Farm device"}`
    });
    await this.logs.record({
      accountId: account.id,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: "ACCOUNT_SETUP_COMPLETED",
      status: "READY",
      error: null,
      message: "Setup completed by Device Farm worker after verified WePlay session"
    });
    await this.logs.record({
      accountId: account.id,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: "ACCOUNT_READY",
      status: "READY",
      error: null,
      message: "Account ready"
    });
  }

  private async fail(
    account: Account,
    job: Job,
    provisioning: DeviceFarmProvisioning,
    errorCode: ErrorCode,
    errorMessage: string,
    options?: { updateJob?: boolean }
  ): Promise<void> {
    const ts = now();
    const actionRequired = errorCode === "VERIFICATION_REQUIRED" || errorCode === "PERMISSION_REQUIRED";
    provisioning.provisioningStatus = actionRequired ? "ACTION_REQUIRED" : "FAILED";
    provisioning.errorCode = errorCode;
    provisioning.errorMessage = errorMessage;
    provisioning.updatedAt = ts;
    provisioning.completedAt = ts;
    await this.repo.update(provisioning);
    if (options?.updateJob !== false) {
      job.status = "FAILED";
      job.completedAt = ts;
      job.updatedAt = ts;
      job.errorCode = errorCode;
      job.errorMessage = errorMessage;
      await this.jobs.update(job);
    }
    account.lastFailureAt = ts;
    account.lastUsedAt = ts;
    account.lastErrorCode = errorCode;
    account.lastErrorMessage = errorMessage;
    if (actionRequired) {
      account.status = "ACTION_REQUIRED";
      account.setupStatus = "ACTION_REQUIRED";
    } else {
      account.status = "SETUP_REQUIRED";
      account.setupStatus = "REQUIRED";
    }
    account.metadata = {
      ...account.metadata,
      setupProgress: errorMessage,
      provisioningStatus: provisioning.provisioningStatus,
      deviceFarmRunArn: provisioning.deviceFarmRunArn,
      deviceName: provisioning.deviceName
    };
    account.updatedAt = ts;
    await this.accountRepo.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: job.id,
      workerId: null,
      runId: null,
      event: actionRequired ? "ACCOUNT_ACTION_REQUIRED" : "DEVICEFARM_PROVISION_FAILED",
      status: account.status,
      error: errorCode,
      message: errorMessage
    });
    this.bus.publish("changed", { source: "devicefarm" });
  }

  private mapWorkerFailure(worker: DeviceFarmWorkerResult | null, runResult: string): {
    code: ErrorCode;
    message: string;
  } {
    if (worker?.error === "ACTION_REQUIRED" || worker?.error === "VERIFICATION_REQUIRED") {
      return {
        code: "VERIFICATION_REQUIRED",
        message: worker.errorMessage || "Google presented a security challenge on the Device Farm device"
      };
    }
    if (worker?.error === "play_store" || worker?.error === "PLAY_STORE_INSTALL_FAILED") {
      return {
        code: "PLAY_STORE_INSTALL_FAILED",
        message: worker.errorMessage || "Play Store did not install WePlay"
      };
    }
    if (worker?.error === "google_account" || worker?.error === "GOOGLE_ACCOUNT_ADD_FAILED") {
      return {
        code: "GOOGLE_ACCOUNT_ADD_FAILED",
        message: worker.errorMessage || "Could not add the Workspace Google account on the device"
      };
    }
    if (worker?.error === "join_room" || worker?.error === "ROOM_NOT_FOUND") {
      return {
        code: "ROOM_NOT_FOUND",
        message: worker.errorMessage || "WePlay did not join the configured game code"
      };
    }
    if (worker?.error === "show_support") {
      return {
        code: "DEVICEFARM_RUN_FAILED",
        message: worker.errorMessage || "Show Support was not confirmed in the voice room"
      };
    }
    if (worker?.error === "weplay_session") {
      return {
        code: "DEVICEFARM_RUN_FAILED",
        message: worker.errorMessage || "WePlay user id/session was not obtained"
      };
    }
    if (worker?.errorMessage) {
      return { code: "DEVICEFARM_RUN_FAILED", message: worker.errorMessage };
    }
    return {
      code: "DEVICEFARM_RUN_FAILED",
      message: `Device Farm run finished with ${runResult} and did not verify a WePlay session`
    };
  }

  private mapError(error: unknown): { code: ErrorCode; message: string } {
    if (error instanceof DeviceFarmNotConfiguredError) {
      return { code: "DEVICEFARM_NOT_CONFIGURED", message: error.message };
    }
    if (error instanceof HttpError) {
      return { code: (error.code as ErrorCode | undefined) ?? "UNKNOWN_STATE", message: error.message };
    }
    const message = error instanceof Error ? error.message.slice(0, 500) : "Device Farm worker failed";
    if (isTransientAwsNetworkError(error)) {
      return { code: "NETWORK_ERROR", message };
    }
    return { code: "DEVICEFARM_RUN_FAILED", message };
  }

  requireSharedWorkspacePassword(): string {
    const password = this.env.WEPLAY_WORKSPACE_PASSWORD.trim();
    if (!password) {
      throw new HttpError(
        400,
        "Set WEPLAY_WORKSPACE_PASSWORD in the API .env to the Google Workspace password every account should use.",
        "INVALID_CONFIGURATION"
      );
    }
    return password;
  }

  async applySharedPasswordToDirectoryUsers(password = this.env.WEPLAY_WORKSPACE_PASSWORD.trim()): Promise<number> {
    const shared = password.trim();
    if (!shared) {
      throw new HttpError(
        400,
        "Set WEPLAY_WORKSPACE_PASSWORD in the API .env to the Google Workspace password every account should use.",
        "INVALID_CONFIGURATION"
      );
    }
    if (!this.directory.configured) {
      throw new HttpError(400, "Google Workspace Admin SDK credentials are not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    const users = await this.directory.listUsers();
    let updated = 0;
    for (const user of users) {
      if (user.suspended) {
        continue;
      }
      await this.directory.setPassword(user.primaryEmail, shared, false);
      updated += 1;
    }
    return updated;
  }

}
