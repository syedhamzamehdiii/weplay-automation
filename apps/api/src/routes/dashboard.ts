import type { FastifyPluginAsync } from "fastify";

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/dashboard/stats", async () => app.ctx.dashboard.stats());
};
