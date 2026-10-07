import { describe, expect, it } from "vitest";
import { deviceFarmWorkerFingerprint } from "../../apps/api/src/devicefarm/packageZip.js";

describe("Device Farm worker package fingerprint", () => {
  it("hashes the local Python worker into a stable sha256", async () => {
    const first = await deviceFarmWorkerFingerprint();
    const second = await deviceFarmWorkerFingerprint();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});
