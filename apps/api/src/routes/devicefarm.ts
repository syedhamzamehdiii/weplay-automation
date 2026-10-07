import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const startSchema = z
  .object({
    email: z.string().min(3).max(320).optional(),
    emails: z.array(z.string().min(3).max(320)).min(1).max(20).optional()
  })
  .strict()
  .refine((body) => Boolean(body.email?.trim() || (body.emails && body.emails.length > 0)), {
    message: "email or emails is required"
  });

export const deviceFarmRoutes: FastifyPluginAsync = async (app) => {
  app.get("/devicefarm/status", async () => app.ctx.deviceFarm.status());

  app.post("/devicefarm/provision", async (request) => {
    const body = startSchema.parse(request.body);
    const emails = [
      ...(body.emails ?? []),
      ...(body.email ? [body.email] : [])
    ].map((value) => value.trim().toLowerCase());
    return app.ctx.deviceFarm.start(emails);
  });

  app.post("/devicefarm/join", async (request) => {
    const body = z
      .object({
        emails: z.array(z.string().min(3).max(320)).min(1).max(20),
        roomId: z.string().min(1),
        supportTarget: z.string().optional().default("")
      })
      .parse(request.body);
    return app.ctx.deviceFarm.startJoin({
      emails: body.emails.map((value) => value.trim().toLowerCase()),
      roomId: body.roomId.trim(),
      supportTarget: body.supportTarget
    });
  });

  app.get("/accounts/:id/devicefarm", async (request) => {
    const { id } = request.params as { id: string };
    await app.ctx.accounts.get(id);
    return { provisioning: await app.ctx.deviceFarm.getForAccount(id) };
  });
};
