import type { Account } from "./types";

export type OauthProvider = "GOOGLE" | "FACEBOOK" | "X";

export const OAUTH_PROVIDERS: OauthProvider[] = ["GOOGLE", "FACEBOOK", "X"];

export function providerLabel(provider: string): string {
  if (provider === "GOOGLE") {
    return "Google";
  }
  if (provider === "FACEBOOK") {
    return "Facebook";
  }
  if (provider === "X") {
    return "X";
  }
  return provider;
}

export function identityLabel(account: Account): string {
  const metadata = account.metadata ?? {};
  const email = String(metadata.workspaceEmail || metadata.identityEmail || "").trim();
  const handle = String(metadata.identityHandle || "").trim();
  if (email) {
    return email;
  }
  if (handle) {
    return handle.startsWith("@") ? handle : `@${handle}`;
  }
  return "—";
}

export function deviceFarmEmail(account: Account): string {
  const metadata = account.metadata ?? {};
  const workspace = String(metadata.workspaceEmail || "").trim();
  if (workspace) {
    return workspace;
  }
  if (account.loginProvider === "GOOGLE") {
    return String(metadata.identityEmail || "").trim();
  }
  return "";
}

export function canStartDeviceFarm(account: Account): boolean {
  if (!deviceFarmEmail(account)) {
    return false;
  }
  if (account.loginProvider !== "GOOGLE") {
    return false;
  }
  if (account.status === "READY" || account.status === "SUCCESS" || account.status === "DISABLED") {
    return false;
  }
  return true;
}

export function weplayName(account: Account): string {
  const metadata = account.metadata ?? {};
  const name = String(metadata.weplayName || metadata.weplayDisplayName || account.displayName || "").trim();
  if (name) {
    return name;
  }
  return String(metadata.weplayUserId || "").trim() || "—";
}

export function isWePlaySignedIn(account: Account): boolean {
  const metadata = account.metadata ?? {};
  if (metadata.sessionVerified === true) {
    return true;
  }
  if (typeof metadata.weplayUserId === "string" && metadata.weplayUserId.trim()) {
    return true;
  }
  return account.status === "READY" || account.status === "SUCCESS";
}

export function progressText(account: Account): string {
  const metadata = account.metadata ?? {};
  if (typeof metadata.setupProgress === "string" && metadata.setupProgress.trim()) {
    return metadata.setupProgress;
  }
  if (typeof metadata.creationProgress === "string" && metadata.creationProgress.trim()) {
    return metadata.creationProgress;
  }
  return "—";
}
