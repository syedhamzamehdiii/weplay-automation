import type { WePlayScreenKind } from "../weplayWindow.js";
import type { ProviderLoginAdapter } from "./types.js";

export const googleLoginAdapter: ProviderLoginAdapter = {
  provider: "GOOGLE",
  /** APK string resource name; StartActivity has no app:id/login_google. */
  resourceId: "login_google",
  isProviderScreen(kind: WePlayScreenKind) {
    return kind === "provider_google";
  }
};
