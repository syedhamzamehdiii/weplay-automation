import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const patchSchema = z.object({
  maxJobRetries: z.number().int().min(0).max(20).optional(),
  heartbeatTimeoutMs: z.number().int().positive().optional(),
  defaultIntervalMs: z.number().int().min(0).optional(),
  allowedDurationsMs: z.array(z.number().int().positive()).min(1).optional(),
  jobStaleMs: z.number().int().positive().optional(),
  controllerTickMs: z.number().int().positive().optional()
});

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/settings", async () => app.ctx.settings.read());

  app.patch("/settings", async (request) => {
    const body = patchSchema.parse(request.body);
    return app.ctx.settings.update(body);
  });
};
