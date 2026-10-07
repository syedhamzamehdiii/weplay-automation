export function getToken(): string | null {
  return sessionStorage.getItem("weplay.token");
}

export function setToken(token: string): void {
  sessionStorage.setItem("weplay.token", token);
}

export function clearToken(): void {
  sessionStorage.removeItem("weplay.token");
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  const needsJsonBody = method === "POST" || method === "PATCH" || method === "PUT";
  const body = needsJsonBody && init.body === undefined ? "{}" : init.body;
  if (needsJsonBody || init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(path, { ...init, headers, body });
  if (response.status === 401) {
    clearToken();
    if (!path.startsWith("/api/auth/login")) {
      window.location.href = "/login";
    }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      details?: { fieldErrors?: Record<string, string[]> };
    };
    const fieldErrors = body.details?.fieldErrors
      ? Object.entries(body.details.fieldErrors)
          .flatMap(([field, messages]) => (messages ?? []).map((message) => `${field}: ${message}`))
          .join("; ")
      : "";
    throw new Error(fieldErrors || body.error || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function downloadCsv(path: string, filename: string): Promise<void> {
  const token = getToken();
  const headers = new Headers();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(path, { headers });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
