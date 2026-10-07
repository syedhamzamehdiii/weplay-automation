import { describe, expect, it } from "vitest";
import {
  assertAccountTransition,
  canTransitionAccount,
  canTransitionJob,
  isAccountEligibleForSupport,
  shouldRetry
} from "@weplay/shared";
import type { Account } from "@weplay/types";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "a",
    displayName: "A",
    loginProvider: "GOOGLE",
    status: "READY",
    setupStatus: "COMPLETED",
    workerId: "w",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    metadata: {},
    ...overrides
  };
}

describe("account state", () => {
  it("allows setup required to in progress to ready", async () => {
    expect(canTransitionAccount("SETUP_REQUIRED", "SETUP_IN_PROGRESS")).toBe(true);
    expect(canTransitionAccount("SETUP_IN_PROGRESS", "READY")).toBe(true);
    expect(() => assertAccountTransition("READY", "NEW")).toThrow();
  });

  it("allows WePlay creation then setup, and not skip to READY", () => {
    expect(canTransitionAccount("CREATING", "SETUP_REQUIRED")).toBe(true);
    expect(canTransitionAccount("CREATING", "CREATION_FAILED")).toBe(true);
    expect(canTransitionAccount("CREATION_FAILED", "CREATING")).toBe(true);
    expect(canTransitionAccount("CREATING", "READY")).toBe(false);
    expect(isAccountEligibleForSupport(account({ status: "CREATING", setupStatus: "NOT_STARTED" }))).toBe(false);
    expect(isAccountEligibleForSupport(account({ status: "CREATION_FAILED", setupStatus: "NOT_STARTED" }))).toBe(false);
  });

  it("pauses setup for operator verification and resumes to READY", () => {
    expect(canTransitionAccount("SETUP_IN_PROGRESS", "ACTION_REQUIRED")).toBe(true);
    expect(canTransitionAccount("ACTION_REQUIRED", "SETUP_IN_PROGRESS")).toBe(true);
    expect(canTransitionAccount("ACTION_REQUIRED", "READY")).toBe(true);
    expect(isAccountEligibleForSupport(account({ status: "ACTION_REQUIRED", setupStatus: "ACTION_REQUIRED" }))).toBe(
      false
    );
  });

  it("does not treat disabled or needs-reauth as eligible", () => {
    expect(isAccountEligibleForSupport(account({ status: "DISABLED", enabled: false }))).toBe(false);
    expect(isAccountEligibleForSupport(account({ status: "NEEDS_REAUTH" }))).toBe(false);
    expect(isAccountEligibleForSupport(account({ status: "READY" }))).toBe(true);
    expect(isAccountEligibleForSupport(account({ setupStatus: "REQUIRED", status: "SETUP_REQUIRED" }))).toBe(false);
  });
});

describe("job state", () => {
  it("allows queued to assigned to running to succeeded", () => {
    expect(canTransitionJob("QUEUED", "ASSIGNED")).toBe(true);
    expect(canTransitionJob("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionJob("ASSIGNED", "RUNNING")).toBe(true);
    expect(canTransitionJob("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canTransitionJob("SUCCEEDED", "RUNNING")).toBe(false);
  });
});

describe("retry policy", () => {
  it("retries network errors until max", () => {
    expect(shouldRetry("NETWORK_ERROR", 1, 3)).toBe(true);
    expect(shouldRetry("NETWORK_ERROR", 3, 3)).toBe(false);
  });

  it("does not retry auth or unknown state", () => {
    expect(shouldRetry("AUTH_REQUIRED", 1, 3)).toBe(false);
    expect(shouldRetry("UNKNOWN_STATE", 1, 3)).toBe(false);
    expect(shouldRetry("SUPPORT_FAILED", 1, 3)).toBe(false);
    expect(shouldRetry("SIGNUP_FAILED", 1, 3)).toBe(false);
    expect(shouldRetry("ACCOUNT_ALREADY_EXISTS", 1, 3)).toBe(false);
    expect(shouldRetry("UNEXPECTED_SCREEN", 1, 3)).toBe(false);
    expect(shouldRetry("VERIFICATION_REQUIRED", 1, 3)).toBe(false);
    expect(shouldRetry("PERMISSION_REQUIRED", 1, 3)).toBe(false);
    expect(shouldRetry("RATE_LIMITED", 1, 3)).toBe(true);
    expect(shouldRetry("APP_CRASHED", 1, 3)).toBe(true);
  });
});
