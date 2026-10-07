import type { DirectoryUser, GoogleDirectoryClient, InsertWorkspaceUserInput } from "../../apps/api/src/google/directory.js";
import { directoryError } from "../../apps/api/src/google/directory.js";

export class MockGoogleDirectory implements GoogleDirectoryClient {
  configured = true;
  users = new Map<string, DirectoryUser>();
  insertCalls: string[] = [];
  getCalls: string[] = [];
  setPasswordCalls: Array<{ email: string; changePasswordAtNextLogin: boolean; passwordLength: number }> = [];
  failInsert = new Map<string, { code: number; message: string; remaining: number }>();
  rateLimitNext = 0;
  crashAfterInserts = Number.POSITIVE_INFINITY;

  seed(email: string, id = `existing-${email}`, extra: Partial<DirectoryUser> = {}): void {
    this.users.set(email.toLowerCase(), {
      id,
      primaryEmail: email.toLowerCase(),
      givenName: extra.givenName,
      familyName: extra.familyName,
      suspended: extra.suspended ?? false
    });
  }

  failNext(email: string, code: number, message: string, times = 1): void {
    this.failInsert.set(email.toLowerCase(), { code, message, remaining: times });
  }

  async getUser(email: string): Promise<DirectoryUser | null> {
    const key = email.toLowerCase();
    this.getCalls.push(key);
    return this.users.get(key) ?? null;
  }

  async insertUser(input: InsertWorkspaceUserInput): Promise<DirectoryUser> {
    const email = input.primaryEmail.toLowerCase();
    this.insertCalls.push(email);
    if (this.insertCalls.length > this.crashAfterInserts) {
      throw directoryError("Simulated crash", "NETWORK_ERROR", { retryable: true, httpStatus: 500 });
    }
    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1;
      throw directoryError("Rate limit", "RATE_LIMITED", { retryable: true, httpStatus: 429 });
    }
    const planned = this.failInsert.get(email);
    if (planned && planned.remaining > 0) {
      planned.remaining -= 1;
      throw directoryError(planned.message, planned.code === 429 ? "RATE_LIMITED" : "NETWORK_ERROR", {
        retryable: planned.code >= 500 || planned.code === 429,
        httpStatus: planned.code
      });
    }
    if (this.users.has(email)) {
      throw directoryError("Entity already exists", "ACCOUNT_ALREADY_EXISTS", { httpStatus: 409 });
    }
    const created = { id: `google-${this.insertCalls.length}`, primaryEmail: email, givenName: input.givenName, familyName: input.familyName, suspended: false };
    this.users.set(email, created);
    return created;
  }

  async setPassword(email: string, password: string, changePasswordAtNextLogin: boolean): Promise<void> {
    const key = email.toLowerCase();
    this.setPasswordCalls.push({
      email: key,
      changePasswordAtNextLogin,
      passwordLength: password.length
    });
    if (!this.users.has(key)) {
      throw directoryError("User not found", "WORKSPACE_USER_INVALID", { httpStatus: 404 });
    }
  }

  async listUsers(): Promise<DirectoryUser[]> {
    return [...this.users.values()];
  }

  async getUsage() {
    return {
      totalUsers: this.users.size,
      remainingLicenses: Math.max(0, 1000 - this.users.size),
      remainingUnavailableReason: null
    };
  }
}
