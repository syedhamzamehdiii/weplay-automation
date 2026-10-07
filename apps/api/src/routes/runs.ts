import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  configuration: z.object({
    kind: z.enum(["join_room", "support"]).default("join_room"),
    roomId: z.string().min(1),
    supportTarget: z.string().optional().default(""),
    accountIds: z.array(z.string().min(1)).min(1),
    durationMs: z.coerce.number().int().positive(),
    intervalMs: z.coerce.number().int().nonnegative()
  })
});

export const runRoutes: FastifyPluginAsync = async (app) => {
  app.get("/runs", async () => app.ctx.runs.list());

  app.post("/runs", async (request) => {
    const body = createSchema.parse(request.body);
    return app.ctx.runs.create(body);
  });

  app.get("/runs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const run = await app.ctx.runs.get(id);
    const jobs = await app.ctx.jobs.list({ runId: id, limit: 500 });
    return { run, jobs };
  });

  app.post("/runs/:id/start", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.runs.start(id);
  });

  app.post("/runs/:id/pause", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.runs.pause(id);
  });

  app.post("/runs/:id/resume", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.runs.resume(id);
  });

  app.post("/runs/:id/stop", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.runs.stop(id);
  });
};
