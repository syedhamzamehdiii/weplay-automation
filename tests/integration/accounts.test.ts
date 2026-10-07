import { afterEach, describe, expect, it } from "vitest";
import type { Account, Job } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";

describe("accounts", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("creates an account in SETUP_REQUIRED", async () => {
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
      payload: { displayName: "Acc 1", loginProvider: "GOOGLE" }
    });
    expect(created.statusCode).toBe(200);
    const account = created.json() as Account;
    expect(account.status).toBe("SETUP_REQUIRED");
    expect(account.setupStatus).toBe("REQUIRED");
  });

  it("accepts setup start and complete with an empty JSON body", async () => {
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
      payload: { displayName: "Acc 1", loginProvider: "GOOGLE" }
    });
    const id = (created.json() as Account).id;
    const started = await app.inject({
      method: "POST",
      url: `/api/accounts/${id}/setup/start`,
      headers: { ...headers, "content-type": "application/json" }
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as Account).status).toBe("SETUP_IN_PROGRESS");
    const completed = await app.inject({
      method: "POST",
      url: `/api/accounts/${id}/setup/complete`,
      headers: { ...headers, "content-type": "application/json" }
    });
    expect(completed.statusCode).toBe(200);
    expect((completed.json() as Account).status).toBe("READY");
  });

  it("transitions setup and confirm to READY", async () => {
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
      payload: { displayName: "Acc 1", loginProvider: "GOOGLE" }
    });
    const id = (created.json() as Account).id;
    const started = await app.inject({ method: "POST", url: `/api/accounts/${id}/setup/start`, headers });
    expect((started.json() as Account).status).toBe("SETUP_IN_PROGRESS");
    const completed = await app.inject({ method: "POST", url: `/api/accounts/${id}/setup/complete`, headers });
    expect((completed.json() as Account).status).toBe("READY");
    expect((completed.json() as Account).setupStatus).toBe("COMPLETED");
  });

  it("disable and enable persist", async () => {
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
      payload: { displayName: "Acc 1", loginProvider: "PHONE" }
    });
    const id = (created.json() as Account).id;
    await app.inject({ method: "POST", url: `/api/accounts/${id}/setup/complete`, headers });
    const disabled = await app.inject({ method: "POST", url: `/api/accounts/${id}/disable`, headers });
    expect((disabled.json() as Account).status).toBe("DISABLED");
    const enabled = await app.inject({ method: "POST", url: `/api/accounts/${id}/enable`, headers });
    expect((enabled.json() as Account).status).toBe("READY");
  });

  it("imports Google, Facebook, and X identities and queues provider setup", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: {
        startSetup: true,
        identities: [
          { displayName: "Google user", loginProvider: "GOOGLE" },
          { displayName: "Facebook user", loginProvider: "FACEBOOK" },
          { displayName: "X user", loginProvider: "X" }
        ]
      }
    });
    expect(imported.statusCode).toBe(200);
    const accounts = (imported.json() as { accounts: Account[] }).accounts;
    expect(accounts.map((row) => row.loginProvider).sort()).toEqual(["FACEBOOK", "GOOGLE", "X"]);
    expect(accounts.every((row) => row.status === "SETUP_IN_PROGRESS")).toBe(true);
    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job.configuration.loginProvider).sort()).toEqual(["FACEBOOK", "GOOGLE", "X"]);
    expect(jobs.every((job) => job.configuration.kind === "setup")).toBe(true);
  });

  it("imports identities without queuing USB setup by default", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const imported = await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: {
        identities: [
          { displayName: "Google user", loginProvider: "GOOGLE", email: "hamza@example.com" },
          { displayName: "Facebook user", loginProvider: "FACEBOOK", email: "fb.user@example.com" },
          { displayName: "X user", loginProvider: "X", handle: "@weplayx" }
        ]
      }
    });
    expect(imported.statusCode).toBe(200);
    const accounts = (imported.json() as { accounts: Account[] }).accounts;
    expect(accounts).toHaveLength(3);
    expect(accounts.every((row) => row.status === "SETUP_REQUIRED")).toBe(true);
    const google = accounts.find((row) => row.loginProvider === "GOOGLE")!;
    expect(google.metadata.identityEmail).toBe("hamza@example.com");
    expect(google.metadata.workspaceEmail).toBe("hamza@example.com");
    expect(accounts.find((row) => row.loginProvider === "FACEBOOK")?.metadata.identityEmail).toBe("fb.user@example.com");
    expect(accounts.find((row) => row.loginProvider === "X")?.metadata.identityHandle).toBe("weplayx");
    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs).toHaveLength(0);
  });

  it("validates login provider", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers,
      payload: { displayName: "x", loginProvider: "OTHER" }
    });
    expect(response.statusCode).toBe(400);
  });
});
