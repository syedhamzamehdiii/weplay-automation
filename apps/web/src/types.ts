export type AccountStatus =
  | "NEW"
  | "CREATING"
  | "CREATION_FAILED"
  | "SETUP_REQUIRED"
  | "SETUP_IN_PROGRESS"
  | "ACTION_REQUIRED"
  | "READY"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "NEEDS_REAUTH"
  | "DISABLED"
  | "OFFLINE";

export interface Account {
  id: string;
  displayName: string;
  loginProvider: string;
  status: AccountStatus;
  setupStatus: string;
  workerId: string | null;
  enabled: boolean;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  metadata?: Record<string, unknown>;
}

export interface Worker {
  id: string;
  name: string;
  deviceIdentifier: string;
  status: string;
  workerVersion: string;
  lastHeartbeat: number | null;
  currentJobId: string | null;
}

export interface Job {
  id: string;
  accountId: string | null;
  workerId: string | null;
  runId: string | null;
  status: string;
  configuration: { kind: string; roomId?: string; supportTarget?: string };
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface Run {
  id: string;
  name: string;
  status: string;
  configuration: {
    kind?: "join_room" | "support";
    roomId: string;
    supportTarget: string;
    accountIds: string[];
    durationMs: number;
    intervalMs: number;
  };
  startedAt: number | null;
  endsAt: number | null;
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
  controllerStatus: string;
}

export interface EventLog {
  id: string;
  timestamp: number;
  accountId: string | null;
  jobId: string | null;
  workerId: string | null;
  event: string;
  status: string | null;
  error: string | null;
  message: string | null;
}

export interface AppSettings {
  controllerStatus: string;
  maxJobRetries: number;
  heartbeatTimeoutMs: number;
  defaultIntervalMs: number;
  allowedDurationsMs: number[];
  jobStaleMs: number;
  controllerTickMs: number;
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
  provisioningStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}
