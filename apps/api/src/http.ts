export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string | undefined;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}
