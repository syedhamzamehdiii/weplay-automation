import { readFileSync } from "node:fs";
import { devicefarmSpecTemplatePath } from "./paths.js";

const EMAIL_TOKEN = "__WEPLAY_GOOGLE_EMAIL_B64__";
const EMAILS_TOKEN = "__WEPLAY_GOOGLE_EMAILS_B64__";
const PLAY_STORE_EMAIL_TOKEN = "__WEPLAY_PLAY_STORE_EMAIL_B64__";
const PASSWORD_TOKEN = "__WEPLAY_GOOGLE_PASSWORD_B64__";
const GAME_CODE_TOKEN = "__WEPLAY_GAME_CODE_B64__";
const RUN_MODE_TOKEN = "__WEPLAY_RUN_MODE_B64__";
const SUPPORT_TARGET_TOKEN = "__WEPLAY_SUPPORT_TARGET_B64__";

export function resolvePlayStoreEmail(
  env: { WEPLAY_PLAY_STORE_EMAIL?: string; GOOGLE_WORKSPACE_ADMIN_EMAIL?: string },
  workspaceEmail: string
): string {
  const configured = (env.WEPLAY_PLAY_STORE_EMAIL || env.GOOGLE_WORKSPACE_ADMIN_EMAIL || "").trim().toLowerCase();
  return configured || workspaceEmail.trim().toLowerCase();
}

export function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function sanitizeGameCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "");
}

export function generateDeviceFarmSpec(input: {
  workspaceEmail: string;
  workspaceEmails?: string[];
  workspacePassword: string;
  gameCode: string;
  playStoreEmail?: string;
  runMode?: string;
  supportTarget?: string;
  template?: string;
}): string {
  const template = input.template ?? readFileSync(devicefarmSpecTemplatePath(), "utf8");
  if (
    !template.includes(EMAIL_TOKEN) ||
    !template.includes(EMAILS_TOKEN) ||
    !template.includes(PLAY_STORE_EMAIL_TOKEN) ||
    !template.includes(PASSWORD_TOKEN) ||
    !template.includes(GAME_CODE_TOKEN) ||
    !template.includes(RUN_MODE_TOKEN) ||
    !template.includes(SUPPORT_TARGET_TOKEN)
  ) {
    throw new Error("Device Farm spec template is missing email/password/game-code placeholders");
  }
  const playStoreEmail = (input.playStoreEmail || input.workspaceEmail).trim();
  const emails = uniqueEmails([input.workspaceEmail, ...(input.workspaceEmails ?? [])]);
  const emailB64 = toBase64(emails[0] ?? input.workspaceEmail);
  const emailsB64 = toBase64(emails.join(","));
  const playStoreEmailB64 = toBase64(playStoreEmail);
  const passwordB64 = toBase64(input.workspacePassword);
  const gameCodeB64 = toBase64(sanitizeGameCode(input.gameCode));
  const runModeB64 = toBase64((input.runMode || "provision").trim());
  const supportTargetB64 = toBase64((input.supportTarget || "").trim());
  if (
    template.includes(input.workspacePassword) ||
    template.includes(input.workspaceEmail) ||
    emails.some((email) => email && template.includes(email)) ||
    (playStoreEmail && template.includes(playStoreEmail))
  ) {
    throw new Error("Device Farm spec template must not contain live credentials");
  }
  return template
    .replaceAll(EMAIL_TOKEN, emailB64)
    .replaceAll(EMAILS_TOKEN, emailsB64)
    .replaceAll(PLAY_STORE_EMAIL_TOKEN, playStoreEmailB64)
    .replaceAll(PASSWORD_TOKEN, passwordB64)
    .replaceAll(GAME_CODE_TOKEN, gameCodeB64)
    .replaceAll(RUN_MODE_TOKEN, runModeB64)
    .replaceAll(SUPPORT_TARGET_TOKEN, supportTargetB64);
}

function uniqueEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of values) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

export function specContainsPlaintextSecret(spec: string, secret: string): boolean {
  return Boolean(secret) && spec.includes(secret);
}
