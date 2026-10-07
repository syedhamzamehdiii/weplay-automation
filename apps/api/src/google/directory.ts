import { randomBytes } from "node:crypto";
import type { ErrorCode } from "@weplay/types";

export interface DirectoryUser {
  id: string;
  primaryEmail: string;
  givenName?: string;
  familyName?: string;
  suspended?: boolean;
}

export interface InsertWorkspaceUserInput {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  password: string;
  changePasswordAtNextLogin: boolean;
}

export interface DirectoryError extends Error {
  errorCode: ErrorCode;
  retryable: boolean;
  httpStatus: number | null;
}

export interface WorkspaceUsage {
  totalUsers: number | null;
  remainingLicenses: number | null;
  remainingUnavailableReason: string | null;
}

export interface GoogleDirectoryClient {
  readonly configured: boolean;
  getUser(email: string): Promise<DirectoryUser | null>;
  insertUser(input: InsertWorkspaceUserInput): Promise<DirectoryUser>;
  listUsers(): Promise<DirectoryUser[]>;
  getUsage(): Promise<WorkspaceUsage>;
  setPassword(email: string, password: string, changePasswordAtNextLogin: boolean): Promise<void>;
}

export function generateWorkspacePassword(): string {
  return `${randomBytes(24).toString("base64url")}Aa1!`;
}

export function directoryError(
  message: string,
  errorCode: ErrorCode,
  options: { retryable?: boolean; httpStatus?: number | null; cause?: unknown } = {}
): DirectoryError {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined) as DirectoryError;
  error.name = "DirectoryError";
  error.errorCode = errorCode;
  error.retryable = options.retryable ?? false;
  error.httpStatus = options.httpStatus ?? null;
  return error;
}

export function isDirectoryError(error: unknown): error is DirectoryError {
  return Boolean(error && typeof error === "object" && "errorCode" in error && "retryable" in error);
}

export function mapGoogleDirectoryError(error: unknown): DirectoryError {
  if (isDirectoryError(error)) {
    return error;
  }
  const status =
    typeof error === "object" && error && "code" in error && typeof (error as { code: unknown }).code === "number"
      ? (error as { code: number }).code
      : typeof error === "object" && error && "status" in error && typeof (error as { status: unknown }).status === "number"
        ? (error as { status: number }).status
        : null;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : "Google Directory API request failed";
  const message = rawMessage.slice(0, 500);
  const lower = message.toLowerCase();

  if (status === 404) {
    return directoryError(message, "WORKSPACE_USER_INVALID", { httpStatus: 404 });
  }
  if (status === 409 || lower.includes("entityexists") || lower.includes("already exists")) {
    return directoryError(message, "ACCOUNT_ALREADY_EXISTS", { httpStatus: status ?? 409 });
  }
  if (status === 429 || lower.includes("rate") || lower.includes("quota exceeded") || lower.includes("userRateLimitExceeded")) {
    const quota = lower.includes("quota") && !lower.includes("rate");
    return directoryError(message, quota ? "WORKSPACE_QUOTA_EXCEEDED" : "RATE_LIMITED", {
      retryable: true,
      httpStatus: status ?? 429
    });
  }
  if (
    lower.includes("license") ||
    lower.includes("no seats") ||
    lower.includes("usagelimits") ||
    lower.includes("domain user limit") ||
    lower.includes("user limit reached") ||
    lower.includes("start paid subscription")
  ) {
    return directoryError(message, "WORKSPACE_LICENSE_EXHAUSTED", { httpStatus: status });
  }
  if (status === 401 || status === 403) {
    return directoryError(message, "AUTH_REQUIRED", { httpStatus: status });
  }
  if (status === 400) {
    return directoryError(message, "WORKSPACE_USER_INVALID", { httpStatus: 400 });
  }
  if (status && status >= 500) {
    return directoryError(message, "NETWORK_ERROR", { retryable: true, httpStatus: status });
  }
  if (lower.includes("timeout") || lower.includes("etimedout") || lower.includes("econnreset")) {
    return directoryError(message, "TIMEOUT", { retryable: true, httpStatus: status });
  }
  return directoryError(message, "NETWORK_ERROR", { retryable: true, httpStatus: status });
}
