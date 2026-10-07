import {
  DeviceFarmNotConfiguredError,
  type DeviceFarmProvisionInput,
  type DeviceFarmProvisionOutcome,
  type DeviceFarmScheduledRun,
  type DeviceFarmWorkerClient,
  type DeviceFarmWorkerResult
} from "./client.js";

export function createUnconfiguredDeviceFarmClient(): DeviceFarmWorkerClient {
  return {
    configured: false,
    async scheduleProvision(): Promise<DeviceFarmScheduledRun> {
      throw new DeviceFarmNotConfiguredError();
    },
    async waitForRun(): Promise<DeviceFarmProvisionOutcome> {
      throw new DeviceFarmNotConfiguredError();
    }
  };
}

export class MockDeviceFarmClient implements DeviceFarmWorkerClient {
  configured = true;
  scheduleCalls: Array<{
    workspaceEmail: string;
    workspaceEmails?: string[];
    playStoreEmail: string;
    runName: string;
    passwordLength: number;
    devicePin: string;
  }> = [];
  waitCalls: string[] = [];
  nextRunArn = "arn:aws:devicefarm:us-west-2:0:run:mock";
  nextOutcome: DeviceFarmProvisionOutcome = {
    runArn: "arn:aws:devicefarm:us-west-2:0:run:mock",
    jobArn: "arn:aws:devicefarm:us-west-2:0:job:mock",
    deviceArn: "arn:aws:devicefarm:us-west-2::device:pixel-8a",
    deviceName: "Google Pixel 8a",
    result: "PASSED",
    status: "COMPLETED",
    worker: {
      ok: true,
      workspaceEmail: "hamza@example.com",
      weplayUserId: "100200300",
      screen: "weplay_room",
      activity: "com.wepie.wespy.module.voiceroom.main.BaseVoiceRoomActivity",
      weplayInstalled: true,
      googleAccountPresent: true,
      playStoreAccountMatchesExpected: true,
      playStoreIdentityOk: true,
      playStoreChannel: "workspace",
      playStoreAccount: "ha***@example.com",
      joinedRoom: true,
      error: null,
      errorMessage: null
    }
  };

  failWith(worker: DeviceFarmWorkerResult, result = "FAILED"): void {
    this.nextOutcome = {
      ...this.nextOutcome,
      result,
      status: "COMPLETED",
      worker
    };
  }

  async scheduleProvision(input: DeviceFarmProvisionInput): Promise<DeviceFarmScheduledRun> {
    this.scheduleCalls.push({
      workspaceEmail: input.workspaceEmail,
      workspaceEmails: input.workspaceEmails,
      playStoreEmail: input.playStoreEmail,
      runName: input.runName,
      passwordLength: input.workspacePassword.length,
      devicePin: input.devicePin
    });
    return { runArn: this.nextRunArn };
  }

  async waitForRun(
    runArn: string,
    _timeoutMs?: number,
    onProgress?: (update: import("./client.js").DeviceFarmRunProgress) => Promise<void> | void
  ): Promise<DeviceFarmProvisionOutcome> {
    this.waitCalls.push(runArn);
    if (onProgress) {
      await onProgress({
        status: "RUNNING",
        deviceArn: this.nextOutcome.deviceArn,
        deviceName: this.nextOutcome.deviceName
      });
    }
    return { ...this.nextOutcome, runArn };
  }
}
