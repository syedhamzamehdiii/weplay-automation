import { adb, sleep } from "./adb.js";
import { providerLoginAdapter } from "./providers/index.js";

export const WEPLAY_PACKAGE = "com.wejoy.weplay.ar";

export type WePlayScreenKind =
  | "weplay_login"
  | "weplay_main"
  | "weplay_room"
  | "weplay_onboarding"
  | "provider_google"
  | "provider_facebook"
  | "provider_x"
  | "permission"
  | "status_bar"
  | "other";

export interface ClassifiedScreen {
  kind: WePlayScreenKind;
  focus: string;
}

export function currentFocus(dump: string): string {
  const match = dump.match(/mCurrentFocus=Window\{[^}]+\}/);
  return match?.[0] ?? "";
}

export function classifyWePlayScreen(focus: string): ClassifiedScreen {
  const line = focus || "";
  if (/StatusBar|Keyguard|NotificationShade|com\.android\.systemui/i.test(line)) {
    return { kind: "status_bar", focus: line };
  }
  if (/packageinstaller|permissioncontroller|GrantPermissions|PERMISSION/i.test(line)) {
    return { kind: "permission", focus: line };
  }
  if (/com\.google\.android\.gms|accounts\.google|googlequicksearchbox|com\.android\.vending/i.test(line)) {
    return { kind: "provider_google", focus: line };
  }
  if (/CustomTabActivity|customtabs|com\.android\.chrome|org\.chromium\.chrome/i.test(line)) {
    return { kind: "provider_google", focus: line };
  }
  if (/facebook|fbauth|com\.facebook\./i.test(line)) {
    return { kind: "provider_facebook", focus: line };
  }
  if (/com\.twitter\.|twitter\.android|x\.com|com\.x\./i.test(line)) {
    return { kind: "provider_x", focus: line };
  }
  if (/BaseVoiceRoomActivity|voiceroom\.main/i.test(line)) {
    return { kind: "weplay_room", focus: line };
  }
  if (/module\.main\.MainActivity/i.test(line)) {
    return { kind: "weplay_main", focus: line };
  }
  if (/StartActivity|login\.start|module\.login/i.test(line)) {
    return { kind: "weplay_login", focus: line };
  }
  if (line.includes(WEPLAY_PACKAGE) || /com\.wepie\.wespy/i.test(line)) {
    return { kind: "weplay_onboarding", focus: line };
  }
  return { kind: "other", focus: line };
}

export function providerPauseCode(kind: WePlayScreenKind): "VERIFICATION_REQUIRED" | "PERMISSION_REQUIRED" | null {
  if (kind === "permission") {
    return "PERMISSION_REQUIRED";
  }
  if (kind === "provider_google" || kind === "provider_facebook" || kind === "provider_x") {
    return "VERIFICATION_REQUIRED";
  }
  return null;
}

