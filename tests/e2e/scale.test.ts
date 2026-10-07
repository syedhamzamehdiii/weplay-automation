import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockWorker } from "../helpers/mockWorker.js";

describe("synthetic scale", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("enqueues and processes a large account set without count-specific branches", { timeout: 60_000 }, async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const count = 300;
    const accountIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
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

    const workers = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const worker = new MockWorker(app, `worker-${index}`, `serial-${index}`);
        await worker.register();
        return worker;
      })
    );

    for (let i = 0; i < accountIds.length; i += 1) {
      const worker = workers[i % workers.length]!;
      await app.inject({
        method: "PATCH",
        url: `/api/accounts/${accountIds[i]}`,
        headers,
        payload: { workerId: worker.workerId }
      });
    }

    const run = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers,
        payload: {
          name: "scale-run",
          configuration: {
            roomId: "ROOM-SCALE",
            supportTarget: "target",
            accountIds,
            durationMs: 60_000,
            intervalMs: 5_000
          }
        }
      })
    ).json() as { id: string };

    await app.inject({ method: "POST", url: "/api/controller/start", headers });
    await app.inject({ method: "POST", url: `/api/runs/${run.id}/start`, headers });
    await app.ctx.controller.tick();

    let processed = 0;
    for (const worker of workers) {
      processed += await worker.drainSuccess(count);
    }
    expect(processed).toBe(count);

    const jobs = (await app.inject({
      method: "GET",
      url: `/api/jobs?runId=${run.id}&limit=1000`,
      headers
    })).json() as Job[];
    expect(jobs.filter((job) => job.status === "SUCCEEDED")).toHaveLength(count);

    const stats = (await app.inject({ method: "GET", url: "/api/dashboard/stats", headers })).json() as {
      totalAccounts: number;
    };
    expect(stats.totalAccounts).toBe(count);
  });
});
