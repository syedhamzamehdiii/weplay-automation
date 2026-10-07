import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateDeviceFarmSpec, resolvePlayStoreEmail, specContainsPlaintextSecret, toBase64 } from "../../apps/api/src/devicefarm/spec.js";

describe("Device Farm spec generation", () => {
  it("injects credentials as base64 and keeps the plaintext password out of the YAML", () => {
    const template = readFileSync(path.resolve("devicefarm/test.yml"), "utf8");
    const password = "TmpPassw0rd!not-for-git";
    const spec = generateDeviceFarmSpec({
      workspaceEmail: "hamza@example.com",
      playStoreEmail: "admin@example.com",
      workspacePassword: password,
      gameCode: "ROOM1234",
      template
    });
    expect(spec).toContain(toBase64("hamza@example.com"));
    expect(spec).toContain(toBase64("admin@example.com"));
    expect(spec).toContain("WEPLAY_GOOGLE_EMAILS");
    expect(spec).toContain(toBase64(password));
    expect(spec).toContain(toBase64("ROOM1234"));
    expect(spec).toContain("WEPLAY_PLAY_STORE_EMAIL");
    expect(specContainsPlaintextSecret(spec, password)).toBe(false);
    expect(spec).not.toContain("Paste this into the AWS Device Farm");
    expect(spec).toContain("tests/test_weplay_devicefarm_provision.py");
    expect(spec).toContain("locksettings set-pin");
    expect(spec).toContain("locksettings clear --old");
  });

  it("injects a comma-separated Workspace email batch as base64", () => {
    const template = readFileSync(path.resolve("devicefarm/test.yml"), "utf8");
    const spec = generateDeviceFarmSpec({
      workspaceEmail: "hamza@example.com",
      workspaceEmails: ["hamza@example.com", "arjun@example.com"],
      playStoreEmail: "admin@example.com",
      workspacePassword: "TmpPassw0rd!not-for-git",
      gameCode: "",
      template
    });
    expect(spec).toContain(toBase64("hamza@example.com,arjun@example.com"));
    expect(spec).not.toContain("arjun@example.com");
  });

  it("resolves Play Store email from admin or explicit override", () => {
    expect(resolvePlayStoreEmail({ GOOGLE_WORKSPACE_ADMIN_EMAIL: "admin@example.com" }, "hamza@example.com")).toBe(
      "admin@example.com"
    );
    expect(
      resolvePlayStoreEmail(
        { WEPLAY_PLAY_STORE_EMAIL: "play@example.com", GOOGLE_WORKSPACE_ADMIN_EMAIL: "admin@example.com" },
        "hamza@example.com"
      )
    ).toBe("play@example.com");
    expect(resolvePlayStoreEmail({}, "hamza@example.com")).toBe("hamza@example.com");
  });
});
