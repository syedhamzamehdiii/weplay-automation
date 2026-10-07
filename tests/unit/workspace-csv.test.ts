import { describe, expect, it } from "vitest";
import {
  buildWorkspaceEmail,
  exponentialBackoffMs,
  parseWorkspaceCsv,
  validateWorkspaceDomain,
  validateWorkspaceUsername
} from "@weplay/shared";

describe("workspace CSV parsing", () => {
  it("parses firstName, lastName, username and optional displayName", () => {
    const csv = `firstName,lastName,username,displayName
Hamza,Ahmed,user001,Hamza Ahmed
Arjun,Khan,user002,
Rafiq,Hasan,user003`;
    const result = parseWorkspaceCsv(csv);
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      firstName: "Hamza",
      lastName: "Ahmed",
      username: "user001",
      displayName: "Hamza Ahmed"
    });
    expect(result.rows[1]?.displayName).toBe("Arjun Khan");
  });

  it("rejects missing columns, blank rows values, and duplicate usernames", () => {
    expect(parseWorkspaceCsv("email,name\na,b").issues[0]?.message).toMatch(/firstName, lastName, username/);
    const duplicates = parseWorkspaceCsv(`firstName,lastName,username
A,B,user001
C,D,user001`);
    expect(duplicates.rows).toHaveLength(1);
    expect(duplicates.issues.some((issue) => issue.code === "WORKSPACE_DUPLICATE_USERNAME")).toBe(true);
    const missing = parseWorkspaceCsv(`firstName,lastName,username
,Ahmed,user001`);
    expect(missing.issues[0]?.code).toBe("WORKSPACE_USER_INVALID");
  });
});

describe("workspace username and email validation", () => {
  it("builds emails from the configured domain, not a hard-coded one", () => {
    expect(buildWorkspaceEmail("User001", "Our.Example.COM")).toBe("user001@our.example.com");
    expect(validateWorkspaceUsername("user001")).toBeNull();
    expect(validateWorkspaceUsername("bad..user")).toMatch(/consecutive dots/);
    expect(validateWorkspaceUsername(".leading")).toMatch(/start or end/);
    expect(validateWorkspaceUsername("not valid")).toMatch(/letters, numbers/);
    expect(validateWorkspaceDomain("")).toMatch(/not configured/);
    expect(validateWorkspaceDomain("example.com")).toBeNull();
  });

  it("uses exponential backoff for retries", () => {
    expect(exponentialBackoffMs(0, 1000)).toBe(1000);
    expect(exponentialBackoffMs(1, 1000)).toBe(2000);
    expect(exponentialBackoffMs(2, 1000)).toBe(4000);
    expect(exponentialBackoffMs(10, 1000, 8000)).toBe(8000);
  });
});
