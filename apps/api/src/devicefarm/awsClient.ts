import { readFile } from "node:fs/promises";
import type { AppEnv } from "@weplay/config";
import {
  CreateUploadCommand,
  DeviceFarmClient,
  GetRunCommand,
  GetUploadCommand,
  ListArtifactsCommand,
  ListJobsCommand,
  ScheduleRunCommand,
  type Artifact,
  type Job as DeviceFarmJob,
  type Run
} from "@aws-sdk/client-device-farm";
import { generateDeviceFarmSpec, specContainsPlaintextSecret } from "./spec.js";
import { deviceFarmWorkerFingerprint, removeTempPath, zipDeviceFarmTestPackage } from "./packageZip.js";
import { deviceFarmConfigured, resolveDeviceFarmAppPath } from "./paths.js";
import { applyAwsEnvFromAppEnv, deviceFarmRegion, resolveAwsStaticCredentials } from "./credentials.js";
import {
  extractProvisioningResultFromZip,
  parseProvisioningResultJson
} from "./workerResult.js";
import {
  DeviceFarmNotConfiguredError,
  type DeviceFarmProvisionInput,
  type DeviceFarmProvisionOutcome,
  type DeviceFarmRunProgress,
  type DeviceFarmScheduledRun,
  type DeviceFarmWorkerClient,
  type DeviceFarmWorkerResult
} from "./client.js";
import { createUnconfiguredDeviceFarmClient } from "./mockClient.js";
import { isTransientAwsNetworkError } from "./networkError.js";

