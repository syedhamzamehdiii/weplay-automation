import { describe, expect, it } from "vitest";
import { providerLoginAdapter } from "../../apps/usb-worker/src/providers/index.js";

describe("provider login adapters", () => {
  it("isolates Google, Facebook, and X login resource IDs", () => {
    expect(providerLoginAdapter("GOOGLE")).toMatchObject({ provider: "GOOGLE", resourceId: "login_google" });
    expect(providerLoginAdapter("FACEBOOK")).toMatchObject({ provider: "FACEBOOK", resourceId: "login_facebook" });
    expect(providerLoginAdapter("X")).toMatchObject({ provider: "X", resourceId: "login_twitter" });
    expect(providerLoginAdapter("PHONE")).toBeNull();
  });

  it("classifies only the matching provider screen", () => {
    expect(providerLoginAdapter("GOOGLE")?.isProviderScreen("provider_google")).toBe(true);
    expect(providerLoginAdapter("GOOGLE")?.isProviderScreen("provider_facebook")).toBe(false);
    expect(providerLoginAdapter("FACEBOOK")?.isProviderScreen("provider_facebook")).toBe(true);
    expect(providerLoginAdapter("X")?.isProviderScreen("provider_x")).toBe(true);
    expect(providerLoginAdapter("X")?.isProviderScreen("weplay_login")).toBe(false);
  });
});
