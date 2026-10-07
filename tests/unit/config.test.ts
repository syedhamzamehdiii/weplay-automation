import { describe, expect, it } from "vitest";
import { loadEnv, parseDatabaseUrl } from "@weplay/config";

describe("config", () => {
  it("parses sqlite and postgres urls", () => {
    expect(parseDatabaseUrl("sqlite:./data/weplay.db")).toEqual({
      dialect: "sqlite",
      sqlitePath: "./data/weplay.db"
    });
    expect(parseDatabaseUrl("postgres://u:p@localhost:5432/weplay").dialect).toBe("postgres");
  });

  it("loads duration options from env without hard-coded account counts", () => {
    const env = loadEnv({
      DATABASE_URL: "sqlite::memory:",
      JWT_SECRET: "12345678",
      WORKER_TOKEN_SECRET: "12345678",
      ALLOWED_DURATIONS_MS: "60000,180000,300000,900000"
    });
    expect(env.ALLOWED_DURATIONS_MS).toEqual([60000, 180000, 300000, 900000]);
    expect(env.DEFAULT_INTERVAL_MS).toBe(5000);
    expect(env.DEVICEFARM_REGION).toBe("us-west-2");
    expect(env.DEVICEFARM_JOB_TIMEOUT_MINUTES).toBe(30);
  });
});
