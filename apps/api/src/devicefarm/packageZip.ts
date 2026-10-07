import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { devicefarmDir } from "./paths.js";

const execFileAsync = promisify(execFile);

const FINGERPRINT_ROOTS = ["weplay_df", "tests", "requirements.txt", "test.yml"] as const;

async function listFingerprintFiles(root: string, relative: string): Promise<string[]> {
  const full = path.join(root, relative);
  const info = await stat(full).catch(() => null);
  if (!info) {
    return [];
  }
  if (info.isFile()) {
    return [relative];
  }
  const files: string[] = [];
  for (const entry of await readdir(full, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === ".venv" || entry.name === ".pytest_cache") {
      continue;
    }
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFingerprintFiles(root, child)));
      continue;
    }
    if (entry.name.endsWith(".py") || entry.name.endsWith(".txt") || entry.name.endsWith(".yml")) {
      files.push(child);
    }
  }
  return files;
}

export async function deviceFarmWorkerFingerprint(): Promise<string> {
  const root = devicefarmDir();
  const files: string[] = [];
  for (const relative of FINGERPRINT_ROOTS) {
    files.push(...(await listFingerprintFiles(root, relative)));
  }
  files.sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update(await readFile(path.join(root, relative)));
  }
  return hash.digest("hex");
}

export async function zipDeviceFarmTestPackage(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weplay-df-"));
  const zipPath = path.join(dir, "weplay-devicefarm-tests.zip");
  await execFileAsync(
    "zip",
    [
      "-r",
      zipPath,
      "requirements.txt",
      "weplay_df",
      "tests",
      "-x",
      "*__pycache__*",
      "*.pyc",
      "*.pytest_cache*",
      "*.venv*"
    ],
    { cwd: devicefarmDir() }
  );
  return zipPath;
}

export async function removeTempPath(filePath: string): Promise<void> {
  await rm(path.dirname(filePath), { recursive: true, force: true });
}
