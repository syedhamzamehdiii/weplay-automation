import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "@weplay/config";
import { describeAwsCredentials, resolveAwsStaticCredentials } from "../../apps/api/src/devicefarm/credentials.js";

function testEnv(overrides: Record<string, string> = {}) {
  return loadEnv({
    DATABASE_URL: "sqlite::memory:",
    JWT_SECRET: "12345678",
    WORKER_TOKEN_SECRET: "12345678",
    ...overrides
  });
}

const AWS_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION"
] as const;

describe("AWS Device Farm credential diagnostic", () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    previous.clear();
  });

  function isolateAwsProcessEnv() {
    for (const key of AWS_ENV_KEYS) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  it("defaults to us-west-2 and reports missing credentials without values", () => {
    isolateAwsProcessEnv();
    const env = testEnv();
    const diagnostic = describeAwsCredentials(env);
    expect(diagnostic.region).toBe("us-west-2");
    expect(diagnostic.credentialsSource).toBe(diagnostic.sharedCredentialsFilePresent ? "shared-ini" : "none");
    expect(JSON.stringify(diagnostic)).not.toMatch(/AKIA/);
  });

  it("treats dotenv AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as an environment key pair", () => {
    const env = testEnv({
      AWS_REGION: "us-west-2",
      AWS_ACCESS_KEY_ID: "AKIATESTEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "unit-test-only-not-a-real-key"
    });
    const diagnostic = describeAwsCredentials(env);
    expect(diagnostic.credentialsAvailable).toBe(true);
    expect(diagnostic.credentialsSource).toBe("environment");
    expect(diagnostic.envAccessKeyIdSet).toBe(true);
    expect(diagnostic.envStaticKeyPairSet).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("AKIATESTEXAMPLE");
    expect(JSON.stringify(diagnostic)).not.toContain("unit-test-only-not-a-real-key");
    const resolved = resolveAwsStaticCredentials(env);
    expect(resolved?.accessKeyId).toBe("AKIATESTEXAMPLE");
    expect(resolved?.secretAccessKey).toBe("unit-test-only-not-a-real-key");
  });
});
