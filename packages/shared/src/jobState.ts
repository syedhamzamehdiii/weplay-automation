import type { JobStatus } from "@weplay/types";

const ALLOWED: Record<JobStatus, JobStatus[]> = {
  QUEUED: ["ASSIGNED", "RUNNING", "CANCELLED"],
  ASSIGNED: ["RUNNING", "QUEUED", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  RETRYING: ["QUEUED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: ["RETRYING", "QUEUED"],
  CANCELLED: []
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
}

export function isJobInFlight(status: JobStatus): boolean {
  return status === "QUEUED" || status === "ASSIGNED" || status === "RUNNING" || status === "RETRYING";
}

export function isJobTerminal(status: JobStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}
