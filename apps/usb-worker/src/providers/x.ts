import type { WePlayScreenKind } from "../weplayWindow.js";
import type { ProviderLoginAdapter } from "./types.js";

export const xLoginAdapter: ProviderLoginAdapter = {
  provider: "X",
  resourceId: "login_twitter",
  isProviderScreen(kind: WePlayScreenKind) {
    return kind === "provider_x";
  }
};
