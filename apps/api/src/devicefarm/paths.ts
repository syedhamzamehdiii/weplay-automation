import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppEnv } from "@weplay/config";

export function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

export function devicefarmDir(): string {
  return path.join(repoRoot(), "devicefarm");
}

export function devicefarmSpecTemplatePath(): string {
  return path.join(devicefarmDir(), "test.yml");
}

export function deviceFarmConfigured(env: AppEnv): boolean {
  return Boolean(
    env.DEVICEFARM_PROJECT_ARN.trim() &&
      env.DEVICEFARM_DEVICE_POOL_ARN.trim() &&
      (env.DEVICEFARM_APP_ARN.trim() || (env.DEVICEFARM_APP_PATH.trim() && existsSync(resolveDeviceFarmAppPath(env))))
  );
}

export function resolveDeviceFarmAppPath(env: AppEnv): string {
  const file = env.DEVICEFARM_APP_PATH.trim();
  if (!file) {
    return "";
  }
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.resolve(repoRoot(), file);
}
