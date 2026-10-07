import { z } from "zod";

export const DEFAULT_ALLOWED_DURATIONS_MS = [60_000, 180_000, 300_000, 900_000];
export const DEFAULT_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_JOB_RETRIES = 3;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONTROLLER_TICK_MS = 1_000;
export const DEFAULT_JOB_STALE_MS = 120_000;
export const DEFAULT_WORKER_POLL_MS = 1_000;
export const DEFAULT_API_PORT = 3001;
export const DEFAULT_WORKSPACE_PROVISION_CONCURRENCY = 4;
export const DEFAULT_WORKSPACE_PROVISION_MAX_RETRIES = 5;
export const DEFAULT_WORKSPACE_PROVISION_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_DEVICEFARM_REGION = "us-west-2";
export const DEFAULT_DEVICEFARM_JOB_TIMEOUT_MINUTES = 30;
export const DEFAULT_DEVICEFARM_PIN = "1234";
export const GOOGLE_WORKSPACE_DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user";

const csvInts = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) {
      return DEFAULT_ALLOWED_DURATIONS_MS;
    }
    return value
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  });

export const envSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  API_HOST: z.string().optional().default("0.0.0.0"),
  API_PORT: z.coerce.number().optional().default(DEFAULT_API_PORT),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().optional().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(8),
  JWT_EXPIRES_IN: z.string().optional().default("12h"),
  WORKER_TOKEN_SECRET: z.string().min(8),
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().optional().default(DEFAULT_HEARTBEAT_TIMEOUT_MS),
  CONTROLLER_TICK_MS: z.coerce.number().optional().default(DEFAULT_CONTROLLER_TICK_MS),
  JOB_STALE_MS: z.coerce.number().optional().default(DEFAULT_JOB_STALE_MS),
  MAX_JOB_RETRIES: z.coerce.number().optional().default(DEFAULT_MAX_JOB_RETRIES),
  DEFAULT_INTERVAL_MS: z.coerce.number().optional().default(DEFAULT_INTERVAL_MS),
  ALLOWED_DURATIONS_MS: csvInts,
  INITIAL_ADMIN_USERNAME: z.string().optional().default("admin"),
  INITIAL_ADMIN_PASSWORD: z.string().optional().default("changeme"),
  GOOGLE_WORKSPACE_DOMAIN: z.string().optional().default(""),
  GOOGLE_WORKSPACE_ADMIN_EMAIL: z.string().optional().default(""),
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE: z.string().optional().default(""),
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: z.string().optional().default(""),
  GOOGLE_WORKSPACE_PROVISION_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(DEFAULT_WORKSPACE_PROVISION_CONCURRENCY),
  GOOGLE_WORKSPACE_PROVISION_MAX_RETRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(DEFAULT_WORKSPACE_PROVISION_MAX_RETRIES),
  GOOGLE_WORKSPACE_PROVISION_INITIAL_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .default(DEFAULT_WORKSPACE_PROVISION_INITIAL_BACKOFF_MS),
  AWS_REGION: z.string().optional().default(DEFAULT_DEVICEFARM_REGION),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  AWS_SESSION_TOKEN: z.string().optional().default(""),
  AWS_PROFILE: z.string().optional().default(""),
  DEVICEFARM_REGION: z.string().optional().default(DEFAULT_DEVICEFARM_REGION),
  DEVICEFARM_PROJECT_ARN: z.string().optional().default(""),
  DEVICEFARM_DEVICE_POOL_ARN: z.string().optional().default(""),
  DEVICEFARM_APP_ARN: z.string().optional().default(""),
  DEVICEFARM_APP_PATH: z.string().optional().default(""),
  DEVICEFARM_TEST_PACKAGE_ARN: z.string().optional().default(""),
  DEVICEFARM_JOB_TIMEOUT_MINUTES: z.coerce
    .number()
    .int()
    .min(10)
    .max(150)
    .optional()
    .default(DEFAULT_DEVICEFARM_JOB_TIMEOUT_MINUTES),
  DEVICEFARM_DEVICE_PIN: z.string().optional().default(DEFAULT_DEVICEFARM_PIN),
  DEVICEFARM_JOIN_BATCH_SIZE: z.coerce.number().int().min(1).max(20).optional().default(2),
  WEPLAY_GAME_CODE: z.string().optional().default(""),
  WEPLAY_WORKSPACE_PASSWORD: z.string().optional().default(""),
  WEPLAY_PLAY_STORE_EMAIL: z.string().optional().default("")
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined>): AppEnv {
  return envSchema.parse(source);
}

export function parseDatabaseUrl(url: string): { dialect: "sqlite" | "postgres"; sqlitePath?: string; postgresUrl?: string } {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return { dialect: "postgres", postgresUrl: url };
  }
  if (url.startsWith("sqlite:")) {
    return { dialect: "sqlite", sqlitePath: url.slice("sqlite:".length) };
  }
  if (url.endsWith(".db") || url === ":memory:") {
    return { dialect: "sqlite", sqlitePath: url };
  }
  throw new Error(`Unsupported DATABASE_URL: ${url}`);
}
