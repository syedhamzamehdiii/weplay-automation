import { adb, sleep } from "./adb.js";

const PACKAGE = "com.wejoy.weplay.ar";

/** Inspected on Oppo CPH2083 720x1520: Voice Room tab index 1, search_room_imv 544,96-608,160. */
const VOICE_ROOM_TAB = { x: 216, y: 1371 };
const SEARCH = { x: 576, y: 128 };

export class JoinFailed extends Error {
  readonly errorCode: "ROOM_NOT_FOUND" | "WORKER_OFFLINE" | "UNKNOWN_STATE";
  constructor(errorCode: JoinFailed["errorCode"], message: string) {
    super(message);
    this.name = "JoinFailed";
    this.errorCode = errorCode;
  }
}

async function tap(serial: string, x: number, y: number): Promise<void> {
  await adb(serial, "shell", "input", "tap", String(x), String(y));
}

async function windowDump(serial: string): Promise<string> {
  return adb(serial, "shell", "dumpsys", "window");
}

async function activityDump(serial: string): Promise<string> {
  return adb(serial, "shell", "dumpsys", "activity", "top");
}

function currentFocus(dump: string): string {
  const match = dump.match(/mCurrentFocus=Window\{[^}]+\}/);
  return match?.[0] ?? "";
}

function inVoiceRoom(focusLine: string): boolean {
  return /BaseVoiceRoomActivity|voiceroom\.main/i.test(focusLine);
}

function inMain(focusLine: string): boolean {
  return /module\.main\.MainActivity/i.test(focusLine);
}

function confirmFromDialogFrame(dump: string): { x: number; y: number } | null {
  const frames = [...dump.matchAll(/Window\{[^}]+u0 com\.wejoy\.weplay\.ar[^\n]*\n(?:.*\n){0,20}?mFrame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g)];
  for (const match of frames) {
    const left = Number(match[1]);
    const top = Number(match[2]);
    const right = Number(match[3]);
    const bottom = Number(match[4]);
    const width = right - left;
    const height = bottom - top;
    if (width >= 400 && width <= 700 && height >= 200 && height <= 500) {
      return {
        x: Math.round(left + width * 0.75),
        y: Math.round(bottom - 50)
      };
    }
  }
  return null;
}

async function typeRoomId(serial: string, roomId: string): Promise<void> {
  const safe = roomId.replace(/[^A-Za-z0-9]/g, "");
  if (!safe) {
    throw new JoinFailed("ROOM_NOT_FOUND", "Room ID has no typeable characters");
  }
  await adb(serial, "shell", "input", "text", safe);
}

async function bringWePlayToFront(serial: string): Promise<void> {
  const focusLine = currentFocus(await windowDump(serial));
  if (focusLine.includes(PACKAGE)) {
    return;
  }
  await adb(serial, "shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1");
  await sleep(2000);
}

async function ensureMainActivity(serial: string): Promise<void> {
  await bringWePlayToFront(serial);
  for (let i = 0; i < 12; i += 1) {
    const focusLine = currentFocus(await windowDump(serial));
    if (inMain(focusLine)) {
      return;
    }
    if (!focusLine.includes(PACKAGE)) {
      await bringWePlayToFront(serial);
      continue;
    }
    await adb(serial, "shell", "input", "keyevent", "4");
    await sleep(700);
  }
  if (!inMain(currentFocus(await windowDump(serial)))) {
    throw new JoinFailed("UNKNOWN_STATE", "Could not reach WePlay home");
  }
}

export async function joinRoom(serial: string, roomId: string): Promise<string> {
  await adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(() => undefined);
  await bringWePlayToFront(serial);

  let focusLine = currentFocus(await windowDump(serial));
  if (inVoiceRoom(focusLine)) {
    const top = await activityDump(serial);
    if (top.includes(roomId)) {
      return focusLine;
    }
    await adb(serial, "shell", "input", "keyevent", "4");
    await sleep(1000);
  }

  await ensureMainActivity(serial);
  await tap(serial, VOICE_ROOM_TAB.x, VOICE_ROOM_TAB.y);
  await sleep(1500);
  await tap(serial, SEARCH.x, SEARCH.y);
  await sleep(1800);
  await typeRoomId(serial, roomId);
  await sleep(500);

  const confirm = confirmFromDialogFrame(await windowDump(serial)) ?? { x: 512, y: 630 };
  await tap(serial, confirm.x, confirm.y);
  await sleep(3500);

  focusLine = currentFocus(await windowDump(serial));
  if (!focusLine.includes(PACKAGE)) {
    throw new JoinFailed("UNKNOWN_STATE", `WePlay lost focus: ${focusLine || "unknown"}`);
  }
  if (inVoiceRoom(focusLine)) {
    return focusLine;
  }
  throw new JoinFailed("ROOM_NOT_FOUND", `Did not enter room ${roomId}. Focus=${focusLine}`);
}
