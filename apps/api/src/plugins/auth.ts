import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError } from "../http.js";

const OPEN_PATHS = new Set(["/api/health", "/api/auth/login", "/api/workers/register"]);

function isWorkerPath(url: string): boolean {
  return (
    url.startsWith("/api/workers/heartbeat") ||
    url.startsWith("/api/workers/jobs") ||
    url.startsWith("/api/workers/me")
  );
}

export function registerAuth(app: FastifyInstance): void {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (request.method === "OPTIONS" || OPEN_PATHS.has(path) || path === "/api/health") {
      return;
    }

    const header = request.headers.authorization;
    const queryToken = (request.query as { token?: string } | undefined)?.token;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
    if (!token) {
      throw new HttpError(401, "Authentication required", "AUTH_REQUIRED");
    }

    if (isWorkerPath(path)) {
      request.worker = await app.ctx.workers.authenticate(token);
      return;
    }

    try {
      const payload = await request.server.jwt.verify<{ sub: string; typ?: string }>(token);
      if (payload.typ === "worker") {
        throw new HttpError(403, "Operator token required", "AUTH_REQUIRED");
      }
      const operator = await app.ctx.auth.getById(payload.sub);
      if (!operator) {
        throw new HttpError(401, "Authentication required", "AUTH_REQUIRED");
      }
      request.operator = operator;
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(401, "Authentication required", "AUTH_REQUIRED");
    }
  });
}

declare module "fastify" {
  interface FastifyRequest {
    operator?: import("@weplay/types").Operator;
    worker?: import("@weplay/types").Worker;
  }
}
