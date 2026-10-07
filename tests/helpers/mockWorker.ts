import type { ErrorCode, Job } from "@weplay/types";
import type { FastifyInstance } from "fastify";

export class MockWorker {
  token = "";
  workerId = "";

  constructor(
    private readonly app: FastifyInstance,
    private readonly name: string,
    private readonly deviceIdentifier: string
  ) {}

  async register(): Promise<void> {
    const response = await this.app.inject({
      method: "POST",
      url: "/api/workers/register",
      payload: { name: this.name, deviceIdentifier: this.deviceIdentifier, workerVersion: "test-1" }
    });
    const body = response.json() as { token: string; worker: { id: string } };
    this.token = body.token;
    this.workerId = body.worker.id;
  }

  auth() {
    return { authorization: `Bearer ${this.token}` };
  }

  async heartbeat() {
    return this.app.inject({
      method: "POST",
      url: "/api/workers/heartbeat",
      headers: this.auth(),
      payload: {}
    });
  }

  async claim(): Promise<Job | null> {
    const response = await this.app.inject({
      method: "POST",
      url: "/api/workers/jobs/claim",
      headers: this.auth(),
      payload: {}
    });
    const body = response.json() as { job: Job | null };
    return body.job;
  }

  async succeed(job: Job): Promise<void> {
    await this.app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job.id}/start`,
      headers: this.auth(),
      payload: { executionId: job.executionId }
    });
    await this.app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job.id}/progress`,
      headers: this.auth(),
      payload: { executionId: job.executionId, event: "SUPPORT_STARTED" }
    });
    await this.app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job.id}/complete`,
      headers: this.auth(),
      payload: { executionId: job.executionId, verified: true }
    });
  }

  async fail(job: Job, errorCode: ErrorCode, errorMessage: string): Promise<void> {
    await this.app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job.id}/start`,
      headers: this.auth(),
      payload: { executionId: job.executionId }
    });
    await this.app.inject({
      method: "POST",
      url: `/api/workers/jobs/${job.id}/fail`,
      headers: this.auth(),
      payload: { executionId: job.executionId, errorCode, errorMessage }
    });
  }

  async drainSuccess(max = 50): Promise<number> {
    let count = 0;
    for (let i = 0; i < max; i += 1) {
      const job = await this.claim();
      if (!job) {
        break;
      }
      await this.succeed(job);
      count += 1;
    }
    return count;
  }
}
