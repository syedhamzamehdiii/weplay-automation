import {
  assertAccountTransition,
  createId,
  isAccountEligibleForSupport,
  now
} from "@weplay/shared";
import type { Account, LoginProvider, OauthLoginProvider, WorkspaceWePlayCandidate } from "@weplay/types";
import { HttpError } from "../http.js";
import type { AccountRepository } from "../repositories/AccountRepository.js";
import type { JobRepository } from "../repositories/JobRepository.js";
import type { WorkerRepository } from "../repositories/WorkerRepository.js";
import type { GoogleDirectoryClient } from "../google/directory.js";
import type { LogService } from "./LogService.js";
import type { EventBus } from "../events/bus.js";

function workspaceEmailFrom(account: Account): string {
  return String(account.metadata.workspaceEmail ?? "").trim().toLowerCase();
}

function hasVerifiedWePlaySession(account: Account): boolean {
  return account.metadata.sessionVerified === true && account.setupStatus === "COMPLETED";
}

function eligibilityForWorkspaceWePlay(account: Account | undefined, suspended: boolean): {
  eligible: boolean;
  ineligibleReason: string | null;
} {
  if (suspended) {
    return { eligible: false, ineligibleReason: "Workspace user is suspended" };
  }
  if (!account) {
    return { eligible: true, ineligibleReason: null };
  }
  if (account.status === "DISABLED") {
    return { eligible: false, ineligibleReason: "WePlay account is disabled" };
  }
  if (account.status === "SETUP_IN_PROGRESS" || account.status === "CREATING" || account.status === "PROCESSING") {
    return { eligible: false, ineligibleReason: `WePlay setup already ${account.status}` };
  }
  if (account.status === "ACTION_REQUIRED" || account.status === "NEEDS_REAUTH") {
    return { eligible: true, ineligibleReason: null };
  }
  if (hasVerifiedWePlaySession(account) || account.status === "READY" || account.status === "SUCCESS") {
    return { eligible: false, ineligibleReason: "WePlay session already verified" };
  }
  if (account.status === "SETUP_REQUIRED" || account.status === "FAILED") {
    return { eligible: true, ineligibleReason: null };
  }
  return { eligible: false, ineligibleReason: `WePlay status is ${account.status}` };
}

