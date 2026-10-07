import type { WePlayScreenKind } from "../weplayWindow.js";

export type OauthLoginProvider = "GOOGLE" | "FACEBOOK" | "X";

export interface ProviderLoginAdapter {
  readonly provider: OauthLoginProvider;
  readonly resourceId: string;
  isProviderScreen(kind: WePlayScreenKind): boolean;
}

export function isVerifiedWePlaySession(kind: WePlayScreenKind): boolean {
  return kind === "weplay_main" || kind === "weplay_room";
}
