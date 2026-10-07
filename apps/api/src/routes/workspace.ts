import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const importSchema = z
  .object({
    csv: z.string().min(1),
    name: z.string().min(1).max(200).optional()
  })
  .strict();

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/workspace/status", async () => app.ctx.workspace.connectionStatus());

  app.get("/workspace/usage", async () => app.ctx.workspace.getUsage());

  app.get("/workspace/batches", async () => app.ctx.workspace.listBatches());

  app.post("/workspace/batches/import", async (request) => {
    const body = importSchema.parse(request.body);
    return app.ctx.workspace.importCsv(body.csv, body.name);
  });

  app.get("/workspace/batches/:id", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.getBatch(id);
  });

  app.post("/workspace/batches/:id/validate", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.validate(id, true);
  });

  app.post("/workspace/batches/:id/start", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.start(id);
  });

  app.post("/workspace/batches/:id/pause", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.pause(id);
  });

  app.post("/workspace/batches/:id/resume", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.resume(id);
  });

  app.post("/workspace/batches/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.cancel(id);
  });

  app.delete("/workspace/batches/:id", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workspace.deleteBatch(id);
  });

  app.delete("/workspace/batches/:id/users/:userId", async (request) => {
    const { id, userId } = request.params as { id: string; userId: string };
    return app.ctx.workspace.deleteFailedUser(id, userId);
  });

  app.get("/workspace/batches/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { batch, users } = await app.ctx.workspace.getBatch(id);
    const csv = app.ctx.workspace.exportCsv(users);
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="workspace-provisioning-${batch.id}.csv"`)
      .send(csv);
  });
};
