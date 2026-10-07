import type { FastifyPluginAsync } from "fastify";

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get("/jobs", async (request) => {
    const query = request.query as { status?: string; accountId?: string; runId?: string; kind?: string; limit?: string };
    return app.ctx.jobs.list({
      status: query.status,
      accountId: query.accountId,
      runId: query.runId,
      kind: query.kind,
      limit: query.limit ? Number(query.limit) : 200
    });
  });

  app.get("/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.jobs.get(id);
  });
};
