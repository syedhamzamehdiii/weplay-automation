import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/login", async (request) => {
    const body = loginSchema.parse(request.body);
    const operator = await app.ctx.auth.login(body.username, body.password);
    const token = await app.jwt.sign({ sub: operator.id, typ: "operator" });
    return { token, operator };
  });

  app.get("/auth/me", async (request) => request.operator);

  app.post("/auth/logout", async () => ({ ok: true }));
};
