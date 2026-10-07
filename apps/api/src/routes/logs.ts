import type { FastifyPluginAsync } from "fastify";

export const logRoutes: FastifyPluginAsync = async (app) => {
  app.get("/logs", async (request) => {
    const query = request.query as { accountId?: string; jobId?: string; workerId?: string; limit?: string };
    return app.ctx.logs.list({
      accountId: query.accountId,
      jobId: query.jobId,
      workerId: query.workerId,
      limit: query.limit ? Number(query.limit) : 200
    });
  });
};
