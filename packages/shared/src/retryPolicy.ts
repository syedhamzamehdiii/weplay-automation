import type { ErrorCode } from "@weplay/types";

export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "APP_CRASHED",
  "WORKER_OFFLINE",
  "WORKER_ERROR",
  "RATE_LIMITED"
]);

export function shouldRetry(code: ErrorCode, attemptCount: number, maxRetries: number): boolean {
  if (attemptCount >= maxRetries) {
    return false;
  }
  return RETRYABLE_ERROR_CODES.has(code);
}

export const HUMAN_ACTION_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "VERIFICATION_REQUIRED",
  "PERMISSION_REQUIRED"
]);

export function requiresHumanAction(code: ErrorCode): boolean {
  return HUMAN_ACTION_ERROR_CODES.has(code);
}
