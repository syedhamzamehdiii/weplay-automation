export interface WorkspaceCsvRow {
  displayName: string;
  firstName: string;
  lastName: string;
  username: string;
  lineNumber: number;
}

export interface WorkspaceCsvIssue {
  lineNumber: number;
  username: string | null;
  code: "WORKSPACE_USER_INVALID" | "WORKSPACE_DUPLICATE_USERNAME";
  message: string;
}

export interface WorkspaceCsvParseResult {
  rows: WorkspaceCsvRow[];
  issues: WorkspaceCsvIssue[];
}

const REQUIRED_HEADERS = ["firstname", "lastname", "username"] as const;

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function displayNameFrom(firstName: string, lastName: string, displayName: string): string {
  const explicit = displayName.trim();
  if (explicit) {
    return explicit;
  }
  return `${firstName} ${lastName}`.trim();
}

export function parseWorkspaceCsv(csv: string): WorkspaceCsvParseResult {
  const lines = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const issues: WorkspaceCsvIssue[] = [];
  const rows: WorkspaceCsvRow[] = [];
  let headerIndex = -1;
  let headers: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]?.trim() ?? "";
    if (!raw) {
      continue;
    }
    headerIndex = i;
    headers = splitCsvLine(raw).map(normalizeHeader);
    break;
  }

  if (headerIndex < 0) {
    issues.push({
      lineNumber: 1,
      username: null,
      code: "WORKSPACE_USER_INVALID",
      message: "CSV is empty"
    });
    return { rows, issues };
  }

  const indexOf = (name: string): number => headers.indexOf(name);
  const firstNameIdx = indexOf("firstname");
  const lastNameIdx = indexOf("lastname");
  const usernameIdx = indexOf("username");
  const displayNameIdx = indexOf("displayname");

  const missing = REQUIRED_HEADERS.filter((header) => indexOf(header) < 0);
  if (missing.length > 0) {
    issues.push({
      lineNumber: headerIndex + 1,
      username: null,
      code: "WORKSPACE_USER_INVALID",
      message: `CSV must include columns: firstName, lastName, username (missing ${missing.join(", ")})`
    });
    return { rows, issues };
  }

  const seen = new Map<string, number>();
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i]?.trim() ?? "";
    if (!raw) {
      continue;
    }
    const cells = splitCsvLine(raw);
    const firstName = (cells[firstNameIdx] ?? "").trim();
    const lastName = (cells[lastNameIdx] ?? "").trim();
    const username = (cells[usernameIdx] ?? "").trim();
    const displayName = displayNameFrom(firstName, lastName, displayNameIdx >= 0 ? (cells[displayNameIdx] ?? "") : "");
    const lineNumber = i + 1;

    if (!firstName || !lastName || !username) {
      issues.push({
        lineNumber,
        username: username || null,
        code: "WORKSPACE_USER_INVALID",
        message: "firstName, lastName, and username are required"
      });
      continue;
    }

    const key = username.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({
        lineNumber,
        username,
        code: "WORKSPACE_DUPLICATE_USERNAME",
        message: `Duplicate username "${username}" (also on line ${previous})`
      });
      continue;
    }
    seen.set(key, lineNumber);
    rows.push({ displayName, firstName, lastName, username, lineNumber });
  }

  if (rows.length === 0 && issues.length === 0) {
    issues.push({
      lineNumber: headerIndex + 1,
      username: null,
      code: "WORKSPACE_USER_INVALID",
      message: "CSV has a header but no user rows"
    });
  }

  return { rows, issues };
}
