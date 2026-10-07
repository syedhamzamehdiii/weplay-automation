import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceFarmWorkerResult } from "./client.js";
import { removeTempPath } from "./packageZip.js";

const execFileAsync = promisify(execFile);

export function parseProvisioningResultJson(text: string): DeviceFarmWorkerResult | null {
  try {
    const parsed = JSON.parse(text) as DeviceFarmWorkerResult;
    return {
      ok: parsed.ok === true,
      workspaceEmail: parsed.workspaceEmail,
      workspaceEmails: Array.isArray(parsed.workspaceEmails) ? parsed.workspaceEmails : undefined,
      weplayUserId: parsed.weplayUserId ?? null,
      screen: parsed.screen ?? null,
      activity: parsed.activity ?? null,
      weplayInstalled: parsed.weplayInstalled,
      googleAccountPresent: parsed.googleAccountPresent,
      playStoreAccountMatchesExpected: parsed.playStoreAccountMatchesExpected === true,
      playStoreIdentityOk: parsed.playStoreIdentityOk === true,
      playStoreChannel: parsed.playStoreChannel ?? null,
      playStoreAccount: parsed.playStoreAccount ?? null,
      joinedRoom: parsed.joinedRoom === true,
      supportClicked: parsed.supportClicked === true,
      gameCodeSet: parsed.gameCodeSet === true,
      runMode: parsed.runMode ?? null,
      totalDurationMs: parsed.totalDurationMs ?? null,
      error: parsed.error ?? null,
      errorMessage: parsed.errorMessage ?? null,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : undefined
    };
  } catch {
    return null;
  }
}

export async function extractProvisioningResultFromZip(zipBytes: Buffer): Promise<DeviceFarmWorkerResult | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weplay-df-art-"));
  const zipPath = path.join(dir, "customer-artifacts.zip");
  try {
    await writeFile(zipPath, zipBytes);
    const listed = await execFileAsync("unzip", ["-Z", "-1", zipPath], { timeout: 15_000 });
    const entry = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().includes("provisioning-result.json"));
    if (!entry) {
      return null;
    }
    const extracted = await execFileAsync("unzip", ["-p", zipPath, entry], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    return parseProvisioningResultJson(extracted.stdout);
  } catch {
    return null;
  } finally {
    await removeTempPath(zipPath);
  }
}
