import { facebookLoginAdapter } from "./facebook.js";
import { googleLoginAdapter } from "./google.js";
import type { OauthLoginProvider, ProviderLoginAdapter } from "./types.js";
import { xLoginAdapter } from "./x.js";

export type { OauthLoginProvider, ProviderLoginAdapter } from "./types.js";
export { isVerifiedWePlaySession } from "./types.js";

const ADAPTERS: Record<OauthLoginProvider, ProviderLoginAdapter> = {
  GOOGLE: googleLoginAdapter,
  FACEBOOK: facebookLoginAdapter,
  X: xLoginAdapter
};

export function providerLoginAdapter(provider: string): ProviderLoginAdapter | null {
  if (provider === "GOOGLE" || provider === "FACEBOOK" || provider === "X") {
    return ADAPTERS[provider];
  }
  return null;
}
