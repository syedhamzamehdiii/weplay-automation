export const ACCOUNT_STATUSES = [
  "NEW",
  "CREATING",
  "CREATION_FAILED",
  "SETUP_REQUIRED",
  "SETUP_IN_PROGRESS",
  "ACTION_REQUIRED",
  "READY",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "NEEDS_REAUTH",
  "DISABLED",
  "OFFLINE"
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const SETUP_STATUSES = ["NOT_STARTED", "REQUIRED", "IN_PROGRESS", "ACTION_REQUIRED", "COMPLETED"] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

export const LOGIN_PROVIDERS = ["GOOGLE", "FACEBOOK", "X", "PHONE"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

/** WePlay OAuth providers that can be imported without phone/OTP. */
export const OAUTH_LOGIN_PROVIDERS = ["GOOGLE", "FACEBOOK", "X"] as const;
export type OauthLoginProvider = (typeof OAUTH_LOGIN_PROVIDERS)[number];

export const WORKER_STATUSES = ["OFFLINE", "STARTING", "IDLE", "BUSY", "ERROR", "STOPPING"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const JOB_STATUSES = [
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "RETRYING"
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const RUN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "STOPPED", "COMPLETED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CONTROLLER_STATUSES = ["STOPPED", "PAUSED", "RUNNING"] as const;
export type ControllerStatus = (typeof CONTROLLER_STATUSES)[number];

export const JOB_KINDS = [
  "create_account",
  "setup",
  "join_room",
  "support",
  "reauth",
  "workspace_provision",
  "devicefarm_provision",
  "devicefarm_join"
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const WORKSPACE_USER_STATUSES = [
  "PENDING",
  "VALIDATING",
  "CREATING",
  "CREATED",
  "ALREADY_EXISTS",
  "FAILED",
  "RETRYING"
] as const;
export type WorkspaceUserStatus = (typeof WORKSPACE_USER_STATUSES)[number];

export const WORKSPACE_BATCH_STATUSES = [
  "DRAFT",
  "VALIDATING",
  "READY",
  "RUNNING",
  "PAUSED",
  "CANCELLED",
  "COMPLETED"
] as const;
export type WorkspaceBatchStatus = (typeof WORKSPACE_BATCH_STATUSES)[number];

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "SETUP_REQUIRED",
  "WORKER_OFFLINE",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ROOM_NOT_FOUND",
  "TARGET_NOT_FOUND",
  "SUPPORT_FAILED",
  "APP_CRASHED",
  "INVALID_CONFIGURATION",
  "UNKNOWN_STATE",
  "AUTOMATION_NOT_INSPECTED",
  "NEEDS_REAUTH",
  "MAX_RETRIES_EXCEEDED",
  "CANCELLED",
  "WORKER_ERROR",
  "SIGNUP_FAILED",
  "UNEXPECTED_SCREEN",
  "PERMISSION_REQUIRED",
  "VERIFICATION_REQUIRED",
  "ACCOUNT_ALREADY_EXISTS",
  "RATE_LIMITED",
  "WORKSPACE_NOT_CONFIGURED",
  "WORKSPACE_USER_INVALID",
  "WORKSPACE_DUPLICATE_USERNAME",
  "WORKSPACE_LICENSE_EXHAUSTED",
  "WORKSPACE_QUOTA_EXCEEDED",
  "DEVICEFARM_NOT_CONFIGURED",
  "DEVICEFARM_RUN_FAILED",
  "PLAY_STORE_INSTALL_FAILED",
  "GOOGLE_ACCOUNT_ADD_FAILED"
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const LOG_EVENTS = [
  "ACCOUNT_CREATED",
  "ACCOUNT_CREATION_STARTED",
  "ACCOUNT_CREATION_PROGRESS",
  "ACCOUNT_CREATION_SUCCEEDED",
  "ACCOUNT_CREATION_FAILED",
  "ACCOUNT_UPDATED",
  "ACCOUNT_DELETED",
  "ACCOUNT_ENABLED",
  "ACCOUNT_DISABLED",
  "ACCOUNT_IMPORTED",
  "ACCOUNT_SETUP_STARTED",
  "ACCOUNT_SETUP_PROGRESS",
  "ACCOUNT_ACTION_REQUIRED",
  "ACCOUNT_SETUP_RESUMED",
  "ACCOUNT_SETUP_COMPLETED",
  "ACCOUNT_READY",
  "ACCOUNT_NEEDS_REAUTH",
  "JOB_CREATED",
  "JOB_ASSIGNED",
  "JOB_STARTED",
  "JOB_PROGRESS",
  "ROOM_OPENED",
  "SUPPORT_STARTED",
  "SUPPORT_SUCCEEDED",
  "SUPPORT_FAILED",
  "JOB_COMPLETED",
  "JOB_FAILED",
  "JOB_RETRYING",
  "JOB_CANCELLED",
  "WORKER_CONNECTED",
  "WORKER_DISCONNECTED",
  "WORKER_HEARTBEAT",
  "WORKER_ERROR",
  "RUN_CREATED",
  "RUN_STARTED",
  "RUN_PAUSED",
  "RUN_RESUMED",
  "RUN_STOPPED",
  "RUN_COMPLETED",
  "CONTROLLER_STARTED",
  "CONTROLLER_PAUSED",
  "CONTROLLER_RESUMED",
  "CONTROLLER_STOPPED",
  "RECOVERY_COMPLETED",
  "PROVISIONING_IMPORT_STARTED",
  "PROVISIONING_VALIDATION_COMPLETED",
  "USER_CREATE_STARTED",
  "USER_CREATED",
  "USER_ALREADY_EXISTS",
  "USER_CREATE_FAILED",
  "PROVISIONING_COMPLETED",
  "DEVICEFARM_PROVISION_STARTED",
  "DEVICEFARM_PROVISION_PROGRESS",
  "DEVICEFARM_PROVISION_SUCCEEDED",
  "DEVICEFARM_PROVISION_FAILED"
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export interface JobConfiguration {
  kind: JobKind;
  roomId?: string;
  supportTarget?: string;
  loginProvider?: LoginProvider;
  resume?: boolean;
  durationMs?: number;
  intervalMs?: number;
  workspaceUserId?: string;
  workspaceBatchId?: string;
  workspaceEmail?: string;
  workspaceEmails?: string[];
  deviceFarmProvisioningId?: string;
  deviceFarmProvisioningIds?: string[];
  deviceFarmJoinJobIds?: string[];
}

export interface RunConfiguration {
  kind: "join_room" | "support";
  roomId: string;
  supportTarget: string;
  accountIds: string[];
  durationMs: number;
  intervalMs: number;
}

export interface Account {
  id: string;
  displayName: string;
  loginProvider: LoginProvider;
  status: AccountStatus;
  setupStatus: SetupStatus;
  workerId: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorCode: ErrorCode | null;
  lastErrorMessage: string | null;
  metadata: Record<string, unknown>;
}

export interface Worker {
  id: string;
  name: string;
  deviceIdentifier: string;
  platform: "ANDROID";
  status: WorkerStatus;
  workerVersion: string;
  lastHeartbeat: number | null;
  currentJobId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Job {
  id: string;
  accountId: string | null;
  workerId: string | null;
  runId: string | null;
  executionId: string;
  configuration: JobConfiguration;
  status: JobStatus;
  attemptCount: number;
  createdAt: number;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  updatedAt: number;
}

export interface WorkspaceUserProvisioning {
  id: string;
  batchId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  requestedUsername: string;
  fullEmail: string;
  status: WorkspaceUserStatus;
  googleUserId: string | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkspaceProvisioningBatch {
  id: string;
  name: string;
  domain: string;
  status: WorkspaceBatchStatus;
  requestedCount: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface WorkspaceProvisioningStats {
  requested: number;
  valid: number;
  creating: number;
  created: number;
  alreadyExists: number;
  failed: number;
  remaining: number;
  retrying: number;
}

export interface WorkspaceConnectionStatus {
  configured: boolean;
  domain: string | null;
  adminEmailConfigured: boolean;
  credentialsConfigured: boolean;
  scope: string;
  concurrency: number;
  maxRetries: number;
  warning: string;
}

export interface WorkspaceUsage {
  totalUsers: number | null;
  remainingLicenses: number | null;
  remainingUnavailableReason: string | null;
}

export const DEVICEFARM_PROVISIONING_STATUSES = [
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "ACTION_REQUIRED"
] as const;
export type DeviceFarmProvisioningStatus = (typeof DEVICEFARM_PROVISIONING_STATUSES)[number];

export interface DeviceFarmProvisioning {
  id: string;
  accountId: string;
  workspaceUserId: string;
  workspaceEmail: string;
  deviceFarmRunArn: string | null;
  deviceFarmJobArn: string | null;
  deviceArn: string | null;
  deviceName: string | null;
  weplayUserId: string | null;
  provisioningStatus: DeviceFarmProvisioningStatus;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface DeviceFarmConnectionStatus {
  configured: boolean;
  region: string;
  projectConfigured: boolean;
  devicePoolConfigured: boolean;
  appConfigured: boolean;
  credentialsAvailable: boolean;
  credentialsSource: "environment" | "shared-ini" | "none";
  envAccessKeyIdSet: boolean;
  envStaticKeyPairSet: boolean;
  envProfileSet: boolean;
  sharedCredentialsFilePresent: boolean;
  singleWorkerOnly: true;
  warning: string;
  inFlight: number;
  availability: "Inactive" | "Active" | "Running";
}

export interface WorkspaceWePlayCandidate {
  googleUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  loginProvider: "GOOGLE";
  workspaceStatus: "ACTIVE" | "SUSPENDED";
  weplayAccountId: string | null;
  weplayStatus: AccountStatus | null;
  weplaySetupStatus: SetupStatus | null;
  eligible: boolean;
  ineligibleReason: string | null;
  lastErrorMessage: string | null;
}

export interface Run {
  id: string;
  name: string;
  configuration: RunConfiguration;
  status: RunStatus;
  startedAt: number | null;
  endsAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EventLog {
  id: string;
  timestamp: number;
  accountId: string | null;
  jobId: string | null;
  workerId: string | null;
  runId: string | null;
  event: LogEvent | string;
  status: string | null;
  error: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
}

export interface AppSettings {
  controllerStatus: ControllerStatus;
  maxJobRetries: number;
  heartbeatTimeoutMs: number;
  defaultIntervalMs: number;
  allowedDurationsMs: number[];
  jobStaleMs: number;
  controllerTickMs: number;
}

export interface DashboardStats {
  totalAccounts: number;
  readyAccounts: number;
  setupRequiredAccounts: number;
  needsReauthAccounts: number;
  processingAccounts: number;
  successfulAccounts: number;
  failedAccounts: number;
  creatingAccounts: number;
  creationFailedAccounts: number;
  actionRequiredAccounts: number;
  onlineWorkers: number;
  offlineWorkers: number;
  queuedJobs: number;
  runningJobs: number;
  completedJobs: number;
  controllerStatus: ControllerStatus;
}

export interface Operator {
  id: string;
  username: string;
  role: "admin";
  createdAt: number;
}
