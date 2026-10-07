import { afterEach, describe, expect, it } from "vitest";
import type { Account, DeviceFarmConnectionStatus, DeviceFarmProvisioning, Job } from "@weplay/types";
import { MockDeviceFarmClient } from "../../apps/api/src/devicefarm/mockClient.js";
import { createTestApp, login } from "../helpers/app.js";
import { MockGoogleDirectory } from "../helpers/mockDirectory.js";

const DEVICE_FARM_ENV = {
  DEVICEFARM_PROJECT_ARN: "arn:aws:devicefarm:us-west-2:0:project:test",
  DEVICEFARM_DEVICE_POOL_ARN: "arn:aws:devicefarm:us-west-2:0:devicepool:test",
  DEVICEFARM_APP_ARN: "arn:aws:devicefarm:us-west-2:0:upload:app",
  DEVICEFARM_JOB_TIMEOUT_MINUTES: "15",
  WEPLAY_GAME_CODE: "ROOMTEST1",
  WEPLAY_WORKSPACE_PASSWORD: "WorkspaceTestPass1!",
  AWS_ACCESS_KEY_ID: "test-devicefarm-key-id",
  AWS_SECRET_ACCESS_KEY: "test-devicefarm-key"
};

describe("Device Farm single-worker WePlay provisioning", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  async function setup(deviceFarm = new MockDeviceFarmClient()) {
    const directory = new MockGoogleDirectory();
    directory.seed("hamza@example.com", "google-hamza", { givenName: "Hamza", familyName: "Ahmed" });
    directory.seed("arjun@example.com", "google-arjun", { givenName: "Arjun", familyName: "Khan" });
    const created = await createTestApp(DEVICE_FARM_ENV, { directoryClient: directory, deviceFarmClient: deviceFarm });
    cleanup.push(async () => {
      await created.app.close();
      await created.db.close();
    });
    const { headers } = await login(created.app);
    return { ...created, headers, directory, deviceFarm };
  }

  it("reports Device Farm connection status without exposing credentials", async () => {
    const { app, headers } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/devicefarm/status", headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as DeviceFarmConnectionStatus;
    expect(body.configured).toBe(true);
    expect(body.credentialsAvailable).toBe(true);
    expect(body.credentialsSource).toBe("environment");
    expect(body.envStaticKeyPairSet).toBe(true);
    expect(body.region).toBe("us-west-2");
    expect(body.availability).toBe("Active");
    expect(body.inFlight).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/test-devicefarm-key/);
    expect(JSON.stringify(body)).not.toMatch(/password|BEGIN PRIVATE/i);
  });

  it("starts one Device Farm worker for a selected Workspace account and does not queue a USB setup job", async () => {
    const { app, headers, directory, deviceFarm } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { account: Account; provisioning: DeviceFarmProvisioning; job: Job };
    expect(body.account.metadata.workspaceEmail).toBe("hamza@example.com");
    expect(body.account.status).toBe("SETUP_IN_PROGRESS");
    expect(body.job.configuration.kind).toBe("devicefarm_provision");
    expect(body.provisioning.provisioningStatus).toBe("PENDING");
    expect(directory.insertCalls).toEqual([]);

    await app.ctx.controller.tick();

    const ready = (await app.inject({ method: "GET", url: `/api/accounts/${body.account.id}`, headers })).json() as Account;
    expect(ready.status).toBe("READY");
    expect(ready.setupStatus).toBe("COMPLETED");
    expect(ready.metadata.sessionVerified).toBe(true);
    expect(ready.metadata.setupVerifiedBy).toBe("devicefarm_worker");
    expect(ready.metadata.weplayUserId).toBe("100200300");
    expect(ready.metadata.joinedRoom).toBe(true);
    expect(ready.metadata.deviceName).toBe("Google Pixel 8a");
    expect(ready.workerId).toBeNull();

    const mapping = (
      await app.inject({ method: "GET", url: `/api/accounts/${body.account.id}/devicefarm`, headers })
    ).json() as { provisioning: DeviceFarmProvisioning };
    expect(mapping.provisioning.provisioningStatus).toBe("SUCCEEDED");
    expect(mapping.provisioning.workspaceEmail).toBe("hamza@example.com");
    expect(mapping.provisioning.deviceName).toBe("Google Pixel 8a");
    expect(mapping.provisioning.deviceFarmRunArn).toContain("run:");

    expect(deviceFarm.scheduleCalls).toHaveLength(1);
    expect(deviceFarm.scheduleCalls[0]?.workspaceEmail).toBe("hamza@example.com");
    expect(deviceFarm.scheduleCalls[0]?.playStoreEmail).toBe("admin@example.com");
    expect(deviceFarm.scheduleCalls[0]?.passwordLength).toBe("WorkspaceTestPass1!".length);
    expect(directory.setPasswordCalls.length).toBeGreaterThanOrEqual(2);
    expect(directory.setPasswordCalls.every((call) => call.changePasswordAtNextLogin === false)).toBe(true);
    expect(directory.setPasswordCalls.every((call) => call.passwordLength === "WorkspaceTestPass1!".length)).toBe(true);

    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs.some((job) => job.configuration.kind === "setup")).toBe(false);
    expect(jobs.some((job) => job.configuration.kind === "devicefarm_provision" && job.status === "SUCCEEDED")).toBe(true);
  });

  it("rejects a second concurrent Device Farm worker while one Pixel is in flight", async () => {
    const { app, headers } = await setup();
    const first = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "arjun@example.com" }
    });
    expect(second.statusCode).toBe(409);
  });

  it("does not mark READY when the Device Farm worker reports ACTION_REQUIRED", async () => {
    const deviceFarm = new MockDeviceFarmClient();
    deviceFarm.failWith({
      ok: false,
      workspaceEmail: "hamza@example.com",
      error: "ACTION_REQUIRED",
      errorMessage: "Google presented a security challenge (captcha)",
      weplayInstalled: true,
      googleAccountPresent: true,
      screen: null,
      activity: null,
      weplayUserId: null
    });
    const { app, headers } = await setup(deviceFarm);
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const accountId = (created.json() as { account: Account }).account.id;
    await app.ctx.controller.tick();
    const account = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers })).json() as Account;
    expect(account.status).toBe("ACTION_REQUIRED");
    expect(account.metadata.sessionVerified).not.toBe(true);
  });

  it("starts Device Farm without WEPLAY_GAME_CODE", async () => {
    const directory = new MockGoogleDirectory();
    directory.seed("hamza@example.com", "google-hamza", { givenName: "Hamza", familyName: "Ahmed" });
    const created = await createTestApp(
      { ...DEVICE_FARM_ENV, WEPLAY_GAME_CODE: "" },
      { directoryClient: directory, deviceFarmClient: new MockDeviceFarmClient() }
    );
    cleanup.push(async () => {
      await created.app.close();
      await created.db.close();
    });
    const { headers } = await login(created.app);
    const response = await created.app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not mark READY when WePlay user id is missing", async () => {
    const deviceFarm = new MockDeviceFarmClient();
    deviceFarm.nextOutcome = {
      ...deviceFarm.nextOutcome,
      result: "PASSED",
      worker: {
        ok: true,
        workspaceEmail: "hamza@example.com",
        weplayInstalled: true,
        googleAccountPresent: true,
        playStoreAccountMatchesExpected: true,
        weplayUserId: null,
        joinedRoom: true,
        screen: "weplay_main",
        activity: "com.wepie.wespy.module.main.MainActivity",
        error: null,
        errorMessage: null
      }
    };
    const { app, headers } = await setup(deviceFarm);
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const accountId = (created.json() as { account: Account }).account.id;
    await app.ctx.controller.tick();
    const account = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers })).json() as Account;
    expect(account.status).not.toBe("READY");
    expect(account.metadata.sessionVerified).not.toBe(true);
  });

  it("does not mark READY when Play Store is not on the Workspace account", async () => {
    const deviceFarm = new MockDeviceFarmClient();
    deviceFarm.nextOutcome = {
      ...deviceFarm.nextOutcome,
      result: "PASSED",
      worker: {
        ok: true,
        workspaceEmail: "hamza@example.com",
        weplayInstalled: true,
        googleAccountPresent: true,
        playStoreAccountMatchesExpected: false,
        playStoreIdentityOk: false,
        playStoreAccount: "work-***@android-for-work.gserviceaccount.com",
        weplayUserId: "100200300",
        joinedRoom: true,
        screen: "weplay_room",
        activity: "BaseVoiceRoomActivity",
        error: null,
        errorMessage: null
      }
    };
    const { app, headers } = await setup(deviceFarm);
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const accountId = (created.json() as { account: Account }).account.id;
    await app.ctx.controller.tick();
    const account = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers })).json() as Account;
    expect(account.status).not.toBe("READY");
    expect(account.metadata.sessionVerified).not.toBe(true);
  });

  it("marks READY when Play Store is Device Farm managed Play and WePlay session is verified", async () => {
    const deviceFarm = new MockDeviceFarmClient();
    deviceFarm.nextOutcome = {
      ...deviceFarm.nextOutcome,
      result: "PASSED",
      worker: {
        ok: true,
        workspaceEmail: "hamza@example.com",
        weplayInstalled: true,
        googleAccountPresent: true,
        playStoreAccountMatchesExpected: false,
        playStoreIdentityOk: true,
        playStoreChannel: "devicefarm_managed_play",
        playStoreAccount: "work-***@android-for-work.gserviceaccount.com",
        weplayUserId: "100200300",
        joinedRoom: false,
        screen: "weplay_main",
        activity: "com.wepie.wespy.module.main.MainActivity",
        error: null,
        errorMessage: null
      }
    };
    const { app, headers } = await setup(deviceFarm);
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const accountId = (created.json() as { account: Account }).account.id;
    await app.ctx.controller.tick();
    const account = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers })).json() as Account;
    expect(account.status).toBe("READY");
    expect(account.metadata.sessionVerified).toBe(true);
    expect(account.metadata.playStoreChannel).toBe("devicefarm_managed_play");
  });

  it("does not mark READY when game-code join is not confirmed", async () => {
    const deviceFarm = new MockDeviceFarmClient();
    deviceFarm.nextOutcome = {
      ...deviceFarm.nextOutcome,
      result: "PASSED",
      worker: {
        ok: true,
        workspaceEmail: "hamza@example.com",
        weplayInstalled: true,
        googleAccountPresent: true,
        playStoreAccountMatchesExpected: true,
        weplayUserId: "100200300",
        joinedRoom: false,
        gameCodeSet: true,
        screen: "weplay_main",
        activity: "com.wepie.wespy.module.main.MainActivity",
        error: null,
        errorMessage: null
      }
    };
    const { app, headers } = await setup(deviceFarm);
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const accountId = (created.json() as { account: Account }).account.id;
    await app.ctx.controller.tick();
    const account = (await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers })).json() as Account;
    expect(account.status).not.toBe("READY");
    expect(account.metadata.sessionVerified).not.toBe(true);
  });

  it("does not create Workspace Directory users from Device Farm start", async () => {
    const { app, headers, directory } = await setup();
    await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    expect(directory.insertCalls).toEqual([]);
  });

  it("weplay-create starts one Pixel Device Farm run for every eligible Workspace email", async () => {
    const { app, headers } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { emails: ["hamza@example.com", "arjun@example.com"] }
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { started: Account[]; skipped: Array<{ email: string; reason: string }> };
    expect(body.started).toHaveLength(2);
    expect(body.started.map((row) => row.metadata.workspaceEmail).sort()).toEqual([
      "arjun@example.com",
      "hamza@example.com"
    ]);
    expect(body.skipped).toEqual([]);
    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    const farmJob = jobs.find((job) => job.configuration.kind === "devicefarm_provision");
    expect(farmJob).toBeTruthy();
    expect(farmJob?.configuration.workspaceEmails).toEqual(["hamza@example.com", "arjun@example.com"]);
    expect(jobs.some((job) => job.configuration.kind === "setup")).toBe(false);
  });

  it("creates both selected Workspace accounts in one Device Farm Pixel run", async () => {
    const { app, headers, deviceFarm } = await setup();
    deviceFarm.nextOutcome = {
      ...deviceFarm.nextOutcome,
      worker: {
        ...deviceFarm.nextOutcome.worker!,
        ok: true,
        weplayInstalled: true,
        playStoreIdentityOk: true,
        accounts: [
          {
            workspaceEmail: "hamza@example.com",
            ok: true,
            weplayUserId: "100200300",
            googleAccountPresent: true,
            screen: "weplay_main"
          },
          {
            workspaceEmail: "arjun@example.com",
            ok: true,
            weplayUserId: "100200301",
            googleAccountPresent: true,
            screen: "weplay_main"
          }
        ]
      }
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { emails: ["hamza@example.com", "arjun@example.com"] }
    });
    expect(created.statusCode).toBe(200);
    await app.ctx.controller.tick();
    const accounts = (await app.inject({ method: "GET", url: "/api/accounts", headers })).json() as Account[];
    expect(accounts.filter((row) => row.status === "READY")).toHaveLength(2);
    expect(deviceFarm.scheduleCalls).toHaveLength(1);
    expect(deviceFarm.scheduleCalls[0]?.workspaceEmails).toEqual(["hamza@example.com", "arjun@example.com"]);
  });

  it("cancels a queued USB setup job and starts Device Farm for the same Workspace account", async () => {
    const { app, headers } = await setup();
    const imported = await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: {
        startSetup: false,
        identities: [{ displayName: "Hamza Ahmed", loginProvider: "GOOGLE", email: "hamza@example.com" }]
      }
    });
    expect(imported.statusCode).toBe(200);
    const accountId = (imported.json() as { accounts: Account[] }).accounts[0]!.id;
    await app.ctx.accounts.startSetup(accountId);
    await app.ctx.jobs.create({
      accountId,
      runId: null,
      configuration: { kind: "setup", loginProvider: "GOOGLE", resume: false }
    });
    const historyBefore = (
      await app.inject({ method: "GET", url: `/api/accounts/${accountId}/history`, headers })
    ).json() as { jobs: Job[] };
    expect(historyBefore.jobs.some((job) => job.configuration.kind === "setup" && job.status === "QUEUED")).toBe(true);

    const started = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as { job: Job }).job.configuration.kind).toBe("devicefarm_provision");
    const historyAfter = (
      await app.inject({ method: "GET", url: `/api/accounts/${accountId}/history`, headers })
    ).json() as { jobs: Job[] };
    expect(historyAfter.jobs.some((job) => job.configuration.kind === "setup" && job.status === "QUEUED")).toBe(false);
    expect(historyAfter.jobs.some((job) => job.configuration.kind === "setup" && job.status === "CANCELLED")).toBe(true);
  });

  it("deletes an account that has Device Farm provisioning history", async () => {
    const { app, headers } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const accountId = (created.json() as { account: Account }).account.id;
    await app.ctx.controller.tick();
    const removed = await app.inject({ method: "DELETE", url: `/api/accounts/${accountId}`, headers });
    expect(removed.statusCode).toBe(200);
    const missing = await app.inject({ method: "GET", url: `/api/accounts/${accountId}`, headers });
    expect(missing.statusCode).toBe(404);
  });

  it("resumes waiting on a Device Farm run after API restart", async () => {
    const { app, headers, db, deviceFarm } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/devicefarm/provision",
      headers,
      payload: { email: "hamza@example.com" }
    });
    const body = created.json() as { account: Account; provisioning: DeviceFarmProvisioning; job: Job };
    const runArn = "arn:aws:devicefarm:us-west-2:0:run:resumed";
    const ts = Date.now();
    await db.execute(
      `UPDATE devicefarm_provisionings
       SET provisioning_status = 'RUNNING', devicefarm_run_arn = ?, started_at = ?, updated_at = ?
       WHERE id = ?`,
      [runArn, ts, ts, body.provisioning.id]
    );
    await db.execute(
      "UPDATE jobs SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?",
      [ts, ts, body.job.id]
    );

    await app.ctx.deviceFarm.recover();

    expect(deviceFarm.scheduleCalls).toHaveLength(0);
    expect(deviceFarm.waitCalls).toEqual([runArn]);
    const ready = (await app.inject({ method: "GET", url: `/api/accounts/${body.account.id}`, headers })).json() as Account;
    expect(ready.status).toBe("READY");
    expect(ready.metadata.sessionVerified).toBe(true);
  });
});
