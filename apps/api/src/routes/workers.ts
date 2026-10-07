import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ERROR_CODES, WORKER_STATUSES } from "@weplay/types";
import { HttpError } from "../http.js";

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  deviceIdentifier: z.string().min(1).max(200),
  workerVersion: z.string().min(1).max(50)
});

const heartbeatSchema = z.object({
  status: z.enum(WORKER_STATUSES).optional()
});

const executionSchema = z.object({
  executionId: z.string().min(1),
  event: z.string().min(1).optional(),
  message: z.string().optional(),
  verified: z.boolean().optional(),
  displayName: z.string().min(1).max(120).optional(),
  weplayUserId: z.string().min(1).max(64).optional(),
  errorCode: z.enum(ERROR_CODES).optional(),
  errorMessage: z.string().optional()
});

export const workerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/workers", async () => app.ctx.workers.list());

  app.post("/workers/register", async (request) => {
    const body = registerSchema.parse(request.body);
    return app.ctx.workers.register(body);
  });

  app.post("/workers/heartbeat", async (request) => {
    if (!request.worker) {
      throw new HttpError(401, "Worker authentication required", "AUTH_REQUIRED");
    }
    const body = heartbeatSchema.parse(request.body ?? {});
    return app.ctx.workers.heartbeat(request.worker, body.status);
  });

  app.get("/workers/me", async (request) => request.worker);

  app.post("/workers/jobs/claim", async (request) => {
    if (!request.worker) {
      throw new HttpError(401, "Worker authentication required", "AUTH_REQUIRED");
    }
    const job = await app.ctx.jobs.claim(request.worker);
    return { job };
  });

  app.post("/workers/jobs/:id/start", async (request) => {
    if (!request.worker) {
      throw new HttpError(401, "Worker authentication required", "AUTH_REQUIRED");
    }
    const { id } = request.params as { id: string };
    const body = executionSchema.parse(request.body);
    return app.ctx.jobs.markRunning(id, request.worker, body.executionId);
  });

  app.post("/workers/jobs/:id/progress", async (request) => {
    if (!request.worker) {
      throw new HttpError(401, "Worker authentication required", "AUTH_REQUIRED");
    }
    const { id } = request.params as { id: string };
    const body = executionSchema.parse(request.body);
    await app.ctx.jobs.progress(id, request.worker, body.executionId, body.event ?? "JOB_PROGRESS", body.message);
    return { ok: true };
  });

  app.post("/workers/jobs/:id/complete", async (request) => {
    if (!request.worker) {
      throw new HttpError(401, "Worker authentication required", "AUTH_REQUIRED");
    }
    const { id } = request.params as { id: string };
    const body = executionSchema.parse(request.body);
    if (body.verified !== true) {
      throw new HttpError(400, "Completion requires verified=true", "SUPPORT_FAILED");
    }
    return app.ctx.jobs.complete(id, request.worker, body.executionId, true, {
      displayName: body.displayName,
      weplayUserId: body.weplayUserId
    });
  });

  app.post("/workers/jobs/:id/fail", async (request) => {
    if (!request.worker) {
      throw new HttpError(401, "Worker authentication required", "AUTH_REQUIRED");
    }
    const { id } = request.params as { id: string };
    const body = executionSchema.parse(request.body);
    return app.ctx.jobs.fail(
      id,
      request.worker,
      body.executionId,
      body.errorCode ?? "UNKNOWN_STATE",
      body.errorMessage ?? "Worker reported failure"
    );
  });

  app.get("/workers/:id", async (request) => {
    const { id } = request.params as { id: string };
    return app.ctx.workers.get(id);
  });

  app.patch("/workers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    const worker = await app.ctx.workers.get(id);
    worker.name = body.name;
    await app.ctx.workers.save(worker);
    return worker;
  });

  app.delete("/workers/:id", async (request) => {
    const { id } = request.params as { id: string };
    await app.ctx.workers.remove(id);
    return { ok: true };
  });
};
