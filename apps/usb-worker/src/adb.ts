import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class AdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbError";
  }
}

export async function adb(serial: string | null, ...args: string[]): Promise<string> {
  const full = serial ? ["-s", serial, ...args] : args;
  try {
    const { stdout, stderr } = await execFileAsync("adb", full, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    throw new AdbError(err.stderr?.trim() || err.stdout?.trim() || err.message);
  }
}

export async function firstDeviceSerial(): Promise<string> {
  const output = await adb(null, "devices", "-l");
  const line = output
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.includes("\tdevice") || /\sdevice\s/.test(row));
  if (!line) {
    throw new AdbError("No ADB device connected");
  }
  return line.split(/\s+/)[0]!;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
