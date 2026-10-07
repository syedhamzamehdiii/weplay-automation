import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@weplay/config";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { describeAwsCredentials } from "./devicefarm/credentials.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
loadDotenv({ path: path.join(root, ".env") });

const env = loadEnv(process.env);
const db = createDb(env.DATABASE_URL);
await migrate(db);
await seed(db, env);

const app = await buildApp(env, db);
const awsCredentials = describeAwsCredentials(env);
app.log.info({
  msg: "WePlay API starting",
  host: env.API_HOST,
  port: env.API_PORT,
  deviceFarm: {
    region: awsCredentials.region,
    credentialsAvailable: awsCredentials.credentialsAvailable,
    credentialsSource: awsCredentials.credentialsSource,
    projectConfigured: Boolean(env.DEVICEFARM_PROJECT_ARN.trim()),
    devicePoolConfigured: Boolean(env.DEVICEFARM_DEVICE_POOL_ARN.trim()),
    appConfigured: Boolean(env.DEVICEFARM_APP_ARN.trim() || env.DEVICEFARM_APP_PATH.trim())
  }
});
await app.ctx.controller.recover();
if (env.WEPLAY_WORKSPACE_PASSWORD.trim()) {
  try {
    const updated = await app.ctx.deviceFarm.applySharedPasswordToDirectoryUsers();
    app.log.info({ msg: "Applied shared Workspace password to Directory users", updated });
  } catch (error) {
    app.log.warn({
      msg: "Could not apply shared Workspace password to Directory users",
      error: error instanceof Error ? error.message : "unknown"
    });
  }
}
const settings = await app.ctx.settings.read();
app.ctx.controller.startLoop(settings.controllerTickMs);

const shutdown = async () => {
  app.ctx.controller.stopLoop();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: env.API_HOST, port: env.API_PORT });
