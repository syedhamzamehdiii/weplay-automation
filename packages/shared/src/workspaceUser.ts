const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._'-]*[a-z0-9])?$/i;

export function normalizeWorkspaceUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function normalizeWorkspaceDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

export function buildWorkspaceEmail(username: string, domain: string): string {
  return `${normalizeWorkspaceUsername(username)}@${normalizeWorkspaceDomain(domain)}`;
}

export function validateWorkspaceUsername(username: string): string | null {
  const normalized = normalizeWorkspaceUsername(username);
  if (!normalized) {
    return "Username is required";
  }
  if (normalized.length > 64) {
    return "Username must be 64 characters or fewer";
  }
  if (normalized.includes("..")) {
    return "Username cannot contain consecutive dots";
  }
  if (normalized.startsWith(".") || normalized.endsWith(".")) {
    return "Username cannot start or end with a dot";
  }
  if (!USERNAME_PATTERN.test(normalized)) {
    return "Username may contain letters, numbers, dots, hyphens, underscores, and apostrophes";
  }
  return null;
}

export function validateWorkspaceDomain(domain: string): string | null {
  const normalized = normalizeWorkspaceDomain(domain);
  if (!normalized) {
    return "Workspace domain is not configured";
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) || normalized.startsWith("-") || normalized.endsWith("-")) {
    return "Workspace domain is invalid";
  }
  return null;
}

export function isWorkspaceUserTerminal(status: string): boolean {
  return status === "CREATED" || status === "ALREADY_EXISTS" || status === "FAILED";
}

export function isWorkspaceUserInFlight(status: string): boolean {
  return status === "CREATING" || status === "RETRYING" || status === "VALIDATING";
}

export function isWorkspaceUserCompletable(status: string): boolean {
  return status === "PENDING" || status === "RETRYING" || status === "CREATING" || status === "VALIDATING";
}

export function exponentialBackoffMs(attemptCount: number, initialMs: number, maxMs = 60_000): number {
  const safeAttempt = Math.max(0, attemptCount);
  const delay = initialMs * 2 ** safeAttempt;
  return Math.min(maxMs, delay);
}

export const WORKSPACE_DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user";
export const WORKSPACE_REPORTS_SCOPE = "https://www.googleapis.com/auth/admin.reports.usage.readonly";

export const WORKSPACE_LICENSE_WARNING =
  "Successful creation depends on available Workspace user licenses, organization and account limits, Google Admin API quotas, and domain configuration. This tool does not reserve licenses and will not create users if Google rejects the request.";
