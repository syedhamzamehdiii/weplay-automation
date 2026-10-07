import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceProvisioningBatch, WorkspaceUserProvisioning } from "@weplay/types";
import { createTestApp, login } from "../helpers/app.js";
import { MockGoogleDirectory } from "../helpers/mockDirectory.js";

const SAMPLE_CSV = `firstName,lastName,username
Hamza,Ahmed,user001
Arjun,Khan,user002
Rafiq,Hasan,user003`;

function csvFor(count: number, prefix = "user"): string {
  const lines = ["firstName,lastName,username"];
  for (let i = 1; i <= count; i += 1) {
    const id = String(i).padStart(4, "0");
    lines.push(`Person${id},Test,${prefix}${id}`);
  }
  return lines.join("\n");
}

describe("Google Workspace user provisioning", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  async function setup(directory = new MockGoogleDirectory()) {
    const created = await createTestApp({}, { directoryClient: directory });
    cleanup.push(async () => {
      await created.app.close();
      await created.db.close();
    });
    const { headers } = await login(created.app);
    return { ...created, headers, directory };
  }

  async function importCsv(app: Awaited<ReturnType<typeof setup>>["app"], headers: Record<string, string>, csv: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspace/batches/import",
      headers,
      payload: { csv }
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      batch: WorkspaceProvisioningBatch;
      users: WorkspaceUserProvisioning[];
      stats: { requested: number; failed: number };
    };
  }

  async function runUntilIdle(
    app: Awaited<ReturnType<typeof setup>>["app"],
    headers: Record<string, string>,
    batchId: string,
    ticks = 200
  ) {
    for (let i = 0; i < ticks; i += 1) {
      await app.ctx.controller.tick();
      const current = (
        await app.inject({
          method: "GET",
          url: `/api/workspace/batches/${batchId}`,
          headers
        })
      ).json() as { batch: WorkspaceProvisioningBatch; stats: { created: number; failed: number; remaining: number } };
      if (current.batch.status === "COMPLETED" || current.batch.status === "CANCELLED") {
        return app.ctx.workspace.getBatch(batchId);
      }
    }
    return app.ctx.workspace.getBatch(batchId);
  }

  it("parses a CSV, validates, and previews emails on the configured domain", async () => {
    const { app, headers } = await setup();
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    expect(imported.stats.requested).toBe(3);
    expect(imported.users.map((user) => user.fullEmail)).toEqual([
      "user001@example.com",
      "user002@example.com",
      "user003@example.com"
    ]);
    const validated = await app.inject({
      method: "POST",
      url: `/api/workspace/batches/${imported.batch.id}/validate`,
      headers
    });
    expect(validated.statusCode).toBe(200);
    const body = validated.json() as { stats: { requested: number; remaining: number }; batch: { status: string } };
    expect(body.batch.status).toBe("READY");
    expect(body.stats.remaining).toBe(3);
  });

  it("detects duplicate usernames and invalid usernames", async () => {
    const { app, headers } = await setup();
    const imported = await importCsv(
      app,
      headers,
      `firstName,lastName,username
A,B,user001
C,D,user001
E,F,bad..name`
    );
    expect(imported.users).toHaveLength(2);
    expect(imported.users.some((user) => user.status === "FAILED" && user.requestedUsername === "bad..name")).toBe(true);
  });

  it("marks existing Workspace users ALREADY_EXISTS and does not insert them", async () => {
    const directory = new MockGoogleDirectory();
    directory.seed("user001@example.com", "gid-1");
    const { app, headers } = await setup(directory);
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/validate`, headers });
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    const result = await runUntilIdle(app, headers, imported.batch.id);
    expect(result.stats.alreadyExists).toBe(1);
    expect(result.stats.created).toBe(2);
    expect(directory.insertCalls).toEqual(["user002@example.com", "user003@example.com"]);
  });

  it("creates users through the Directory mock and stores the Google user id", async () => {
    const { app, headers, directory } = await setup();
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    const result = await runUntilIdle(app, headers, imported.batch.id);
    expect(result.stats.created).toBe(3);
    expect(result.stats.failed).toBe(0);
    expect(result.users.every((user) => user.googleUserId && user.status === "CREATED")).toBe(true);
    expect(directory.insertCalls).toHaveLength(3);
    const logs = await app.inject({ method: "GET", url: "/api/logs?limit=200", headers });
    const events = (logs.json() as Array<{ event: string }>).map((entry) => entry.event);
    expect(events).toContain("PROVISIONING_IMPORT_STARTED");
    expect(events).toContain("USER_CREATED");
    expect(events).toContain("PROVISIONING_COMPLETED");
  });

  it("records API errors and rate-limit retries without creating duplicates", async () => {
    const directory = new MockGoogleDirectory();
    directory.failNext("user001@example.com", 400, "invalid given name", 1);
    directory.rateLimitNext = 1;
    const { app, headers } = await setup(directory);
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    const result = await runUntilIdle(app, headers, imported.batch.id, 400);
    const failed = result.users.find((user) => user.fullEmail === "user001@example.com");
    expect(failed?.status).toBe("FAILED");
    expect(failed?.errorMessage).toMatch(/invalid given name/i);
    expect(result.stats.created).toBe(2);
    expect(directory.users.size).toBe(2);
  });

  it("recovers interrupted CREATING rows from persisted state instead of duplicating", async () => {
    const directory = new MockGoogleDirectory();
    const { app, headers, db } = await setup(directory);
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    await app.ctx.workspace.processDue();

    const created = imported.users[0]!;
    directory.seed(created.fullEmail, "recovered-id");
    await db.execute(
      "UPDATE workspace_user_provisionings SET status = 'CREATING', google_user_id = NULL, completed_at = NULL WHERE id = ?",
      [created.id]
    );
    await db.execute(
      "UPDATE jobs SET status = 'RUNNING' WHERE configuration LIKE ? AND status = 'SUCCEEDED'",
      [`%${created.id}%`]
    );

    await app.ctx.workspace.recover();
    const after = await app.ctx.workspace.getBatch(imported.batch.id);
    const recovered = after.users.find((user) => user.id === created.id);
    expect(recovered?.status).toBe("CREATED");
    expect(recovered?.googleUserId).toBe("recovered-id");
    expect(directory.insertCalls.filter((email) => email === created.fullEmail).length).toBeLessThanOrEqual(1);
  });

  it("is idempotent when Google already has the user after a crash", async () => {
    const directory = new MockGoogleDirectory();
    const { app, headers } = await setup(directory);
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    directory.seed("user002@example.com", "preexisting");
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    const result = await runUntilIdle(app, headers, imported.batch.id);
    const existing = result.users.find((user) => user.fullEmail === "user002@example.com");
    expect(existing?.status).toBe("ALREADY_EXISTS");
    expect(directory.insertCalls.filter((email) => email === "user002@example.com")).toHaveLength(0);
  });

  it("provisions 500 synthetic users through the mock API without a 500 special case", async () => {
    const directory = new MockGoogleDirectory();
    directory.seed("user0003@example.com", "already-3");
    const { app, db } = await createTestApp(
      { GOOGLE_WORKSPACE_PROVISION_CONCURRENCY: "20" },
      { directoryClient: directory }
    );
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const { headers: auth } = await login(app);
    const imported = await importCsv(app, auth, csvFor(500));
    expect(imported.stats.requested).toBe(500);
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers: auth });
    const result = await runUntilIdle(app, auth, imported.batch.id, 80);
    expect(result.stats.requested).toBe(500);
    expect(result.stats.alreadyExists).toBe(1);
    expect(result.stats.created).toBe(499);
    expect(result.stats.failed).toBe(0);
    expect(result.batch.status).toBe("COMPLETED");
    expect(directory.insertCalls).toHaveLength(499);
  });

  it("pauses, resumes, and cancels remaining work without deleting created users", async () => {
    const directory = new MockGoogleDirectory();
    const { app, headers } = await setup(directory);
    const imported = await importCsv(app, headers, csvFor(8));
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    await app.ctx.workspace.processDue();
    const paused = await app.inject({
      method: "POST",
      url: `/api/workspace/batches/${imported.batch.id}/pause`,
      headers
    });
    expect(paused.statusCode).toBe(200);
    const mid = await app.ctx.workspace.getBatch(imported.batch.id);
    expect(mid.batch.status).toBe("PAUSED");
    const createdBeforeCancel = mid.stats.created + mid.stats.alreadyExists;
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/resume`, headers });
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/cancel`, headers });
    const cancelled = await app.ctx.workspace.getBatch(imported.batch.id);
    expect(cancelled.batch.status).toBe("CANCELLED");
    expect(cancelled.stats.created + cancelled.stats.alreadyExists).toBeGreaterThanOrEqual(createdBeforeCancel);
    const exportRes = await app.inject({
      method: "GET",
      url: `/api/workspace/batches/${imported.batch.id}/export`,
      headers
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.body).toContain("fullEmail");
    expect(exportRes.body).not.toMatch(/password/i);
  });

  it("never logs generated passwords or credential material", async () => {
    const { app, headers } = await setup();
    const imported = await importCsv(app, headers, SAMPLE_CSV);
    await app.inject({ method: "POST", url: `/api/workspace/batches/${imported.batch.id}/start`, headers });
    await runUntilIdle(app, headers, imported.batch.id);
    const logs = await app.inject({ method: "GET", url: "/api/logs?limit=200", headers });
    const blob = JSON.stringify(logs.json());
    expect(blob).not.toMatch(/Aa1!/);
    expect(blob).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(blob).not.toMatch(/refresh.?token/i);
  });

  it("reports workspace usage and deletes failed users and batches", async () => {
    const directory = new MockGoogleDirectory();
    directory.seed("existing@example.com");
    const { app, headers } = await setup(directory);

    const usage = await app.inject({ method: "GET", url: "/api/workspace/usage", headers });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toEqual({ totalUsers: 1, remainingLicenses: 999, remainingUnavailableReason: null });

    const imported = await importCsv(
      app,
      headers,
      "firstName,lastName,username\nHamza,Ahmed,bad..name\nOk,User,okuser"
    );
    expect(imported.stats.failed).toBe(1);
    const failedUser = imported.users.find((user) => user.status === "FAILED");
    expect(failedUser).toBeDefined();

    const deletedUser = await app.inject({
      method: "DELETE",
      url: `/api/workspace/batches/${imported.batch.id}/users/${failedUser!.id}`,
      headers
    });
    expect(deletedUser.statusCode).toBe(200);
    expect(deletedUser.json().stats.failed).toBe(0);
    expect(deletedUser.json().stats.requested).toBe(1);

    const deletedBatch = await app.inject({
      method: "DELETE",
      url: `/api/workspace/batches/${imported.batch.id}`,
      headers
    });
    expect(deletedBatch.statusCode).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/api/workspace/batches", headers });
    expect(listed.json()).toEqual([]);
  });
});
