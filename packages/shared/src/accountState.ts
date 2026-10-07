import type { Account, AccountStatus } from "@weplay/types";

const ALLOWED: Record<AccountStatus, AccountStatus[]> = {
  NEW: ["CREATING", "SETUP_REQUIRED", "DISABLED"],
  CREATING: ["SETUP_REQUIRED", "CREATION_FAILED", "DISABLED"],
  CREATION_FAILED: ["CREATING", "DISABLED"],
  SETUP_REQUIRED: ["SETUP_IN_PROGRESS", "READY", "DISABLED", "ACTION_REQUIRED"],
  SETUP_IN_PROGRESS: ["READY", "SETUP_REQUIRED", "FAILED", "DISABLED", "NEEDS_REAUTH", "ACTION_REQUIRED"],
  ACTION_REQUIRED: ["SETUP_IN_PROGRESS", "SETUP_REQUIRED", "READY", "DISABLED", "FAILED", "NEEDS_REAUTH"],
  READY: ["PROCESSING", "DISABLED", "NEEDS_REAUTH", "OFFLINE", "SETUP_REQUIRED", "SETUP_IN_PROGRESS"],
  PROCESSING: ["SUCCESS", "FAILED", "NEEDS_REAUTH", "READY", "OFFLINE"],
  SUCCESS: ["PROCESSING", "READY", "DISABLED", "NEEDS_REAUTH", "OFFLINE"],
  FAILED: ["PROCESSING", "READY", "SETUP_REQUIRED", "NEEDS_REAUTH", "DISABLED", "SETUP_IN_PROGRESS", "ACTION_REQUIRED"],
  NEEDS_REAUTH: ["SETUP_IN_PROGRESS", "DISABLED"],
  DISABLED: ["READY", "SETUP_REQUIRED", "NEEDS_REAUTH", "NEW", "CREATION_FAILED", "CREATING", "ACTION_REQUIRED"],
  OFFLINE: ["READY", "SETUP_REQUIRED", "PROCESSING", "DISABLED", "NEEDS_REAUTH", "SUCCESS", "ACTION_REQUIRED"]
};

export function canTransitionAccount(from: AccountStatus, to: AccountStatus): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED[from].includes(to);
}

export function assertAccountTransition(from: AccountStatus, to: AccountStatus): void {
  if (!canTransitionAccount(from, to)) {
    throw new Error(`Invalid account transition: ${from} -> ${to}`);
  }
}

export function isAccountEligibleForSupport(account: Account): boolean {
  if (!account.enabled) {
    return false;
  }
  if (account.setupStatus !== "COMPLETED") {
    return false;
  }
  if (
    account.status === "NEEDS_REAUTH" ||
    account.status === "DISABLED" ||
    account.status === "SETUP_REQUIRED" ||
    account.status === "SETUP_IN_PROGRESS" ||
    account.status === "NEW" ||
    account.status === "CREATING" ||
    account.status === "CREATION_FAILED" ||
    account.status === "ACTION_REQUIRED"
  ) {
    return false;
  }
  return account.status === "READY" || account.status === "SUCCESS" || account.status === "FAILED" || account.status === "OFFLINE";
}
