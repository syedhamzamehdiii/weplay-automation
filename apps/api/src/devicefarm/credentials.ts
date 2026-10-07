import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppEnv } from "@weplay/config";

export type AwsCredentialsSource = "environment" | "shared-ini" | "none";

export interface AwsCredentialsDiagnostic {
  region: string;
  credentialsAvailable: boolean;
  credentialsSource: AwsCredentialsSource;
  envAccessKeyIdSet: boolean;
  envStaticKeyPairSet: boolean;
  envSessionTokenSet: boolean;
  envProfileSet: boolean;
  sharedCredentialsFilePresent: boolean;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

export function deviceFarmRegion(env: Pick<AppEnv, "DEVICEFARM_REGION" | "AWS_REGION">): string {
  return firstNonEmpty(env.DEVICEFARM_REGION, env.AWS_REGION, process.env.AWS_REGION, process.env.AWS_DEFAULT_REGION) ||
    "us-west-2";
}

export function resolveAwsStaticCredentials(env: AppEnv): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} | null {
  const accessKeyId = firstNonEmpty(env.AWS_ACCESS_KEY_ID, process.env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = firstNonEmpty(env.AWS_SECRET_ACCESS_KEY, process.env.AWS_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: firstNonEmpty(env.AWS_SESSION_TOKEN, process.env.AWS_SESSION_TOKEN)
  };
}

export function describeAwsCredentials(env: AppEnv): AwsCredentialsDiagnostic {
  const staticKeys = resolveAwsStaticCredentials(env);
  const envProfileSet = Boolean(firstNonEmpty(env.AWS_PROFILE, process.env.AWS_PROFILE));
  const sharedCredentialsFilePresent = existsSync(path.join(os.homedir(), ".aws", "credentials"));
  let credentialsSource: AwsCredentialsSource = "none";
  if (staticKeys) {
    credentialsSource = "environment";
  } else if (sharedCredentialsFilePresent || envProfileSet) {
    credentialsSource = "shared-ini";
  }
  return {
    region: deviceFarmRegion(env),
    credentialsAvailable: credentialsSource !== "none",
    credentialsSource,
    envAccessKeyIdSet: Boolean(firstNonEmpty(env.AWS_ACCESS_KEY_ID, process.env.AWS_ACCESS_KEY_ID)),
    envStaticKeyPairSet: Boolean(staticKeys),
    envSessionTokenSet: Boolean(firstNonEmpty(env.AWS_SESSION_TOKEN, process.env.AWS_SESSION_TOKEN)),
    envProfileSet,
    sharedCredentialsFilePresent
  };
}

/** Copy dotenv-loaded AppEnv AWS keys onto process.env so the SDK default chain can see them. */
export function applyAwsEnvFromAppEnv(env: AppEnv): void {
  const region = deviceFarmRegion(env);
  if (region && !process.env.AWS_REGION) {
    process.env.AWS_REGION = region;
  }
  if (env.AWS_ACCESS_KEY_ID.trim() && !process.env.AWS_ACCESS_KEY_ID) {
    process.env.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID.trim();
  }
  if (env.AWS_SECRET_ACCESS_KEY.trim() && !process.env.AWS_SECRET_ACCESS_KEY) {
    process.env.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY.trim();
  }
  if (env.AWS_SESSION_TOKEN.trim() && !process.env.AWS_SESSION_TOKEN) {
    process.env.AWS_SESSION_TOKEN = env.AWS_SESSION_TOKEN.trim();
  }
  if (env.AWS_PROFILE.trim() && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = env.AWS_PROFILE.trim();
  }
}
