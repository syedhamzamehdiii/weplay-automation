import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job, WorkspaceWePlayCandidate } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockGoogleDirectory } from "../helpers/mockDirectory.js";
import { MockWorker } from "../helpers/mockWorker.js";

describe("Workspace users to WePlay setup", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  async function setup(directory = new MockGoogleDirectory()) {
    directory.seed("hamza@example.com", "google-hamza", { givenName: "Hamza", familyName: "Ahmed" });
    directory.seed("arjun@example.com", "google-arjun", { givenName: "Arjun", familyName: "Khan" });
    directory.seed("paused@example.com", "google-paused", {
      givenName: "Paused",
      familyName: "User",
      suspended: true
    });
    const created = await createTestApp({}, { directoryClient: directory });
    cleanup.push(async () => {
      await created.app.close();
      await created.db.close();
    });
    const { headers } = await login(created.app);
    return { ...created, headers, directory };
  }

  it("lists existing Workspace users with WePlay status and does not create Directory users", async () => {
    const { app, headers, directory } = await setup();
    const response = await app.inject({ method: "GET", url: "/api/accounts/workspace-candidates", headers });
    expect(response.statusCode).toBe(200);
    const users = response.json() as WorkspaceWePlayCandidate[];
    expect(users.map((row) => row.email).sort()).toEqual(["arjun@example.com", "hamza@example.com", "paused@example.com"]);
    expect(users.find((row) => row.email === "hamza@example.com")).toMatchObject({
      displayName: "Hamza Ahmed",
      loginProvider: "GOOGLE",
      workspaceStatus: "ACTIVE",
      weplayStatus: null,
      eligible: true
    });
    expect(users.find((row) => row.email === "paused@example.com")?.eligible).toBe(false);
    expect(directory.insertCalls).toEqual([]);
  });

  it("queues Google setup jobs for selected Workspace users without Directory insert", async () => {
    const { app, headers, directory } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { emails: ["hamza@example.com", "paused@example.com", "missing@example.com"] }
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { started: Account[]; skipped: Array<{ email: string; reason: string }> };
    expect(body.started).toHaveLength(1);
    expect(body.started[0]?.loginProvider).toBe("GOOGLE");
    expect(body.started[0]?.status).toBe("SETUP_IN_PROGRESS");
    expect(body.started[0]?.metadata.workspaceEmail).toBe("hamza@example.com");
    expect(body.started[0]?.metadata.origin).toBe("workspace");
    expect(body.skipped.map((row) => row.email).sort()).toEqual(["missing@example.com", "paused@example.com"]);
    expect(directory.insertCalls).toEqual([]);

    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.configuration).toMatchObject({
      kind: "setup",
      loginProvider: "GOOGLE",
      workspaceEmail: "hamza@example.com"
    });
    expect(jobs[0]?.configuration).not.toHaveProperty("password");
  });

  it("marks READY only after the worker verifies a WePlay session", async () => {
    const { app, headers } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { emails: ["hamza@example.com"] }
    });
    const account = (created.json() as { started: Account[] }).started[0]!;
    const mock = new MockWorker(app, "device-workspace", "serial-workspace");
    await mock.register();
    const job = await mock.claim();
    expect(job?.configuration.kind).toBe("setup");
    await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job!.id}/start`,
      headers: mock.auth(),
      payload: { executionId: job!.executionId }
    });
    const fake = await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job!.id}/complete`,
      headers: mock.auth(),
      payload: { executionId: job!.executionId, verified: false }
    });
    expect(fake.statusCode).toBe(400);
    const stillOpen = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(stillOpen.status).toBe("SETUP_IN_PROGRESS");
    expect(stillOpen.metadata.sessionVerified).not.toBe(true);

    const verified = await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job!.id}/complete`,
      headers: mock.auth(),
      payload: { executionId: job!.executionId, verified: true }
    });
    expect(verified.statusCode).toBe(200);
    const ready = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(ready.status).toBe("READY");
    expect(ready.setupStatus).toBe("COMPLETED");
    expect(ready.metadata.sessionVerified).toBe(true);
    expect(ready.metadata.setupVerifiedBy).toBe("worker");
  });

  it("does not start a second setup for a verified Workspace WePlay account", async () => {
    const { app, headers } = await setup();
    const first = await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { emails: ["hamza@example.com"] }
    });
    const account = (first.json() as { started: Account[] }).started[0]!;
    const mock = new MockWorker(app, "device-workspace", "serial-workspace");
    await mock.register();
    await mock.succeed((await mock.claim())!);
    const again = await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { emails: ["hamza@example.com"] }
    });
    expect(again.statusCode).toBe(200);
    const body = again.json() as { started: Account[]; skipped: Array<{ email: string; reason: string }> };
    expect(body.started).toHaveLength(0);
    expect(body.skipped[0]?.email).toBe("hamza@example.com");
    const latest = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(latest.status).toBe("READY");
  });

  it("moves invalid sessions to NEEDS_REAUTH and re-authenticate uses the existing account", async () => {
    const { app, headers } = await setup();
    await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { emails: ["arjun@example.com"] }
    });
    const mock = new MockWorker(app, "device-reauth", "serial-reauth");
    await mock.register();
    await mock.succeed((await mock.claim())!);
    const account = ((await app.inject({ method: "GET", url: "/api/accounts", headers })).json() as Account[])[0]!;

    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "support", roomId: "room-1", supportTarget: "host" }
    });
    const job = await mock.claim();
    expect(job?.configuration.kind).toBe("support");
    await mock.fail(job!, "AUTH_REQUIRED", "WePlay session expired");
    const needsReauth = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(needsReauth.status).toBe("NEEDS_REAUTH");

    const reauth = await app.inject({ method: "POST", url: `/api/accounts/${account.id}/reauth`, headers });
    expect(reauth.statusCode).toBe(200);
    expect((reauth.json() as Account).id).toBe(account.id);
    const reauthJob = await mock.claim();
    expect(reauthJob?.configuration.kind).toBe("reauth");
    await mock.succeed(reauthJob!);
    const restored = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(restored.status).toBe("READY");
  });
});