const TERMINAL_RUN = new Set(["COMPLETED", "ERRORED", "STOPPED"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientAwsRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientAwsNetworkError(error) || attempt === attempts) {
        throw error;
      }
      await sleep(5_000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Device Farm request failed");
}

export function createAwsDeviceFarmClient(env: AppEnv): DeviceFarmWorkerClient {
  applyAwsEnvFromAppEnv(env);
  const region = deviceFarmRegion(env);
  const staticCredentials = resolveAwsStaticCredentials(env);
  const client = new DeviceFarmClient(
    staticCredentials
      ? {
          region,
          credentials: {
            accessKeyId: staticCredentials.accessKeyId,
            secretAccessKey: staticCredentials.secretAccessKey,
            ...(staticCredentials.sessionToken ? { sessionToken: staticCredentials.sessionToken } : {})
          }
        }
      : { region }
  );
  let cachedTestPackageArn = "";
  let cachedTestPackageFingerprint = "";

  async function waitForUpload(arn: string): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const response = await client.send(new GetUploadCommand({ arn }));
      const upload = response.upload;
      const status = upload?.status;
      if (status === "SUCCEEDED") {
        return;
      }
      if (status === "FAILED") {
        throw new Error(upload?.message || "Device Farm upload failed");
      }
      await sleep(2_000);
    }
    throw new Error("Timed out waiting for Device Farm upload");
  }

  async function putUpload(url: string, body: Buffer, contentType: string): Promise<void> {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body)
    });
    if (!response.ok) {
      throw new Error(`Device Farm upload PUT failed (${response.status})`);
    }
  }

  async function createAndSendUpload(input: {
    name: string;
    type: "APPIUM_PYTHON_TEST_PACKAGE" | "APPIUM_PYTHON_TEST_SPEC" | "ANDROID_APP";
    body: Buffer;
    contentType: string;
  }): Promise<string> {
    const created = await client.send(
      new CreateUploadCommand({
        projectArn: env.DEVICEFARM_PROJECT_ARN.trim(),
        name: input.name,
        type: input.type
      })
    );
    const upload = created.upload;
    if (!upload?.arn || !upload.url) {
      throw new Error("Device Farm CreateUpload did not return an ARN/URL");
    }
    await putUpload(upload.url, input.body, input.contentType);
    await waitForUpload(upload.arn);
    return upload.arn;
  }

  async function ensureAppArn(): Promise<string> {
    if (env.DEVICEFARM_APP_ARN.trim()) {
      return env.DEVICEFARM_APP_ARN.trim();
    }
    const appPath = resolveDeviceFarmAppPath(env);
    if (!appPath) {
      throw new DeviceFarmNotConfiguredError("DEVICEFARM_APP_ARN or DEVICEFARM_APP_PATH is required");
    }
    const body = await readFile(appPath);
    return createAndSendUpload({
      name: "weplay-stub.apk",
      type: "ANDROID_APP",
      body,
      contentType: "application/octet-stream"
    });
  }

  async function ensureTestPackageArn(): Promise<string> {
    const fingerprint = await deviceFarmWorkerFingerprint();
    if (cachedTestPackageArn && cachedTestPackageFingerprint === fingerprint) {
      return cachedTestPackageArn;
    }
    const zipPath = await zipDeviceFarmTestPackage();
    try {
      const body = await readFile(zipPath);
      cachedTestPackageArn = await createAndSendUpload({
        name: "weplay-devicefarm-tests.zip",
        type: "APPIUM_PYTHON_TEST_PACKAGE",
        body,
        contentType: "application/zip"
      });
      cachedTestPackageFingerprint = fingerprint;
      return cachedTestPackageArn;
    } finally {
      await removeTempPath(zipPath);
    }
  }

  async function uploadSpec(input: DeviceFarmProvisionInput): Promise<string> {
    const spec = generateDeviceFarmSpec({
      workspaceEmail: input.workspaceEmail,
      workspaceEmails: input.workspaceEmails,
      workspacePassword: input.workspacePassword,
      playStoreEmail: input.playStoreEmail,
      gameCode: input.gameCode,
      runMode: input.runMode,
      supportTarget: input.supportTarget
    });
    if (specContainsPlaintextSecret(spec, input.workspacePassword)) {
      throw new Error("Refusing to upload a Device Farm spec that contains a plaintext password");
    }
    return createAndSendUpload({
      name: `weplay-provision-${Date.now()}.yml`,
      type: "APPIUM_PYTHON_TEST_SPEC",
      body: Buffer.from(spec, "utf8"),
      contentType: "application/octet-stream"
    });
  }

  async function parseWorkerResult(runArn: string): Promise<DeviceFarmWorkerResult | null> {
    const artifacts: Artifact[] = [];
    for (const type of ["FILE", "LOG"] as const) {
      let nextToken: string | undefined;
      do {
        const response = await client.send(
          new ListArtifactsCommand({ arn: runArn, type, nextToken })
        );
        artifacts.push(...(response.artifacts ?? []));
        nextToken = response.nextToken;
      } while (nextToken);
    }
    const named = artifacts.find((artifact) =>
      (artifact.name ?? "").toLowerCase().includes("provisioning-result")
    );
    const customerZip = artifacts.find((artifact) => {
      const name = (artifact.name ?? "").toLowerCase();
      const ext = (artifact.extension ?? "").toLowerCase();
      return name.includes("customer artifact") && (ext === "zip" || name.includes("zip"));
    });
    const candidates = [named, customerZip].filter(Boolean) as Artifact[];
    for (const match of candidates) {
      if (!match.url) {
        continue;
      }
      const response = await fetch(match.url);
      if (!response.ok) {
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const name = (match.name ?? "").toLowerCase();
      if (name.includes("customer artifact") || (match.extension ?? "").toLowerCase() === "zip") {
        const fromZip = await extractProvisioningResultFromZip(body);
        if (fromZip) {
          return fromZip;
        }
        continue;
      }
      const parsed = parseProvisioningResultJson(body.toString("utf8"));
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  function pickJob(jobs: DeviceFarmJob[]): DeviceFarmJob | undefined {
    return jobs[0];
  }

  return {
    configured: deviceFarmConfigured(env),
    async scheduleProvision(input: DeviceFarmProvisionInput): Promise<DeviceFarmScheduledRun> {
      if (!this.configured) {
        throw new DeviceFarmNotConfiguredError();
      }
      const [appArn, testPackageArn, testSpecArn] = await Promise.all([
        ensureAppArn(),
        ensureTestPackageArn(),
        uploadSpec(input)
      ]);
      const scheduled = await client.send(
        new ScheduleRunCommand({
          projectArn: env.DEVICEFARM_PROJECT_ARN.trim(),
          appArn,
          devicePoolArn: env.DEVICEFARM_DEVICE_POOL_ARN.trim(),
          name: input.runName.slice(0, 256),
          test: {
            type: "APPIUM_PYTHON",
            testPackageArn,
            testSpecArn
          },
          executionConfiguration: {
            jobTimeoutMinutes: input.jobTimeoutMinutes ?? env.DEVICEFARM_JOB_TIMEOUT_MINUTES,
            videoCapture: true,
            accountsCleanup: true,
            appPackagesCleanup: false
          }
        })
      );
      const runArn = scheduled.run?.arn;
      if (!runArn) {
        throw new Error("Device Farm ScheduleRun did not return a run ARN");
      }
      return { runArn };
    },
    async waitForRun(
      runArn: string,
      timeoutMs: number,
      onProgress?: (update: DeviceFarmRunProgress) => Promise<void> | void
    ): Promise<DeviceFarmProvisionOutcome> {
      const deadline = Date.now() + timeoutMs;
      let run: Run | undefined;
      while (Date.now() < deadline) {
        try {
          const response = await client.send(new GetRunCommand({ arn: runArn }));
          run = response.run;
          const jobsResponse = await client.send(new ListJobsCommand({ arn: runArn }));
          const liveJob = pickJob(jobsResponse.jobs ?? []);
          if (onProgress) {
            await onProgress({
              status: run?.status,
              deviceArn: liveJob?.device?.arn ?? null,
              deviceName: liveJob?.device?.name ?? liveJob?.name ?? null
            });
          }
          if (run?.status && TERMINAL_RUN.has(run.status)) {
            break;
          }
        } catch (error) {
          if (!isTransientAwsNetworkError(error)) {
            throw error;
          }
        }
        await sleep(15_000);
      }
      if (!run?.status || !TERMINAL_RUN.has(run.status)) {
        throw new Error("Timed out waiting for the Device Farm run to finish");
      }
      const jobsResponse = await withTransientAwsRetry(() => client.send(new ListJobsCommand({ arn: runArn })));
      const job = pickJob(jobsResponse.jobs ?? []);
      const worker = await withTransientAwsRetry(() => parseWorkerResult(runArn));
      return {
        runArn,
        jobArn: job?.arn ?? null,
        deviceArn: job?.device?.arn ?? null,
        deviceName: job?.device?.name ?? job?.name ?? null,
        result: run.result ?? run.status ?? "UNKNOWN",
        status: run.status ?? "UNKNOWN",
        worker
      };
    }
  };
}

export function createDeviceFarmClient(env: AppEnv): DeviceFarmWorkerClient {
  if (!deviceFarmConfigured(env)) {
    return createUnconfiguredDeviceFarmClient();
  }
  return createAwsDeviceFarmClient(env);
}
