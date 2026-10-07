export function isTransientAwsNetworkError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
  } else if (error != null) {
    parts.push(String(error));
  }
  if (error && typeof error === "object") {
    for (const key of ["code", "Code", "name", "errno"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number") {
        parts.push(String(value));
      }
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause && cause !== error) {
      return isTransientAwsNetworkError(cause) || haystackMatches(parts.join(" "));
    }
  }
  return haystackMatches(parts.join(" "));
}

function haystackMatches(haystack: string): boolean {
  const hay = haystack.toLowerCase();
  return (
    hay.includes("enotfound") ||
    hay.includes("eai_again") ||
    hay.includes("econnreset") ||
    hay.includes("etimedout") ||
    hay.includes("econnrefused") ||
    hay.includes("socket hang up") ||
    hay.includes("network timeout") ||
    hay.includes("throttling") ||
    hay.includes("too many requests") ||
    hay.includes("temporarily unavailable")
  );
}