export class AccountService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly jobs: JobRepository,
    private readonly workers: WorkerRepository,
    private readonly logs: LogService,
    private readonly bus: EventBus,
    private readonly directory: GoogleDirectoryClient
  ) {}

  list() {
    return this.accounts.list();
  }

  async get(id: string): Promise<Account> {
    const account = await this.accounts.getById(id);
    if (!account) {
      throw new HttpError(404, "Account not found");
    }
    return account;
  }

  async listWorkspaceCandidates(): Promise<WorkspaceWePlayCandidate[]> {
    if (!this.directory.configured) {
      throw new HttpError(400, "Google Workspace Admin SDK credentials are not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    const [directoryUsers, accounts] = await Promise.all([this.directory.listUsers(), this.accounts.list()]);
    const byEmail = new Map(accounts.map((account) => [workspaceEmailFrom(account), account]));
    return directoryUsers
      .map((user) => {
        const email = user.primaryEmail.toLowerCase();
        const account = byEmail.get(email);
        const firstName = user.givenName?.trim() ?? "";
        const lastName = user.familyName?.trim() ?? "";
        const displayName = `${firstName} ${lastName}`.trim() || email.split("@")[0] || email;
        const suspended = Boolean(user.suspended);
        const eligibility = eligibilityForWorkspaceWePlay(account, suspended);
        return {
          googleUserId: user.id,
          email,
          firstName,
          lastName,
          displayName,
          loginProvider: "GOOGLE" as const,
          workspaceStatus: suspended ? ("SUSPENDED" as const) : ("ACTIVE" as const),
          weplayAccountId: account?.id ?? null,
          weplayStatus: account?.status ?? null,
          weplaySetupStatus: account?.setupStatus ?? null,
          eligible: eligibility.eligible,
          ineligibleReason: eligibility.ineligibleReason,
          lastErrorMessage: account?.lastErrorMessage ?? null
        };
      })
      .sort((left, right) => left.email.localeCompare(right.email));
  }

  async startWorkspaceWePlaySetup(input: {
    emails: string[];
    workerId?: string | null;
  }): Promise<{ started: Account[]; skipped: Array<{ email: string; reason: string }> }> {
    if (!this.directory.configured) {
      throw new HttpError(400, "Google Workspace Admin SDK credentials are not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    if (input.workerId) {
      const worker = await this.workers.getById(input.workerId);
      if (!worker) {
        throw new HttpError(400, "Assigned worker not found", "WORKER_OFFLINE");
      }
    }
    const uniqueEmails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    const started: Account[] = [];
    const skipped: Array<{ email: string; reason: string }> = [];

    for (const email of uniqueEmails) {
      const directoryUser = await this.directory.getUser(email);
      if (!directoryUser) {
        skipped.push({ email, reason: "User does not exist in this Google Workspace organization" });
        continue;
      }
      const eligibility = eligibilityForWorkspaceWePlay(
        await this.accounts.findByWorkspaceEmail(email),
        Boolean(directoryUser.suspended)
      );
      if (!eligibility.eligible) {
        skipped.push({ email, reason: eligibility.ineligibleReason ?? "Not eligible" });
        continue;
      }

      let account = await this.accounts.findByWorkspaceEmail(email);
      const firstName = directoryUser.givenName?.trim() ?? "";
      const lastName = directoryUser.familyName?.trim() ?? "";
      const displayName = `${firstName} ${lastName}`.trim() || email.split("@")[0] || email;
      if (!account) {
        const ts = now();
        account = {
          id: createId(),
          displayName,
          loginProvider: "GOOGLE",
          status: "SETUP_REQUIRED",
          setupStatus: "REQUIRED",
          workerId: input.workerId ?? null,
          enabled: true,
          createdAt: ts,
          updatedAt: ts,
          lastUsedAt: null,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          metadata: {
            origin: "workspace",
            provider: "GOOGLE",
            workspaceEmail: email,
            workspaceUserId: directoryUser.id,
            weplayName: displayName,
            setupProgress: "Linked from Google Workspace; setup not started"
          }
        };
        await this.accounts.insert(account);
        await this.logs.record({
          accountId: account.id,
          jobId: null,
          workerId: account.workerId,
          runId: null,
          event: "ACCOUNT_CREATED",
          status: account.status,
          error: null,
          message: `WePlay account linked to Workspace user ${email}`
        });
      } else {
        account.displayName = displayName;
        account.loginProvider = "GOOGLE";
        account.metadata = {
          ...account.metadata,
          origin: account.metadata.origin ?? "workspace",
          provider: "GOOGLE",
          workspaceEmail: email,
          workspaceUserId: directoryUser.id,
          weplayName: displayName
        };
        if (input.workerId && !account.workerId) {
          account.workerId = input.workerId;
        }
        account.updatedAt = now();
        await this.accounts.update(account);
      }

      const prepared = await this.startSetup(account.id);
      started.push(prepared);
    }

    this.bus.publish("changed", { source: "account" });
    return { started, skipped };
  }

  async create(input: { displayName: string; loginProvider: LoginProvider; workerId?: string | null }): Promise<Account> {
    if (input.workerId) {
      const worker = await this.workers.getById(input.workerId);
      if (!worker) {
        throw new HttpError(400, "Assigned worker not found", "WORKER_OFFLINE");
      }
    }
    const ts = now();
    const account: Account = {
      id: createId(),
      displayName: input.displayName,
      loginProvider: input.loginProvider,
      status: "SETUP_REQUIRED",
      setupStatus: "REQUIRED",
      workerId: input.workerId ?? null,
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
      lastUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: { origin: "add", setupProgress: "Registered; setup not started" }
    };
    await this.accounts.insert(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_CREATED",
      status: account.status,
      error: null,
      message: `Account ${account.displayName} created`
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async startWePlayCreation(input: {
    loginProvider: LoginProvider;
    workerId?: string | null;
  }): Promise<Account> {
    if (input.workerId) {
      const worker = await this.workers.getById(input.workerId);
      if (!worker) {
        throw new HttpError(400, "Assigned worker not found", "WORKER_OFFLINE");
      }
    }
    const ts = now();
    const account: Account = {
      id: createId(),
      displayName: "Creating…",
      loginProvider: input.loginProvider,
      status: "CREATING",
      setupStatus: "NOT_STARTED",
      workerId: input.workerId ?? null,
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
      lastUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: { origin: "weplay_create", creationProgress: "Queued" }
    };
    await this.accounts.insert(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_CREATION_STARTED",
      status: account.status,
      error: null,
      message: `WePlay account creation started (${account.loginProvider})`
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async retryWePlayCreation(id: string): Promise<Account> {
    const account = await this.get(id);
    if (account.status !== "CREATION_FAILED" && account.status !== "CREATING") {
      throw new HttpError(409, "Account is not waiting for WePlay creation");
    }
    if (account.status === "CREATION_FAILED") {
      assertAccountTransition(account.status, "CREATING");
      account.status = "CREATING";
    }
    account.setupStatus = "NOT_STARTED";
    account.lastErrorCode = null;
    account.lastErrorMessage = null;
    account.metadata = { ...account.metadata, origin: "weplay_create", creationProgress: "Retry queued" };
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_CREATION_STARTED",
      status: account.status,
      error: null,
      message: "WePlay account creation retry"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async updateMetadata(
    id: string,
    patch: { displayName?: string; loginProvider?: LoginProvider; workerId?: string | null }
  ): Promise<Account> {
    const account = await this.get(id);
    if (patch.displayName !== undefined) {
      account.displayName = patch.displayName;
    }
    if (patch.loginProvider !== undefined) {
      account.loginProvider = patch.loginProvider;
    }
    if (patch.workerId !== undefined) {
      if (patch.workerId) {
        const worker = await this.workers.getById(patch.workerId);
        if (!worker) {
          throw new HttpError(400, "Assigned worker not found", "WORKER_OFFLINE");
        }
      }
      account.workerId = patch.workerId;
    }
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_UPDATED",
      status: account.status,
      error: null,
      message: "Account metadata updated"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async setEnabled(id: string, enabled: boolean): Promise<Account> {
    const account = await this.get(id);
    account.enabled = enabled;
    if (!enabled) {
      assertAccountTransition(account.status, "DISABLED");
      account.status = "DISABLED";
      await this.jobs.cancelQueuedForAccount(account.id, now());
    } else if (account.status === "DISABLED") {
      const next =
        account.setupStatus === "COMPLETED"
          ? "READY"
          : account.setupStatus === "ACTION_REQUIRED"
            ? "ACTION_REQUIRED"
            : account.metadata.origin === "weplay_create" && account.setupStatus === "NOT_STARTED"
              ? "CREATION_FAILED"
              : "SETUP_REQUIRED";
      assertAccountTransition(account.status, next);
      account.status = next;
    }
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: enabled ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED",
      status: account.status,
      error: null,
      message: enabled ? "Account enabled" : "Account disabled"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async remove(id: string): Promise<void> {
    const account = await this.get(id);
    const runningDeviceFarm = await this.jobs.list({
      accountId: id,
      kind: "devicefarm_provision",
      status: "RUNNING",
      limit: 1
    });
    if (runningDeviceFarm.length > 0) {
      throw new HttpError(
        409,
        "Wait for the Device Farm worker to finish before removing this account",
        "DEVICEFARM_IN_PROGRESS"
      );
    }
    await this.jobs.cancelQueuedForAccount(account.id, now());
    await this.accounts.delete(id);
    await this.logs.record({
      accountId: id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_DELETED",
      status: account.status,
      error: null,
      message: "Account removed"
    });
    this.bus.publish("changed", { source: "account" });
  }

  async importIdentities(input: {
    identities: Array<{
      displayName: string;
      loginProvider: OauthLoginProvider;
      workerId?: string | null;
      email?: string;
      handle?: string;
    }>;
  }): Promise<Account[]> {
    const workerIds = [...new Set(input.identities.map((row) => row.workerId).filter(Boolean))] as string[];
    for (const workerId of workerIds) {
      const worker = await this.workers.getById(workerId);
      if (!worker) {
        throw new HttpError(400, "Assigned worker not found", "WORKER_OFFLINE");
      }
    }
    const created: Account[] = [];
    for (const identity of input.identities) {
      const ts = now();
      const email = String(identity.email ?? "").trim().toLowerCase();
      const handle = String(identity.handle ?? "").trim().replace(/^@/, "");
      const metadata: Account["metadata"] = {
        origin: "import",
        provider: identity.loginProvider,
        setupProgress: "Imported; start Device Farm to create or sign in to WePlay"
      };
      if (email.includes("@")) {
        metadata.identityEmail = email;
        if (identity.loginProvider === "GOOGLE") {
          metadata.workspaceEmail = email;
        }
      } else if (email) {
        metadata.identityHandle = email;
      }
      if (handle) {
        metadata.identityHandle = handle;
      }
      const account: Account = {
        id: createId(),
        displayName: identity.displayName,
        loginProvider: identity.loginProvider,
        status: "SETUP_REQUIRED",
        setupStatus: "REQUIRED",
        workerId: identity.workerId ?? null,
        enabled: true,
        createdAt: ts,
        updatedAt: ts,
        lastUsedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        metadata
      };
      await this.accounts.insert(account);
      await this.logs.record({
        accountId: account.id,
        jobId: null,
        workerId: account.workerId,
        runId: null,
        event: "ACCOUNT_IMPORTED",
        status: account.status,
        error: null,
        message: `Imported ${account.displayName} (${account.loginProvider})`
      });
      created.push(account);
    }
    this.bus.publish("changed", { source: "account" });
    return created;
  }

  async startSetup(id: string): Promise<Account> {
    const account = await this.get(id);
    if (account.status === "ACTION_REQUIRED") {
      throw new HttpError(409, "Use Resume Setup after completing provider verification on the device");
    }
    if (account.setupStatus === "COMPLETED" && (account.status === "READY" || hasVerifiedWePlaySession(account))) {
      throw new HttpError(409, "Account already set up; use re-authenticate if the session is invalid");
    }
    assertAccountTransition(account.status, "SETUP_IN_PROGRESS");
    account.status = "SETUP_IN_PROGRESS";
    account.setupStatus = "IN_PROGRESS";
    account.lastErrorCode = null;
    account.lastErrorMessage = null;
    account.metadata = {
      ...account.metadata,
      provider: account.loginProvider,
      setupProgress: "Setup queued"
    };
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_SETUP_STARTED",
      status: account.status,
      error: null,
      message: "Setup started"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async resumeSetup(id: string): Promise<Account> {
    const account = await this.get(id);
    if (account.status !== "ACTION_REQUIRED") {
      throw new HttpError(409, "Account is not waiting for operator action");
    }
    assertAccountTransition(account.status, "SETUP_IN_PROGRESS");
    account.status = "SETUP_IN_PROGRESS";
    account.setupStatus = "IN_PROGRESS";
    account.lastErrorCode = null;
    account.lastErrorMessage = null;
    account.metadata = {
      ...account.metadata,
      setupProgress: "Resume queued after manual provider verification"
    };
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_SETUP_RESUMED",
      status: account.status,
      error: null,
      message: "Setup resumed after operator completed provider verification on device"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async confirmSetup(id: string): Promise<Account> {
    const account = await this.get(id);
    assertAccountTransition(account.status, "READY");
    account.status = "READY";
    account.setupStatus = "COMPLETED";
    account.lastErrorCode = null;
    account.lastErrorMessage = null;
    account.metadata = {
      ...account.metadata,
      setupProgress: "Operator confirmed setup",
      setupVerifiedBy: "operator"
    };
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.jobs.cancelQueuedForAccount(account.id, now());
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_SETUP_COMPLETED",
      status: account.status,
      error: null,
      message: "Setup confirmed"
    });
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_READY",
      status: account.status,
      error: null,
      message: "Account ready"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  async startReauth(id: string): Promise<Account> {
    const account = await this.get(id);
    assertAccountTransition(account.status, "SETUP_IN_PROGRESS");
    account.status = "SETUP_IN_PROGRESS";
    account.setupStatus = "IN_PROGRESS";
    account.updatedAt = now();
    await this.accounts.update(account);
    await this.logs.record({
      accountId: account.id,
      jobId: null,
      workerId: account.workerId,
      runId: null,
      event: "ACCOUNT_SETUP_STARTED",
      status: account.status,
      error: null,
      message: "Re-authentication started"
    });
    this.bus.publish("changed", { source: "account" });
    return account;
  }

  isEligible(account: Account): boolean {
    return isAccountEligibleForSupport(account);
  }

  async save(account: Account): Promise<void> {
    account.updatedAt = now();
    await this.accounts.update(account);
    this.bus.publish("changed", { source: "account" });
  }
}
