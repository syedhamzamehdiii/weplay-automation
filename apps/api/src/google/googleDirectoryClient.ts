import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "@weplay/config";
import { google } from "googleapis";
import { WORKSPACE_DIRECTORY_SCOPE, WORKSPACE_REPORTS_SCOPE } from "@weplay/shared";
import {
  directoryError,
  mapGoogleDirectoryError,
  type DirectoryUser,
  type GoogleDirectoryClient,
  type InsertWorkspaceUserInput,
  type WorkspaceUsage
} from "./directory.js";

export const REPORTS_SCOPE_MISSING =
  "Remaining license count needs Reports usage read access in Google Admin (scope admin.reports.usage.readonly) on the service account client ID.";

export const LICENSE_TOTALS_UNPUBLISHED =
  "Reports access is working. Google did not return purchased license totals for this Workspace plan, so remaining seats cannot be shown here. Open Google Admin → Billing → Subscriptions for the live limit.";

function numericParameter(parameter: { intValue?: string | null; stringValue?: string | null }): number | null {
  const raw = parameter.intValue ?? parameter.stringValue;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Sum SKU license fields from Reports customer usage. Many modern Workspace plans omit these. */
export function licenseTotalsFromReportParameters(
  parameters: Array<{ name?: string | null; intValue?: string | null; stringValue?: string | null }>
): { total: number | null; used: number | null } {
  let total = 0;
  let used = 0;
  let hasTotal = false;
  let hasUsed = false;
  for (const parameter of parameters) {
    const name = parameter.name ?? "";
    const value = numericParameter(parameter);
    if (value === null) {
      continue;
    }
    if (name.endsWith("_total_licenses")) {
      total += value;
      hasTotal = true;
    } else if (name.endsWith("_used_licenses")) {
      used += value;
      hasUsed = true;
    }
  }
  return { total: hasTotal ? total : null, used: hasUsed ? used : null };
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

function resolveServiceAccountFile(file: string): string {
  if (path.isAbsolute(file)) {
    return file;
  }
  const fromRoot = path.resolve(repoRoot(), file);
  if (existsSync(fromRoot)) {
    return fromRoot;
  }
  const fromSecrets = path.resolve(repoRoot(), "secrets", path.basename(file));
  if (existsSync(fromSecrets)) {
    return fromSecrets;
  }
  throw directoryError(
    `Service account file not found. Looked for ${fromRoot} and ${fromSecrets}. Set GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE to secrets/<filename>.json`,
    "INVALID_CONFIGURATION"
  );
}

function loadServiceAccount(env: AppEnv): ServiceAccountJson | null {
  const inline = env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON.trim();
  const file = env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE.trim();
  let raw = inline;
  if (!raw && file) {
    raw = readFileSync(resolveServiceAccountFile(file), "utf8");
  }
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as ServiceAccountJson;
  } catch {
    throw directoryError("Service account JSON is invalid", "INVALID_CONFIGURATION");
  }
}

export function workspaceCredentialsConfigured(env: AppEnv): boolean {
  return Boolean(
    env.GOOGLE_WORKSPACE_DOMAIN.trim() &&
      env.GOOGLE_WORKSPACE_ADMIN_EMAIL.trim() &&
      (env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE.trim() || env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON.trim())
  );
}

export function createGoogleDirectoryClient(env: AppEnv): GoogleDirectoryClient {
  const adminEmail = env.GOOGLE_WORKSPACE_ADMIN_EMAIL.trim();
  const domain = env.GOOGLE_WORKSPACE_DOMAIN.trim().toLowerCase();
  const configured = workspaceCredentialsConfigured(env);

  const getAuth = (scopes: string[]) => {
    if (!configured) {
      throw directoryError("Google Workspace is not configured", "WORKSPACE_NOT_CONFIGURED");
    }
    const credentials = loadServiceAccount(env);
    if (!credentials?.client_email || !credentials.private_key) {
      throw directoryError("Service account JSON must include client_email and private_key", "INVALID_CONFIGURATION");
    }
    return new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes,
      subject: adminEmail
    });
  };

  async function countDirectoryUsers(): Promise<number> {
    const directory = google.admin({ version: "directory_v1", auth: getAuth([WORKSPACE_DIRECTORY_SCOPE]) });
    let pageToken: string | undefined;
    let total = 0;
    do {
      const response = await directory.users.list({
        domain: domain || undefined,
        customer: domain ? undefined : "my_customer",
        maxResults: 500,
        pageToken,
        fields: "nextPageToken,users(id)"
      });
      total += response.data.users?.length ?? 0;
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return total;
  }

  async function licenseCounts(): Promise<{
    total: number | null;
    used: number | null;
    reportsAuthorized: boolean;
  }> {
    const reports = google.admin({ version: "reports_v1", auth: getAuth([WORKSPACE_REPORTS_SCOPE]) });
    for (let daysAgo = 2; daysAgo <= 7; daysAgo += 1) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - daysAgo);
      const dateString = date.toISOString().slice(0, 10);
      try {
        const response = await reports.customerUsageReports.get({
          customerId: "my_customer",
          date: dateString
        });
        const parameters = response.data.usageReports?.[0]?.parameters ?? [];
        const licenses = licenseTotalsFromReportParameters(parameters);
        if (licenses.total !== null || licenses.used !== null || parameters.length > 0) {
          return { ...licenses, reportsAuthorized: true };
        }
      } catch (error) {
        const status =
          typeof error === "object" && error && "code" in error ? Number((error as { code: unknown }).code) : null;
        if (status === 401 || status === 403) {
          return { total: null, used: null, reportsAuthorized: false };
        }
        continue;
      }
    }
    return { total: null, used: null, reportsAuthorized: true };
  }

  return {
    configured,
    async getUser(email: string): Promise<DirectoryUser | null> {
      const directory = google.admin({ version: "directory_v1", auth: getAuth([WORKSPACE_DIRECTORY_SCOPE]) });
      try {
        const response = await directory.users.get({ userKey: email });
        const id = response.data.id;
        const primaryEmail = response.data.primaryEmail;
        if (!id || !primaryEmail) {
          return null;
        }
        return { id, primaryEmail };
      } catch (error) {
        const mapped = mapGoogleDirectoryError(error);
        if (mapped.httpStatus === 404) {
          return null;
        }
        throw mapped;
      }
    },
    async insertUser(input: InsertWorkspaceUserInput): Promise<DirectoryUser> {
      const directory = google.admin({ version: "directory_v1", auth: getAuth([WORKSPACE_DIRECTORY_SCOPE]) });
      try {
        const response = await directory.users.insert({
          requestBody: {
            primaryEmail: input.primaryEmail,
            name: {
              givenName: input.givenName,
              familyName: input.familyName
            },
            password: input.password,
            changePasswordAtNextLogin: input.changePasswordAtNextLogin
          }
        });
        const id = response.data.id;
        const primaryEmail = response.data.primaryEmail;
        if (!id || !primaryEmail) {
          throw directoryError("Google user insert returned no user id", "UNKNOWN_STATE");
        }
        return { id, primaryEmail };
      } catch (error) {
        throw mapGoogleDirectoryError(error);
      }
    },
    async setPassword(email: string, password: string, changePasswordAtNextLogin: boolean): Promise<void> {
      const directory = google.admin({ version: "directory_v1", auth: getAuth([WORKSPACE_DIRECTORY_SCOPE]) });
      try {
        await directory.users.update({
          userKey: email,
          requestBody: {
            password,
            changePasswordAtNextLogin
          }
        });
      } catch (error) {
        throw mapGoogleDirectoryError(error);
      }
    },
    async listUsers(): Promise<DirectoryUser[]> {
      if (!configured) {
        return [];
      }
      const directory = google.admin({ version: "directory_v1", auth: getAuth([WORKSPACE_DIRECTORY_SCOPE]) });
      const users: DirectoryUser[] = [];
      let pageToken: string | undefined;
      do {
        const response = await directory.users.list({
          domain: domain || undefined,
          customer: domain ? undefined : "my_customer",
          maxResults: 500,
          pageToken,
          fields: "nextPageToken,users(id,primaryEmail,name,suspended)"
        });
        for (const user of response.data.users ?? []) {
          if (!user.id || !user.primaryEmail) {
            continue;
          }
          users.push({
            id: user.id,
            primaryEmail: user.primaryEmail,
            givenName: user.name?.givenName ?? undefined,
            familyName: user.name?.familyName ?? undefined,
            suspended: Boolean(user.suspended)
          });
        }
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);
      return users;
    },
    async getUsage(): Promise<WorkspaceUsage> {
      if (!configured) {
        return {
          totalUsers: null,
          remainingLicenses: null,
          remainingUnavailableReason: "Google Workspace is not configured"
        };
      }
      let totalUsers: number | null = null;
      let remainingLicenses: number | null = null;
      let remainingUnavailableReason: string | null = LICENSE_TOTALS_UNPUBLISHED;
      const [usersResult, licensesResult] = await Promise.allSettled([countDirectoryUsers(), licenseCounts()]);
      if (usersResult.status === "fulfilled") {
        totalUsers = usersResult.value;
      }
      if (licensesResult.status === "fulfilled") {
        if (licensesResult.value.total !== null) {
          remainingLicenses = Math.max(0, licensesResult.value.total - (totalUsers ?? licensesResult.value.used ?? 0));
          remainingUnavailableReason = null;
        } else if (!licensesResult.value.reportsAuthorized) {
          remainingUnavailableReason = REPORTS_SCOPE_MISSING;
        }
      } else {
        remainingUnavailableReason = REPORTS_SCOPE_MISSING;
      }
      return { totalUsers, remainingLicenses, remainingUnavailableReason };
    }
  };
}

export function createUnconfiguredDirectoryClient(): GoogleDirectoryClient {
  return {
    configured: false,
    async getUser(): Promise<DirectoryUser | null> {
      throw directoryError("Google Workspace is not configured", "WORKSPACE_NOT_CONFIGURED");
    },
    async insertUser(): Promise<DirectoryUser> {
      throw directoryError("Google Workspace is not configured", "WORKSPACE_NOT_CONFIGURED");
    },
    async setPassword(): Promise<void> {
      throw directoryError("Google Workspace is not configured", "WORKSPACE_NOT_CONFIGURED");
    },
    async listUsers(): Promise<DirectoryUser[]> {
      return [];
    },
    async getUsage(): Promise<WorkspaceUsage> {
      return {
        totalUsers: null,
        remainingLicenses: null,
        remainingUnavailableReason: "Google Workspace is not configured"
      };
    }
  };
}
