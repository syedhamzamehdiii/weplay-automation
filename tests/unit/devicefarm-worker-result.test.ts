import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  extractProvisioningResultFromZip,
  parseProvisioningResultJson
} from "../../apps/api/src/devicefarm/workerResult.js";

describe("Device Farm worker result parsing", () => {
  it("parses provisioning-result JSON without treating ACTION_REQUIRED as success", () => {
    const failed = parseProvisioningResultJson(
      JSON.stringify({
        ok: false,
        error: "ACTION_REQUIRED",
        errorMessage: "Google presented a security challenge while adding the Workspace account (verify it's you).",
        weplayInstalled: false,
        googleAccountPresent: false
      })
    );
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBe("ACTION_REQUIRED");
    expect(failed?.errorMessage).toMatch(/verify it's you/i);
    expect(failed?.joinedRoom).toBe(false);
  });

  it("parses a verified session that includes WePlay user id and room join", () => {
    const parsed = parseProvisioningResultJson(
      JSON.stringify({
        ok: true,
        weplayUserId: "88223344",
        joinedRoom: true,
        screen: "weplay_room",
        weplayInstalled: true,
        googleAccountPresent: true,
        playStoreAccountMatchesExpected: true
      })
    );
    expect(parsed?.ok).toBe(true);
    expect(parsed?.weplayUserId).toBe("88223344");
    expect(parsed?.joinedRoom).toBe(true);
    expect(parsed?.playStoreAccountMatchesExpected).toBe(true);
  });

  it("parses Device Farm managed Play identity as identityOk without treating it as Workspace", () => {
    const parsed = parseProvisioningResultJson(
      JSON.stringify({
        ok: true,
        weplayUserId: "88223344",
        playStoreAccountMatchesExpected: false,
        playStoreIdentityOk: true,
        playStoreChannel: "devicefarm_managed_play",
        playStoreAccount: "work-***@android-for-work.gserviceaccount.com",
        weplayInstalled: true,
        googleAccountPresent: true,
        screen: "weplay_main"
      })
    );
    expect(parsed?.playStoreAccountMatchesExpected).toBe(false);
    expect(parsed?.playStoreIdentityOk).toBe(true);
    expect(parsed?.playStoreChannel).toBe("devicefarm_managed_play");
  });

  it("parses a multi-account Pixel result", () => {
    const parsed = parseProvisioningResultJson(
      JSON.stringify({
        ok: true,
        weplayInstalled: true,
        playStoreIdentityOk: true,
        accounts: [
          { workspaceEmail: "hamza@example.com", ok: true, weplayUserId: "1", googleAccountPresent: true, screen: "weplay_main" },
          { workspaceEmail: "arjun@example.com", ok: true, weplayUserId: "2", googleAccountPresent: true, screen: "weplay_main" }
        ]
      })
    );
    expect(parsed?.accounts).toHaveLength(2);
    expect(parsed?.accounts?.[1]?.weplayUserId).toBe("2");
  });

  it("extracts provisioning-result.json from a Device Farm customer artifacts zip", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "weplay-df-zip-"));
    const jsonPath = path.join(dir, "provisioning-result.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        ok: false,
        error: "ACTION_REQUIRED",
        errorMessage: "verify it's you",
        weplayInstalled: false,
        googleAccountPresent: false
      })
    );
    const zipPath = path.join(dir, "customer-artifacts.zip");
    execFileSync("zip", ["-j", zipPath, jsonPath]);
    const { readFileSync } = await import("node:fs");
    const parsed = await extractProvisioningResultFromZip(readFileSync(zipPath));
    expect(parsed?.error).toBe("ACTION_REQUIRED");
    expect(parsed?.ok).toBe(false);
  });
});
