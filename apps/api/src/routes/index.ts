import type { FastifyPluginAsync } from "fastify";
import { accountRoutes } from "./accounts.js";
import { authRoutes } from "./auth.js";
import { controllerRoutes } from "./controller.js";
import { dashboardRoutes } from "./dashboard.js";
import { eventRoutes } from "./events.js";
import { jobRoutes } from "./jobs.js";
import { logRoutes } from "./logs.js";
import { runRoutes } from "./runs.js";
import { settingsRoutes } from "./settings.js";
import { workerRoutes } from "./workers.js";
import { workspaceRoutes } from "./workspace.js";
import { deviceFarmRoutes } from "./devicefarm.js";

export const apiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(workerRoutes);
  await app.register(runRoutes);
  await app.register(jobRoutes);
  await app.register(dashboardRoutes);
  await app.register(logRoutes);
  await app.register(settingsRoutes);
  await app.register(controllerRoutes);
  await app.register(eventRoutes);
  await app.register(workspaceRoutes);
  await app.register(deviceFarmRoutes);
};
