import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, DashboardStats, Job } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockWorker } from "../helpers/mockWorker.js";

interface Fixture {
  identities: Array<{ displayName: string; loginProvider: "GOOGLE" | "FACEBOOK" | "X" }>;
}

const fixture = JSON.parse(
  readFileSync(path.resolve("tests/fixtures/provisioning-identities.json"), "utf8")
) as Fixture;

/** Identities that pause for a provider security screen on the first setup pass. Labels only — no secrets. */
const MANUAL_VERIFICATION = new Set([
  "google-owned-3",
  "google-owned-4",
  "facebook-owned-2",
  "facebook-owned-3",
  "x-owned-2",
  "x-owned-3"
]);

function byProvider(accounts: Account[]) {
  return {
    GOOGLE: accounts.filter((row) => row.loginProvider === "GOOGLE"),
    FACEBOOK: accounts.filter((row) => row.loginProvider === "FACEBOOK"),
    X: accounts.filter((row) => row.loginProvider === "X")
  };
}

describe("10-account OAuth provisioning", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("imports operator-supplied identities without secrets and without hard-coding the count in the API", async () => {
    expect(fixture.identities).toHaveLength(10);
    expect(fixture.identities.filter((row) => row.loginProvider === "GOOGLE")).toHaveLength(4);
    expect(fixture.identities.filter((row) => row.loginProvider === "FACEBOOK")).toHaveLength(3);
    expect(fixture.identities.filter((row) => row.loginProvider === "X")).toHaveLength(3);

    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);

    const rejectedPhone = await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: { identities: [{ displayName: "phone-1", loginProvider: "PHONE" }] }
    });
    expect(rejectedPhone.statusCode).toBe(400);

    const rejectedSecret = await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: {
        identities: [{ displayName: "google-owned-1", loginProvider: "GOOGLE", password: "secret" }]
      }
    });
    expect(rejectedSecret.statusCode).toBe(400);

    const imported = await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: { identities: fixture.identities, startSetup: true }
    });
    expect(imported.statusCode).toBe(200);
    const accounts = (imported.json() as { accounts: Account[] }).accounts;
    expect(accounts).toHaveLength(fixture.identities.length);
    expect(accounts.every((row) => row.status === "SETUP_IN_PROGRESS")).toBe(true);
    expect(accounts.every((row) => row.metadata.origin === "import")).toBe(true);
    expect(JSON.stringify(imported.json())).not.toMatch(/password|otp|captcha/i);

    const jobs = (await app.inject({ method: "GET", url: "/api/jobs", headers })).json() as Job[];
    expect(jobs).toHaveLength(fixture.identities.length);
    expect(jobs.every((job) => job.configuration.kind === "setup")).toBe(true);
    expect(jobs.every((job) => job.configuration.resume === false)).toBe(true);
  });

  it("runs the full setup lifecycle, pauses on provider verification, and marks READY only after verified session", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers } = await login(app);
    await app.inject({
      method: "POST",
      url: "/api/accounts/import",
      headers,
      payload: { identities: fixture.identities, startSetup: true }
    });

    const mock = new MockWorker(app, "device-provision", "serial-provision");
    await mock.register();

    const unverified = await mock.claim();
    expect(unverified).not.toBeNull();
    await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${unverified!.id}/start`,
      headers: mock.auth(),
      payload: { executionId: unverified!.executionId }
    });
    const fakeComplete = await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${unverified!.id}/complete`,
      headers: mock.auth(),
      payload: { executionId: unverified!.executionId, verified: false }
    });
    expect(fakeComplete.statusCode).toBe(400);
    const notReady = (await app.inject({ method: "GET", url: `/api/accounts/${unverified!.accountId}`, headers })).json() as Account;
    expect(notReady.status).not.toBe("READY");
    await app.inject({
      method: "POST",
      url: `/api/workers/jobs/${unverified!.id}/complete`,
      headers: mock.auth(),
      payload: { executionId: unverified!.executionId, verified: true }
    });
    const verifiedAfter = (await app.inject({ method: "GET", url: `/api/accounts/${unverified!.accountId}`, headers })).json() as Account;
    expect(verifiedAfter.status).toBe("READY");
    expect(verifiedAfter.metadata.setupVerifiedBy).toBe("worker");

    const actionRequired: string[] = [];
    const readyFirstPass: string[] = [];

    for (let i = 0; i < 20; i += 1) {
      const job = await mock.claim();
      if (!job) {
        break;
      }
      const account = (await app.inject({ method: "GET", url: `/api/accounts/${job.accountId}`, headers })).json() as Account;
      if (MANUAL_VERIFICATION.has(account.displayName) && job.configuration.resume !== true) {
        await mock.fail(
          job,
          "VERIFICATION_REQUIRED",
          `${account.loginProvider} account picker / security check requires the operator on device`
        );
        actionRequired.push(account.displayName);
      } else {
        await mock.succeed(job);
        readyFirstPass.push(account.displayName);
      }
    }

    const afterFirst = ((await app.inject({ method: "GET", url: "/api/accounts", headers })).json() as Account[]).sort(
      (a, b) => a.displayName.localeCompare(b.displayName)
    );
    const grouped = byProvider(afterFirst);
    expect(grouped.GOOGLE).toHaveLength(4);
    expect(grouped.FACEBOOK).toHaveLength(3);
    expect(grouped.X).toHaveLength(3);

    const paused = afterFirst.filter((row) => row.status === "ACTION_REQUIRED");
    expect(paused.map((row) => row.displayName).sort()).toEqual([...MANUAL_VERIFICATION].sort());
    expect(paused.every((row) => row.setupStatus === "ACTION_REQUIRED")).toBe(true);
    expect(paused.every((row) => row.workerId === mock.workerId)).toBe(true);

    const stats = (await app.inject({ method: "GET", url: "/api/dashboard/stats", headers })).json() as DashboardStats;
    expect(stats.actionRequiredAccounts).toBe(MANUAL_VERIFICATION.size);
    expect(stats.readyAccounts).toBe(afterFirst.length - MANUAL_VERIFICATION.size);

    for (const account of paused) {
      const resumed = await app.inject({
        method: "POST",
        url: `/api/accounts/${account.id}/setup/resume`,
        headers
      });
      expect(resumed.statusCode).toBe(200);
      expect((resumed.json() as Account).status).toBe("SETUP_IN_PROGRESS");
    }

    for (let i = 0; i < 20; i += 1) {
      const job = await mock.claim();
      if (!job) {
        break;
      }
      expect(job.configuration.resume).toBe(true);
      await mock.succeed(job);
    }

    const finalAccounts = (await app.inject({ method: "GET", url: "/api/accounts", headers })).json() as Account[];
    expect(finalAccounts.every((row) => row.status === "READY")).toBe(true);
    expect(finalAccounts.every((row) => row.setupStatus === "COMPLETED")).toBe(true);
    expect(finalAccounts.every((row) => row.metadata.setupVerifiedBy === "worker")).toBe(true);

    const googleReady = finalAccounts.filter((row) => row.loginProvider === "GOOGLE" && row.status === "READY");
    const facebookReady = finalAccounts.filter((row) => row.loginProvider === "FACEBOOK" && row.status === "READY");
    const xReady = finalAccounts.filter((row) => row.loginProvider === "X" && row.status === "READY");
    expect(googleReady).toHaveLength(4);
    expect(facebookReady).toHaveLength(3);
    expect(xReady).toHaveLength(3);

    const history = await app.inject({
      method: "GET",
      url: `/api/accounts/${paused[0]!.id}/history`,
      headers
    });
    const events = (history.json() as { logs: Array<{ event: string }> }).logs.map((row) => row.event);
    expect(events).toContain("ACCOUNT_ACTION_REQUIRED");
    expect(events).toContain("ACCOUNT_SETUP_RESUMED");
    expect(events).toContain("ACCOUNT_READY");
  });
});
