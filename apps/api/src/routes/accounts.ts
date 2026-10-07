import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { z } from "zod";
import { LOGIN_PROVIDERS, OAUTH_LOGIN_PROVIDERS, type Account } from "@weplay/types";

function googleDeviceFarmEmail(account: Pick<Account, "loginProvider" | "metadata">): string {
  if (account.loginProvider !== "GOOGLE") {
    return "";
  }
  return String(account.metadata.workspaceEmail || account.metadata.identityEmail || "")
    .trim()
    .toLowerCase();
}

async function deviceFarmConfigured(app: FastifyInstance): Promise<boolean> {
  return (await app.ctx.deviceFarm.status()).configured;
}

const createSchema = z.object({
  displayName: z.string().min(1).max(120),
  loginProvider: z.enum(LOGIN_PROVIDERS),
  workerId: z.string().uuid().nullable().optional()
});

const weplayCreateSchema = z
  .object({
    emails: z.array(z.string().min(3).max(320)).min(1).max(10_000),
    workerId: z.string().uuid().nullable().optional()
  })
  .strict();

const optionalIdentifier = z
  .string()
  .trim()
  .max(320)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const identitySchema = z
  .object({
    displayName: z.string().min(1).max(120),
    loginProvider: z.enum(OAUTH_LOGIN_PROVIDERS),
    workerId: z.string().uuid().nullable().optional(),
    email: optionalIdentifier,
    handle: optionalIdentifier
  })
  .strict();

const importSchema = z
  .object({
    identities: z.array(identitySchema).min(1).max(500),
    startSetup: z.boolean().optional().default(false)
  })
  .strict();

const updateSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  loginProvider: z.enum(LOGIN_PROVIDERS).optional(),
  workerId: z.string().uuid().nullable().optional()
});

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get("/accounts", async () => app.ctx.accounts.list());

  app.post("/accounts", async (request) => {
    const body = createSchema.parse(request.body);
    return app.ctx.accounts.create(body);
  });

  app.get("/accounts/workspace-candidates", async () => app.ctx.accounts.listWorkspaceCandidates());

  app.post("/accounts/import", async (request) => {
    const body = importSchema.parse(request.body);
    const accounts = await app.ctx.accounts.importIdentities({ identities: body.identities });
    if (body.startSetup) {
      const pixelReady = await deviceFarmConfigured(app);
      let pixelStarted = false;
      for (const account of accounts) {
        const email = googleDeviceFarmEmail(account);
        if (email && pixelReady) {
          if (!pixelStarted) {
            await app.ctx.deviceFarm.start(email);
            pixelStarted = true;
          }
          continue;
        }
        const started = await app.ctx.accounts.startSetup(account.id);
        await app.ctx.jobs.create({
          accountId: started.id,
          runId: null,
          configuration: {
            kind: "setup",
            loginProvider: started.loginProvider,
            resume: false
          }
        });
      }
    }
    return { accounts: await Promise.all(accounts.map((row) => app.ctx.accounts.get(row.id))) };
  });

  app.post("/accounts/weplay-create", async (request) => {
    const body = weplayCreateSchema.parse(request.body);
    if (await deviceFarmConfigured(app)) {
      const result = await app.ctx.deviceFarm.start(body.emails.map((email) => email.trim().toLowerCase()));
      return { started: result.accounts, skipped: result.skipped };
    }
    const result = await app.ctx.accounts.startWorkspaceWePlaySetup(body);
    for (const account of result.started) {
      await app.ctx.jobs.create({
        accountId: account.id,
        runId: null,
        configuration: {
          kind: "setup",
          loginProvider: "GOOGLE",
          resume: false,
          workspaceEmail: String(account.metadata.workspaceEmail ?? "")
        }
      });
    }
    return {
      started: await Promise.all(result.started.map((row) => app.ctx.accounts.get(row.id))),
      skipped: result.skipped
    };
  });

  app.get("/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.accounts.get(id);
  });

  app.patch("/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);
    return app.ctx.accounts.updateMetadata(id, body);
  });

  app.delete("/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    await app.ctx.accounts.remove(id);
    return { ok: true };
  });

  app.post("/accounts/:id/enable", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.accounts.setEnabled(id, true);
  });

  app.post("/accounts/:id/disable", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.accounts.setEnabled(id, false);
  });

  app.post("/accounts/:id/setup/start", async (request) => {
    const { id } = request.params as { id: string };
    const account = await app.ctx.accounts.get(id);
    const email = googleDeviceFarmEmail(account);
    if (email && (await deviceFarmConfigured(app))) {
      return (await app.ctx.deviceFarm.start(email)).account;
    }
    const started = await app.ctx.accounts.startSetup(id);
    await app.ctx.jobs.create({
      accountId: started.id,
      runId: null,
      configuration: { kind: "setup", loginProvider: started.loginProvider, resume: false }
    });
    return started;
  });

  app.post("/accounts/:id/setup/resume", async (request) => {
    const { id } = request.params as { id: string };
    const account = await app.ctx.accounts.get(id);
    const email = googleDeviceFarmEmail(account);
    if (email && (await deviceFarmConfigured(app))) {
      return (await app.ctx.deviceFarm.start(email)).account;
    }
    const resumed = await app.ctx.accounts.resumeSetup(id);
    await app.ctx.jobs.create({
      accountId: resumed.id,
      runId: null,
      configuration: { kind: "setup", loginProvider: resumed.loginProvider, resume: true }
    });
    return resumed;
  });

  app.post("/accounts/:id/setup/complete", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.accounts.confirmSetup(id);
  });

  app.post("/accounts/:id/reauth", async (request) => {
    const { id } = request.params as { id: string };
    const account = await app.ctx.accounts.startReauth(id);
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "reauth", loginProvider: account.loginProvider, resume: true }
    });
    return account;
  });

  app.post("/accounts/:id/create/retry", async (request) => {
    const { id } = request.params as { id: string };
    const account = await app.ctx.accounts.retryWePlayCreation(id);
    await app.ctx.jobs.create({
      accountId: account.id,
      runId: null,
      configuration: { kind: "create_account", loginProvider: account.loginProvider }
    });
    return account;
  });

  app.get("/accounts/:id/history", async (request) => {
    const { id } = request.params as { id: string };
    await app.ctx.accounts.get(id);
    const [logs, jobs] = await Promise.all([
      app.ctx.logs.list({ accountId: id, limit: 200 }),
      app.ctx.jobs.list({ accountId: id, limit: 200 })
    ]);
    return { logs, jobs };
  });

  app.get("/accounts/:id/errors", async (request) => {
    const { id } = request.params as { id: string };
    const account = await app.ctx.accounts.get(id);
    const logs = await app.ctx.logs.list({ accountId: id, limit: 200 });
    return {
      lastErrorCode: account.lastErrorCode,
      lastErrorMessage: account.lastErrorMessage,
      events: logs.filter((entry) => entry.error)
    };
  });
};
