import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job, Run, Worker } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockWorker } from "../helpers/mockWorker.js";

describe("jobs, queue, retries, workers", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("creates a run, enqueues jobs, and records verified success only", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers,
        payload: { displayName: "A1", loginProvider: "GOOGLE" }
      })
    ).json() as Account;
    await app.inject({ method: "POST", url: `/api/accounts/${account.id}/setup/complete`, headers });

    const mock = new MockWorker(app, "device-a", "serial-a");
    await mock.register();
    await app.inject({
      method: "PATCH",
      url: `/api/accounts/${account.id}`,
      headers,
      payload: { workerId: mock.workerId }
    });

    const runRes = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers,
      payload: {
        name: "support-1",
        configuration: {
          roomId: "ROOM1",
          supportTarget: "target-1",
          accountIds: [account.id],
          durationMs: 60_000,
          intervalMs: 0
        }
      }
    });
    expect(runRes.statusCode).toBe(200);
    const run = runRes.json() as Run;
    await app.inject({ method: "POST", url: "/api/controller/start", headers });
    await app.inject({ method: "POST", url: `/api/runs/${run.id}/start`, headers });
    await app.ctx.controller.tick();

    const queued = await app.inject({ method: "GET", url: "/api/jobs?status=QUEUED", headers });
    expect((queued.json() as Job[]).length).toBeGreaterThan(0);

    const unverifiedClaim = await mock.claim();
    expect(unverifiedClaim).not.toBeNull();
    await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${unverifiedClaim!.id}/start`,
      headers: mock.auth(),
      payload: { executionId: unverifiedClaim!.executionId }
    });
    const fakeSuccess = await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${unverifiedClaim!.id}/complete`,
      headers: mock.auth(),
      payload: { executionId: unverifiedClaim!.executionId, verified: false }
    });
    expect(fakeSuccess.statusCode).toBe(400);

    await mock.fail(unverifiedClaim!, "NETWORK_ERROR", "timeout talking to app");
  });

  it("retries retryable failures and does not retry auth failures", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers,
        payload: { displayName: "A1", loginProvider: "GOOGLE" }
      })
    ).json() as Account;
    await app.inject({ method: "POST", url: `/api/accounts/${account.id}/setup/complete`, headers });
    const mock = new MockWorker(app, "device-a", "serial-a");
    await mock.register();
    await app.inject({
      method: "PATCH",
      url: `/api/accounts/${account.id}`,
      headers,
      payload: { workerId: mock.workerId }
    });
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "support", roomId: "R", supportTarget: "T" }
    });
    const job = await mock.claim();
    expect(job).not.toBeNull();
    await mock.fail(job!, "NETWORK_ERROR", "net");
    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs.some((row) => row.status === "QUEUED" && row.attemptCount === 1)).toBe(true);

    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "support", roomId: "R", supportTarget: "T" }
    });
    const authJob = await mock.claim();
    await mock.fail(authJob!, "AUTH_REQUIRED", "logged out");
    const updated = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(updated.status).toBe("NEEDS_REAUTH");
  });

  it("heartbeats keep a worker online and disconnect marks it offline", async () => {
    const { app, db } = await createTestApp({ HEARTBEAT_TIMEOUT_MS: "50" });
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const mock = new MockWorker(app, "device-a", "serial-a");
    await mock.register();
    await mock.heartbeat();
    const worker = (await app.inject({ method: "GET", url: `/api/workers/me`, headers: mock.auth() })).json() as Worker;
    expect(worker.status).toBe("IDLE");

    worker.lastHeartbeat = Date.now() - 10_000;
    await app.ctx.workers.save(worker);
    await app.ctx.controller.tick();
    const { headers } = await login(app);
    const listed = (await app.inject({ method: "GET", url: "/api/workers", headers })).json() as Worker[];
    expect(listed[0]?.status).toBe("OFFLINE");
  });

  it("rejects stale execution ids (idempotency)", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers,
        payload: { displayName: "A1", loginProvider: "GOOGLE" }
      })
    ).json() as Account;
    await app.inject({ method: "POST", url: `/api/accounts/${account.id}/setup/complete`, headers });
    const mock = new MockWorker(app, "device-a", "serial-a");
    await mock.register();
    await app.inject({
      method: "PATCH",
      url: `/api/accounts/${account.id}`,
      headers,
      payload: { workerId: mock.workerId }
    });
    const job = await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "support", roomId: "R", supportTarget: "T" }
    });
    const claimed = await mock.claim();
    const response = await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${claimed!.id}/complete`,
      headers: mock.auth(),
      payload: { executionId: "not-the-execution", verified: true }
    });
    expect(response.statusCode).toBe(409);
    expect(job.executionId).toBe(claimed!.executionId);
  });

  it("validates run configuration", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers,
      payload: {
        name: "bad",
        configuration: {
          roomId: "",
          supportTarget: "t",
          accountIds: ["x"],
          durationMs: 12,
          intervalMs: 0
        }
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("creates a join-room run without a support target", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers,
        payload: { displayName: "A1", loginProvider: "GOOGLE" }
      })
    ).json() as Account;
    await app.inject({ method: "POST", url: `/api/accounts/${account.id}/setup/complete`, headers });

    const emptyAccounts = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers,
      payload: {
        name: "join",
        configuration: {
          roomId: "N518546",
          accountIds: [],
          durationMs: 60_000,
          intervalMs: 0
        }
      }
    });
    expect(emptyAccounts.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers,
      payload: {
        name: "join",
        configuration: {
          roomId: "N518546",
          accountIds: [account.id],
          durationMs: 60_000,
          intervalMs: 0
        }
      }
    });
    expect(response.statusCode).toBe(200);
    const run = response.json() as Run;
    expect(run.configuration.kind).toBe("join_room");
    expect(run.configuration.roomId).toBe("N518546");
  });
});
