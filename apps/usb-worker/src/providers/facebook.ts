import type { WePlayScreenKind } from "../weplayWindow.js";
import type { ProviderLoginAdapter } from "./types.js";

export const facebookLoginAdapter: ProviderLoginAdapter = {
  provider: "FACEBOOK",
  resourceId: "login_facebook",
  isProviderScreen(kind: WePlayScreenKind) {
    return kind === "provider_facebook";
  }
};
