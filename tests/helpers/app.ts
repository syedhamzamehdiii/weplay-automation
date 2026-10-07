import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, type AppEnv } from "@weplay/config";
import { buildApp } from "../../apps/api/src/app.js";
import { createDb } from "../../apps/api/src/db/client.js";
import { migrate } from "../../apps/api/src/db/migrate.js";
import { seed } from "../../apps/api/src/db/seed.js";
import type { GoogleDirectoryClient } from "../../apps/api/src/google/directory.js";
import type { DeviceFarmWorkerClient } from "../../apps/api/src/devicefarm/client.js";

export async function createTestApp(
  overrides: Partial<AppEnv> = {},
  options: { directoryClient?: GoogleDirectoryClient; deviceFarmClient?: DeviceFarmWorkerClient } = {}
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "weplay-"));
  const databaseUrl = `sqlite:${path.join(dir, "test.db")}`;
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    JWT_SECRET: "test-jwt-secret-value",
    WORKER_TOKEN_SECRET: "test-worker-secret-value",
    INITIAL_ADMIN_USERNAME: "admin",
    INITIAL_ADMIN_PASSWORD: "adminpass",
    ALLOWED_DURATIONS_MS: "60000,180000,300000,900000",
    DEFAULT_INTERVAL_MS: "0",
    MAX_JOB_RETRIES: "3",
    HEARTBEAT_TIMEOUT_MS: "2000",
    JOB_STALE_MS: "5000",
    CONTROLLER_TICK_MS: "50",
    GOOGLE_WORKSPACE_DOMAIN: "example.com",
    GOOGLE_WORKSPACE_ADMIN_EMAIL: "admin@example.com",
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "provisioner@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n"
    }),
    GOOGLE_WORKSPACE_PROVISION_CONCURRENCY: "4",
    GOOGLE_WORKSPACE_PROVISION_MAX_RETRIES: "3",
    GOOGLE_WORKSPACE_PROVISION_INITIAL_BACKOFF_MS: "10",
    ...overrides
  });
  const db = createDb(env.DATABASE_URL);
  await migrate(db);
  await seed(db, env);
  const app = await buildApp(env, db, options);
  return { app, env, db, dir };
}

export async function login(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "adminpass" }
  });
  const body = response.json() as { token: string };
  return { token: body.token, headers: { authorization: `Bearer ${body.token}` } };
}
