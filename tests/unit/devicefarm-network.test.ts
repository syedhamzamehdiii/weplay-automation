import { describe, expect, it } from "vitest";
import { isTransientAwsNetworkError } from "../../apps/api/src/devicefarm/networkError.js";

describe("Device Farm AWS network errors", () => {
  it("treats DNS lookup failures as retryable", () => {
    const error = Object.assign(new Error("getaddrinfo ENOTFOUND devicefarm.us-west-2.amazonaws.com"), {
      code: "ENOTFOUND"
    });
    expect(isTransientAwsNetworkError(error)).toBe(true);
  });

  it("does not retry WePlay or Google flow errors", () => {
    expect(isTransientAwsNetworkError(new Error("Google presented a security challenge (captcha)"))).toBe(false);
  });
});
