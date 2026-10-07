import { describe, expect, it } from "vitest";
import { mapGoogleDirectoryError } from "../../apps/api/src/google/directory.js";

describe("mapGoogleDirectoryError", () => {
  it("maps auto-assign license exhaustion as a non-retryable seat limit", () => {
    const mapped = mapGoogleDirectoryError({
      code: 403,
      message: "Insufficient licenses for one or more products that are set to automatically assign licenses to new users"
    });
    expect(mapped.errorCode).toBe("WORKSPACE_LICENSE_EXHAUSTED");
    expect(mapped.retryable).toBe(false);
  });

  it("maps domain user cap / unpaid subscription as a non-retryable seat limit", () => {
    const mapped = mapGoogleDirectoryError({
      code: 403,
      message: "Domain user limit reached. Start paid subscription."
    });
    expect(mapped.errorCode).toBe("WORKSPACE_LICENSE_EXHAUSTED");
    expect(mapped.retryable).toBe(false);
  });
});
