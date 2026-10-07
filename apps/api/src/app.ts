import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import type { AppEnv } from "@weplay/config";
import { ZodError } from "zod";
import type { DbClient } from "./db/types.js";
import { createContext, type AppContext } from "./context.js";
import type { GoogleDirectoryClient } from "./google/directory.js";
import type { DeviceFarmWorkerClient } from "./devicefarm/client.js";
import { HttpError } from "./http.js";
import { registerAuth } from "./plugins/auth.js";
import { apiRoutes } from "./routes/index.js";

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

class OpsLogController extends LogController {
  incomingRequest(): void {
    // Mutations and failures are logged once in requestCompleted.
  }

  requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    const path = request.url.split("?")[0] ?? request.url;
    const quietGet = request.method === "GET" && !error && reply.statusCode < 400;
    const quietWorkerPoll =
      request.method === "POST" &&
      !error &&
      reply.statusCode < 400 &&
      (path.startsWith("/api/workers/heartbeat") || path.startsWith("/api/workers/jobs/claim"));
    if (quietGet || quietWorkerPoll) {
      return;
    }
    const payload = {
      method: request.method,
      url: path,
      statusCode: reply.statusCode,
      ms: Math.round(reply.elapsedTime)
    };
    if (error || reply.statusCode >= 500) {
      reply.log.error({ ...payload, err: error }, "http");
      return;
    }
    if (reply.statusCode >= 400) {
      request.log.warn(payload, "http");
      return;
    }
    request.log.info(payload, "http");
  }
}

export async function buildApp(
  env: AppEnv,
  db: DbClient,
  options: { directoryClient?: GoogleDirectoryClient; deviceFarmClient?: DeviceFarmWorkerClient } = {}
) {
  const isTest = env.NODE_ENV === "test";
  const app = Fastify({
    logger: isTest
      ? false
      : {
          level: "info",
          redact: {
            paths: ["req.headers.authorization", "req.headers.cookie"],
            censor: "[redacted]"
          }
        },
    logController: new OpsLogController()
  });

  const ctx = createContext(env, db, options);
  app.decorate("ctx", ctx);
  if (!isTest) {
    ctx.logs.setLogger(app.log);
  }

  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    try {
      const text = typeof body === "string" ? body : "";
      done(null, text.trim().length === 0 ? {} : JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true
  });
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        code: error.code
      });
    }
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const path = first?.path?.length ? first.path.join(".") : "request";
      return reply.status(400).send({
        error: first ? `${path}: ${first.message}` : "Invalid request",
        code: "INVALID_CONFIGURATION",
        details: error.flatten()
      });
    }
    const statusCode =
      error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : "Invalid request";
      return reply.status(statusCode).send({
        error: message,
        code: "INVALID_CONFIGURATION"
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      error: "Internal server error",
      code: "UNKNOWN_STATE"
    });
  });

  registerAuth(app);
  await app.register(apiRoutes, { prefix: "/api" });
  return app;
}
