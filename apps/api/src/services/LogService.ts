import { createId, now } from "@weplay/shared";
import type { EventLog } from "@weplay/types";
import type { EventLogRepository } from "../repositories/EventLogRepository.js";
import type { EventBus } from "../events/bus.js";

const SENSITIVE = /password|token|secret|cookie|otp|sms|private.?key|refresh.?token|service.?account/i;

function sanitize(value: unknown): unknown {
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE.test(key) ? "[redacted]" : sanitize(entry);
    }
    return output;
  }
  return value;
}

type StdoutLogger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

const SKIP_STDOUT = new Set(["ACCOUNT_UPDATED"]);

export class LogService {
  private stdout: StdoutLogger | null = null;

  constructor(
    private readonly logs: EventLogRepository,
    private readonly bus: EventBus
  ) {}

  setLogger(logger: StdoutLogger | { info: Function; warn: Function }): void {
    this.stdout = logger as StdoutLogger;
  }

  async record(partial: Omit<EventLog, "id" | "timestamp" | "metadata"> & { timestamp?: number; metadata?: Record<string, unknown> }): Promise<EventLog> {
    const entry: EventLog = {
      id: createId(),
      timestamp: partial.timestamp ?? now(),
      accountId: partial.accountId,
      jobId: partial.jobId,
      workerId: partial.workerId,
      runId: partial.runId,
      event: partial.event,
      status: partial.status,
      error: partial.error,
      message: partial.message,
      metadata: (sanitize(partial.metadata ?? {}) as Record<string, unknown>) ?? {}
    };
    await this.logs.insert(entry);
    this.writeStdout(entry);
    this.bus.publish("log", entry);
    this.bus.publish("changed", { source: "log" });
    return entry;
  }

  private writeStdout(entry: EventLog): void {
    if (!this.stdout || SKIP_STDOUT.has(entry.event)) {
      return;
    }
    const payload = {
      event: entry.event,
      status: entry.status,
      accountId: entry.accountId,
      jobId: entry.jobId
    };
    const message = entry.message ?? entry.event;
    if (entry.error) {
      this.stdout.warn({ ...payload, error: entry.error }, message);
      return;
    }
    this.stdout.info(payload, message);
  }

  list(filters: { accountId?: string; jobId?: string; workerId?: string; limit?: number }) {
    return this.logs.list(filters);
  }
}
