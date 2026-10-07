import { createHash, createHmac } from "node:crypto";
import type { AppEnv } from "@weplay/config";
import { createId, now } from "@weplay/shared";
import type { Worker } from "@weplay/types";
import { HttpError } from "../http.js";
import type { WorkerRepository } from "../repositories/WorkerRepository.js";
import type { AccountRepository } from "../repositories/AccountRepository.js";
import type { LogService } from "./LogService.js";
import type { EventBus } from "../events/bus.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createWorkerToken(workerId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: workerId, iat: Date.now() })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyWorkerToken(token: string, secret: string): string | undefined {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return undefined;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected !== signature) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string };
    return parsed.sub;
  } catch {
    return undefined;
  }
}

export class WorkerService {
  constructor(
    private readonly workers: WorkerRepository,
    private readonly accounts: AccountRepository,
    private readonly logs: LogService,
    private readonly bus: EventBus,
    private readonly env: AppEnv
  ) {}

  list() {
    return this.workers.list();
  }

  async get(id: string): Promise<Worker> {
    const worker = await this.workers.getById(id);
    if (!worker) {
      throw new HttpError(404, "Worker not found");
    }
    return worker;
  }

  async register(input: { name: string; deviceIdentifier: string; workerVersion: string }): Promise<{ worker: Worker; token: string }> {
    const existing = await this.workers.getByDeviceIdentifier(input.deviceIdentifier);
    const ts = now();
    if (existing) {
      const token = createWorkerToken(existing.id, this.env.WORKER_TOKEN_SECRET);
      existing.name = input.name;
      existing.workerVersion = input.workerVersion;
      existing.status = "IDLE";
      existing.lastHeartbeat = ts;
      existing.updatedAt = ts;
      await this.workers.update(existing);
      await this.workers.updateTokenHash(existing.id, hashToken(token), ts);
      await this.logs.record({
        accountId: null,
        jobId: existing.currentJobId,
        workerId: existing.id,
        runId: null,
        event: "WORKER_CONNECTED",
        status: existing.status,
        error: null,
        message: "Worker re-registered"
      });
      this.bus.publish("changed", { source: "worker" });
      return { worker: existing, token };
    }

    const worker: Worker = {
      id: createId(),
      name: input.name,
      deviceIdentifier: input.deviceIdentifier,
      platform: "ANDROID",
      status: "IDLE",
      workerVersion: input.workerVersion,
      lastHeartbeat: ts,
      currentJobId: null,
      createdAt: ts,
      updatedAt: ts
    };
    const token = createWorkerToken(worker.id, this.env.WORKER_TOKEN_SECRET);
    await this.workers.insert(worker, hashToken(token));
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: worker.id,
      runId: null,
      event: "WORKER_CONNECTED",
      status: worker.status,
      error: null,
      message: "Worker registered"
    });
    this.bus.publish("changed", { source: "worker" });
    return { worker, token };
  }

  async authenticate(token: string): Promise<Worker> {
    const workerId = verifyWorkerToken(token, this.env.WORKER_TOKEN_SECRET);
    if (!workerId) {
      throw new HttpError(401, "Invalid worker token", "AUTH_REQUIRED");
    }
    const worker = await this.workers.getWithTokenHash(workerId);
    if (!worker || worker.tokenHash !== hashToken(token)) {
      throw new HttpError(401, "Invalid worker token", "AUTH_REQUIRED");
    }
    return worker;
  }

  async heartbeat(worker: Worker, status?: Worker["status"]): Promise<Worker> {
    const ts = now();
    const wasOffline = worker.status === "OFFLINE";
    worker.lastHeartbeat = ts;
    if (status) {
      worker.status = status;
    } else if (worker.status === "OFFLINE" || worker.status === "STARTING") {
      worker.status = worker.currentJobId ? "BUSY" : "IDLE";
    }
    worker.updatedAt = ts;
    await this.workers.update(worker);
    if (wasOffline) {
      await this.logs.record({
        accountId: null,
        jobId: worker.currentJobId,
        workerId: worker.id,
        runId: null,
        event: "WORKER_CONNECTED",
        status: worker.status,
        error: null,
        message: "Worker heartbeat restored"
      });
    }
    this.bus.publish("changed", { source: "worker" });
    return worker;
  }

  async save(worker: Worker): Promise<void> {
    worker.updatedAt = now();
    await this.workers.update(worker);
    this.bus.publish("changed", { source: "worker" });
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.accounts.clearWorker(id);
    await this.workers.delete(id);
    await this.logs.record({
      accountId: null,
      jobId: null,
      workerId: id,
      runId: null,
      event: "WORKER_DISCONNECTED",
      status: "OFFLINE",
      error: null,
      message: "Worker removed"
    });
    this.bus.publish("changed", { source: "worker" });
  }
}
