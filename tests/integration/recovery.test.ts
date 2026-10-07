import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockWorker } from "../helpers/mockWorker.js";

describe("controller recovery", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("fails running jobs whose worker has disappeared", async () => {
    const { app, db } = await createTestApp({ HEARTBEAT_TIMEOUT_MS: "50", JOB_STALE_MS: "50" });
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
    const claimed = await mock.claim();
    await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${claimed!.id}/start`,
      headers: mock.auth(),
      payload: { executionId: claimed!.executionId }
    });

    const worker = await app.ctx.workers.get(mock.workerId);
    worker.lastHeartbeat = Date.now() - 10_000;
    worker.status = "BUSY";
    await app.ctx.workers.save(worker);

    await app.ctx.controller.recover();
    const job = (await app.inject({ method: "GET", url: `/api/jobs/${claimed!.id}`, headers })).json() as Job;
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("WORKER_OFFLINE");
  });
});