function parseBounds(line: string): { left: number; top: number; right: number; bottom: number } | null {
  const bounds = line.match(/(\d+),(\d+)-(\d+),(\d+)/);
  if (!bounds) {
    return null;
  }
  return {
    left: Number(bounds[1]),
    top: Number(bounds[2]),
    right: Number(bounds[3]),
    bottom: Number(bounds[4])
  };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function centerOf(box: { left: number; top: number; right: number; bottom: number }): { x: number; y: number } {
  return {
    x: Math.round((box.left + box.right) / 2),
    y: Math.round((box.top + box.bottom) / 2)
  };
}

export interface LoginLayoutButton {
  x: number;
  y: number;
  textViewCount: number;
}

/** ColorOS uiautomator dump is a dummy [0,0][0,0] node. Login IDs in the APK are strings, not view IDs. */
export function dumpHasInspectedLoginButtons(dump: string): boolean {
  return dump.includes("login_vertical_btn_layout") && dump.includes("WejoyLargeLoginBtnView");
}

/**
 * `dumpsys activity <package>` often matches StartActivity in the activity record
 * without a View Hierarchy. Only accept a dump that actually contains the login buttons.
 */
export function selectActivityDump(pkgDump: string, topDump: string): string {
  if (dumpHasInspectedLoginButtons(topDump)) {
    return topDump;
  }
  if (dumpHasInspectedLoginButtons(pkgDump)) {
    return pkgDump;
  }
  return topDump;
}

export function isWePlayPhoneOtpDump(dump: string): boolean {
  return /app:id\/login_phone_number|app:id\/login_get_code_btn|login_phone_get_code|activity_wejoy_login_phone/i.test(
    dump
  );
}

function countDescendantTextViews(lines: string[], buttonIndex: number, buttonIndent: number): number {
  let count = 0;
  for (let i = buttonIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const indent = indentOf(line);
    if (indent <= buttonIndent && line.trim()) {
      break;
    }
    if (line.includes("CustomTextView") || /android\.widget\.TextView\{/.test(line)) {
      count += 1;
    }
  }
  return count;
}

/** Child buttons of a login layout; child bounds in dumpsys are relative to the parent. */
export function parseLoginLayoutButtons(dump: string, layoutId: string, childClass: string): LoginLayoutButton[] {
  const lines = dump.split("\n");
  const parentIndex = lines.findIndex((line) => line.includes(layoutId));
  if (parentIndex < 0) {
    return [];
  }
  const parent = parseBounds(lines[parentIndex]!);
  if (!parent) {
    return [];
  }
  const parentIndent = indentOf(lines[parentIndex]!);
  const buttons: LoginLayoutButton[] = [];
  for (let i = parentIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const indent = indentOf(line);
    if (indent <= parentIndent && line.trim()) {
      break;
    }
    if (!line.includes(childClass)) {
      continue;
    }
    const relative = parseBounds(line);
    if (!relative) {
      continue;
    }
    const center = centerOf({
      left: parent.left + relative.left,
      top: parent.top + relative.top,
      right: parent.left + relative.right,
      bottom: parent.top + relative.bottom
    });
    buttons.push({
      ...center,
      textViewCount: countDescendantTextViews(lines, i, indent)
    });
  }
  return buttons;
}

export function findViewCenter(dump: string, resourceId: string): { x: number; y: number } | null {
  const escaped = resourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idPattern = new RegExp(`(?:id/|#\\w+\\s+.*?id/)?${escaped}\\b`);
  for (const line of dump.split("\n")) {
    if (!idPattern.test(line) && !line.includes(resourceId)) {
      continue;
    }
    const box = parseBounds(line);
    if (!box) {
      continue;
    }
    return centerOf(box);
  }
  return null;
}

/**
 * Inspected on Oppo CPH2083 WePlay 6.4.5 StartActivity (screencap + dumpsys):
 * `login_google` / `login_facebook` / `login_twitter` / `login_phone` are string
 * resources, not view IDs. Buttons are unlabeled WejoyLargeLoginBtnView /
 * WejoySmallLoginBtnView. Vertical: Google then Facebook. Horizontal: X then Phone.
 */
export function findLoginButtonCenter(dump: string, provider: string): { x: number; y: number } | null {
  const large = parseLoginLayoutButtons(dump, "login_vertical_btn_layout", "WejoyLargeLoginBtnView");
  const small = parseLoginLayoutButtons(dump, "login_horizontal_btn_layout", "WejoySmallLoginBtnView");
  const chosen =
    provider === "GOOGLE"
      ? large[0]
      : provider === "FACEBOOK"
        ? large[1]
        : provider === "X"
          ? small[0]
          : undefined;
  return chosen ? { x: chosen.x, y: chosen.y } : null;
}

export function loginResourceId(provider: string): string | null {
  return providerLoginAdapter(provider)?.resourceId ?? null;
}

export async function windowDump(serial: string): Promise<string> {
  return adb(serial, "shell", "dumpsys", "window");
}

export async function activityDump(serial: string): Promise<string> {
  const topDump = await adb(serial, "shell", "dumpsys", "activity", "top");
  if (dumpHasInspectedLoginButtons(topDump)) {
    return topDump;
  }
  const pkgDump = await adb(serial, "shell", "dumpsys", "activity", WEPLAY_PACKAGE);
  return selectActivityDump(pkgDump, topDump);
}

export async function tap(serial: string, x: number, y: number): Promise<void> {
  await adb(serial, "shell", "input", "tap", String(x), String(y));
}

export async function wakeDevice(serial: string): Promise<void> {
  await adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(() => undefined);
}

export async function bringWePlayToFront(serial: string): Promise<void> {
  const focusLine = currentFocus(await windowDump(serial));
  const kind = classifyWePlayScreen(focusLine).kind;
  if (kind === "provider_google" || kind === "provider_facebook" || kind === "provider_x") {
    return;
  }
  if (focusLine.includes(WEPLAY_PACKAGE) || /com\.wepie\.wespy/i.test(focusLine)) {
    return;
  }
  await adb(serial, "shell", "monkey", "-p", WEPLAY_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1");
  await sleep(2000);
}

export async function readFocusedScreen(serial: string): Promise<ClassifiedScreen> {
  return classifyWePlayScreen(currentFocus(await windowDump(serial)));
}
