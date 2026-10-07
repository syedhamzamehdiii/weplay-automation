import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockWorker } from "../helpers/mockWorker.js";

describe("five-account integration", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("runs the production path for five generic accounts", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const accountIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers,
        payload: { displayName: `Account ${i + 1}`, loginProvider: "GOOGLE" }
      });
      const account = created.json() as Account;
      await app.inject({ method: "POST", url: `/api/accounts/${account.id}/setup/complete`, headers });
      accountIds.push(account.id);
    }

    const workerA = new MockWorker(app, "worker-a", "serial-a");
    const workerB = new MockWorker(app, "worker-b", "serial-b");
    await workerA.register();
    await workerB.register();

    for (let i = 0; i < accountIds.length; i += 1) {
      const workerId = i < 3 ? workerA.workerId : workerB.workerId;
      await app.inject({
        method: "PATCH",
        url: `/api/accounts/${accountIds[i]}`,
        headers,
        payload: { workerId }
      });
    }

    const run = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers,
        payload: {
          name: "five-account-run",
          configuration: {
            roomId: "ROOM-100",
            supportTarget: "support-user",
            accountIds,
            durationMs: 60_000,
            intervalMs: 0
          }
        }
      })
    ).json() as { id: string };

    await app.inject({ method: "POST", url: "/api/controller/start", headers });
    await app.inject({ method: "POST", url: `/api/runs/${run.id}/start`, headers });
    await app.ctx.controller.tick();

    const processed = (await workerA.drainSuccess(10)) + (await workerB.drainSuccess(10));
    expect(processed).toBe(5);

    const jobs = (await app.inject({ method: "GET", url: `/api/jobs?runId=${run.id}`, headers })).json() as Job[];
    const succeeded = jobs.filter((job) => job.status === "SUCCEEDED");
    expect(succeeded).toHaveLength(5);
    expect(succeeded.every((job) => job.configuration.kind === "join_room")).toBe(true);
  });
});
