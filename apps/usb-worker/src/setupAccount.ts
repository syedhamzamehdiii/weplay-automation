import { adb, sleep } from "./adb.js";
import {
  activityDump,
  bringWePlayToFront,
  findLoginButtonCenter,
  isWePlayPhoneOtpDump,
  providerPauseCode,
  readFocusedScreen,
  tap,
  wakeDevice,
  type WePlayScreenKind
} from "./weplayWindow.js";
import { isVerifiedWePlaySession, providerLoginAdapter } from "./providers/index.js";

export class SetupFailed extends Error {
  readonly errorCode:
    | "ACCOUNT_ALREADY_EXISTS"
    | "AUTOMATION_NOT_INSPECTED"
    | "VERIFICATION_REQUIRED"
    | "PERMISSION_REQUIRED"
    | "UNEXPECTED_SCREEN"
    | "UNKNOWN_STATE"
    | "INVALID_CONFIGURATION";
  constructor(errorCode: SetupFailed["errorCode"], message: string) {
    super(message);
    this.name = "SetupFailed";
    this.errorCode = errorCode;
  }
}

const WAIT_FOR_OPERATOR_MS = 120_000;
const POLL_MS = 2000;

function isLoggedIn(kind: WePlayScreenKind): boolean {
  return isVerifiedWePlaySession(kind);
}

function isProviderOrPermission(kind: WePlayScreenKind): boolean {
  return providerPauseCode(kind) !== null;
}

async function tapLoginProvider(
  serial: string,
  provider: string,
  onProgress: (message: string) => Promise<void>,
  onKeepAlive: () => Promise<void>
): Promise<void> {
  const adapter = providerLoginAdapter(provider);
  if (!adapter) {
    throw new SetupFailed("INVALID_CONFIGURATION", `Cannot tap login for provider ${provider}`);
  }
  let center: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dump = await activityDump(serial);
    center = findLoginButtonCenter(dump, adapter.provider);
    if (center) {
      break;
    }
    await onKeepAlive();
    await sleep(800);
  }
  if (!center) {
    throw new SetupFailed(
      "AUTOMATION_NOT_INSPECTED",
      `WePlay ${adapter.provider} control was not in the dumpsys tree. ${adapter.resourceId} is a string resource, not a StartActivity view ID. Need WejoyLargeLoginBtnView under login_vertical_btn_layout. Operator can tap ${adapter.provider} on the device, then Resume Setup.`
    );
  }
  await onProgress(`Tapping WePlay ${adapter.provider} at ${center.x},${center.y}`);
  await tap(serial, center.x, center.y);
  let afterScreen = await readFocusedScreen(serial);
  for (let i = 0; i < 10; i += 1) {
    if (afterScreen.focus && afterScreen.kind !== "weplay_login" && afterScreen.kind !== "other") {
      break;
    }
    await onKeepAlive();
    await sleep(400);
    afterScreen = await readFocusedScreen(serial);
  }
  const afterDump = await activityDump(serial);
  await onProgress(`After ${adapter.provider} tap: ${afterScreen.kind} ${afterScreen.focus || "unknown"}`);
  if (isWePlayPhoneOtpDump(afterDump) || /LoginPhone|login\.phone|login_phone/i.test(afterScreen.focus)) {
    throw new SetupFailed(
      "AUTOMATION_NOT_INSPECTED",
      `Tap at ${center.x},${center.y} opened WePlay phone OTP, not ${adapter.provider}. Refusing to continue.`
    );
  }
  if (adapter.provider === "GOOGLE" && (afterScreen.kind === "provider_facebook" || afterScreen.kind === "provider_x")) {
    throw new SetupFailed(
      "AUTOMATION_NOT_INSPECTED",
      `Tap at ${center.x},${center.y} opened ${afterScreen.kind} instead of Google. Refusing to continue.`
    );
  }
}

async function waitForVerifiedSession(
  serial: string,
  loginProvider: string,
  onProgress: (message: string) => Promise<void>,
  onKeepAlive: () => Promise<void>
): Promise<{ screen: string }> {
  const deadline = Date.now() + WAIT_FOR_OPERATOR_MS;
  let lastKind = "";
  while (Date.now() < deadline) {
    await onKeepAlive();
    const screen = await readFocusedScreen(serial);
    if (screen.kind !== lastKind) {
      await onProgress(`Waiting for WePlay after ${loginProvider}: ${screen.kind}`);
      lastKind = screen.kind;
    }
    if (isLoggedIn(screen.kind)) {
      await onProgress(`Verified WePlay session (${screen.kind})`);
      return { screen: screen.focus };
    }
    if (screen.kind === "weplay_onboarding") {
      await onProgress(`WePlay onboarding visible; waiting for MainActivity. Focus=${screen.focus}`);
    }
    await sleep(POLL_MS);
  }
  const screen = await readFocusedScreen(serial);
  if (isLoggedIn(screen.kind)) {
    await onProgress(`Verified WePlay session (${screen.kind})`);
    return { screen: screen.focus };
  }
  const code = providerPauseCode(screen.kind) ?? "VERIFICATION_REQUIRED";
  throw new SetupFailed(
    code,
    `Still waiting for you to finish ${loginProvider} on the phone (Chrome/Google). Do not click Resume until WePlay is open. Last focus=${screen.focus || "unknown"}`
  );
}

export async function provisionSetup(
  serial: string,
  loginProvider: string,
  resume: boolean,
  onProgress: (message: string) => Promise<void>,
  onKeepAlive: () => Promise<void> = async () => undefined
): Promise<{ screen: string }> {
  if (loginProvider === "PHONE") {
    throw new SetupFailed("INVALID_CONFIGURATION", "Phone/OTP provisioning is not allowed in this flow");
  }

  await wakeDevice(serial);
  await bringWePlayToFront(serial);

  let screen = await readFocusedScreen(serial);
  if (screen.kind === "status_bar") {
    await adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(() => undefined);
    await sleep(800);
    await bringWePlayToFront(serial);
    screen = await readFocusedScreen(serial);
  }

  await onProgress(`Screen ${screen.kind}: ${screen.focus || "unknown"}`);

  if (isLoggedIn(screen.kind)) {
    if (!resume) {
      throw new SetupFailed(
        "ACCOUNT_ALREADY_EXISTS",
        `Device already has a WePlay session (${screen.focus}). Log out on the phone before provisioning the next identity.`
      );
    }
    await onProgress(`Verified WePlay session (${screen.kind})`);
    return { screen: screen.focus };
  }

  if (isProviderOrPermission(screen.kind)) {
    await onProgress(
      `${loginProvider} is still on the phone. Finish it there; this job will wait up to 2 minutes for WePlay.`
    );
    return waitForVerifiedSession(serial, loginProvider, onProgress, onKeepAlive);
  }

  if (screen.kind !== "weplay_login" && screen.kind !== "weplay_onboarding") {
    throw new SetupFailed(
      "UNEXPECTED_SCREEN",
      `Expected WePlay login or session. Focus=${screen.focus || "unknown"}`
    );
  }

  if (screen.kind === "weplay_login") {
    await tapLoginProvider(serial, loginProvider, onProgress, onKeepAlive);
  }

  return waitForVerifiedSession(serial, loginProvider, onProgress, onKeepAlive);
}
