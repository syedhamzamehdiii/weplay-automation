import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockWorker } from "../helpers/mockWorker.js";

describe("WePlay account creation", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("rejects Create WePlay Accounts without Workspace emails", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts/weplay-create",
      headers,
      payload: { loginProvider: "GOOGLE" }
    });
    expect(created.statusCode).toBe(400);
  });

  it("legacy create_account still requires worker verification", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = await app.ctx.accounts.startWePlayCreation({ loginProvider: "FACEBOOK" });
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "create_account", loginProvider: account.loginProvider }
    });
    const mock = new MockWorker(app, "device-create", "serial-create");
    await mock.register();
    const job = await mock.claim();
    expect(job?.configuration.kind).toBe("create_account");
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
    const latest = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(latest.status).toBe("CREATING");
  });

  it("moves verified creation into the existing setup lifecycle", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = await app.ctx.accounts.startWePlayCreation({ loginProvider: "X" });
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "create_account", loginProvider: "X" }
    });
    const mock = new MockWorker(app, "device-create", "serial-create");
    await mock.register();
    const createJob = await mock.claim();
    expect(createJob?.configuration.kind).toBe("create_account");
    await mock.succeed(createJob!);

    const afterCreate = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(afterCreate.status).toBe("SETUP_IN_PROGRESS");
    expect(afterCreate.setupStatus).toBe("IN_PROGRESS");
    expect(afterCreate.workerId).toBe(mock.workerId);

    const setupJob = await mock.claim();
    expect(setupJob?.configuration.kind).toBe("setup");
    await mock.succeed(setupJob!);
    const ready = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(ready.status).toBe("READY");
    expect(ready.setupStatus).toBe("COMPLETED");
    expect(ready.metadata.sessionVerified).toBe(true);
  });

  it("records CREATION_FAILED on terminal signup errors and allows retry", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = await app.ctx.accounts.startWePlayCreation({ loginProvider: "PHONE" });
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "create_account", loginProvider: "PHONE" }
    });
    const mock = new MockWorker(app, "device-create", "serial-create");
    await mock.register();
    const job = await mock.claim();
    await mock.fail(job!, "ACCOUNT_ALREADY_EXISTS", "session already on device");
    const failed = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(failed.status).toBe("CREATION_FAILED");
    expect(failed.lastErrorCode).toBe("ACCOUNT_ALREADY_EXISTS");

    const retried = await app.inject({
      method: "POST",
      url: `/api/accounts/${account.id}/create/retry`,
      headers
    });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as Account).status).toBe("CREATING");
  });

  it("retries network failures during creation without leaving CREATING", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const account = await app.ctx.accounts.startWePlayCreation({ loginProvider: "GOOGLE" });
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "create_account", loginProvider: "GOOGLE" }
    });
    const mock = new MockWorker(app, "device-create", "serial-create");
    await mock.register();
    const job = await mock.claim();
    await mock.fail(job!, "NETWORK_ERROR", "timeout");
    const latest = (await app.inject({ method: "GET", url: `/api/accounts/${account.id}`, headers })).json() as Account;
    expect(latest.status).toBe("CREATING");
    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs.some((row) => row.status === "QUEUED" && row.configuration.kind === "create_account")).toBe(true);
  });

  it("keeps Add account on the existing SETUP_REQUIRED path", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers,
      payload: { displayName: "Existing user", loginProvider: "GOOGLE" }
    });
    expect((created.json() as Account).status).toBe("SETUP_REQUIRED");
  });
});
