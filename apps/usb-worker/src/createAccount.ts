import { adb } from "./adb.js";

export class CreateAccountFailed extends Error {
  readonly errorCode:
    | "ACCOUNT_ALREADY_EXISTS"
    | "AUTOMATION_NOT_INSPECTED"
    | "SIGNUP_FAILED"
    | "UNEXPECTED_SCREEN"
    | "UNKNOWN_STATE";
  constructor(errorCode: CreateAccountFailed["errorCode"], message: string) {
    super(message);
    this.name = "CreateAccountFailed";
    this.errorCode = errorCode;
  }
}

function currentFocus(dump: string): string {
  const match = dump.match(/mCurrentFocus=Window\{[^}]+\}/);
  return match?.[0] ?? "";
}

export async function inspectCreateAccount(serial: string, loginProvider: string): Promise<never> {
  await adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(() => undefined);
  const dump = await adb(serial, "shell", "dumpsys", "window");
  const focus = currentFocus(dump);
  if (/BaseVoiceRoomActivity|module\.main\.MainActivity/i.test(focus)) {
    throw new CreateAccountFailed(
      "ACCOUNT_ALREADY_EXISTS",
      `Device already has a WePlay session (${focus}). Log out on the phone before creating a new account.`
    );
  }
  if (/StartActivity|login/i.test(focus)) {
    throw new CreateAccountFailed(
      "AUTOMATION_NOT_INSPECTED",
      `StartActivity is visible for ${loginProvider}, but the Google/Facebook/X/Phone tap path is not verified on this device yet. Refusing to report success.`
    );
  }
  throw new CreateAccountFailed(
    "UNEXPECTED_SCREEN",
    `Expected WePlay login (StartActivity) to create an account. Focus=${focus || "unknown"}`
  );
}
