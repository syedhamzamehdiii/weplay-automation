export interface DeviceFarmProvisionInput {
  workspaceEmail: string;
  workspaceEmails?: string[];
  workspacePassword: string;
  playStoreEmail: string;
  devicePin: string;
  runName: string;
  gameCode: string;
  runMode?: string;
  supportTarget?: string;
  jobTimeoutMinutes?: number;
}

export interface DeviceFarmScheduledRun {
  runArn: string;
}

export interface DeviceFarmAccountResult {
  workspaceEmail?: string;
  ok?: boolean;
  weplayUserId?: string | null;
  googleAccountPresent?: boolean;
  screen?: string | null;
  activity?: string | null;
  error?: string | null;
  errorMessage?: string | null;
  joinedRoom?: boolean;
  supportClicked?: boolean;
  durationMs?: number | null;
  joinDurationMs?: number | null;
}

export interface DeviceFarmWorkerResult {
  ok: boolean;
  workspaceEmail?: string;
  workspaceEmails?: string[];
  weplayUserId?: string | null;
  screen?: string | null;
  activity?: string | null;
  weplayInstalled?: boolean;
  googleAccountPresent?: boolean;
  playStoreAccountMatchesExpected?: boolean;
  playStoreIdentityOk?: boolean;
  playStoreChannel?: string | null;
  playStoreAccount?: string | null;
  joinedRoom?: boolean;
  supportClicked?: boolean;
  gameCodeSet?: boolean;
  runMode?: string | null;
  totalDurationMs?: number | null;
  error?: string | null;
  errorMessage?: string | null;
  accounts?: DeviceFarmAccountResult[];
}

export interface DeviceFarmProvisionOutcome {
  runArn: string;
  jobArn: string | null;
  deviceArn: string | null;
  deviceName: string | null;
  result: string;
  status: string;
  worker: DeviceFarmWorkerResult | null;
}

export interface DeviceFarmRunProgress {
  status?: string | null;
  deviceArn?: string | null;
  deviceName?: string | null;
}

export interface DeviceFarmWorkerClient {
  readonly configured: boolean;
  scheduleProvision(input: DeviceFarmProvisionInput): Promise<DeviceFarmScheduledRun>;
  waitForRun(
    runArn: string,
    timeoutMs: number,
    onProgress?: (update: DeviceFarmRunProgress) => Promise<void> | void
  ): Promise<DeviceFarmProvisionOutcome>;
}

export class DeviceFarmNotConfiguredError extends Error {
  readonly code = "DEVICEFARM_NOT_CONFIGURED";
  constructor(message = "AWS Device Farm is not configured") {
    super(message);
    this.name = "DeviceFarmNotConfiguredError";
  }
}
