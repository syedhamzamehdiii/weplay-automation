import { describe, expect, it } from "vitest";
import { licenseTotalsFromReportParameters } from "../../apps/api/src/google/googleDirectoryClient.js";

describe("Workspace Reports license totals", () => {
  it("sums SKU total and used license fields when Google publishes them", () => {
    expect(
      licenseTotalsFromReportParameters([
        { name: "accounts:gsuite_unlimited_total_licenses", intValue: "10" },
        { name: "accounts:gsuite_unlimited_used_licenses", intValue: "3" },
        { name: "accounts:num_users", intValue: "3" }
      ])
    ).toEqual({ total: 10, used: 3 });
  });

  it("returns null totals when Google omits license fields", () => {
    expect(
      licenseTotalsFromReportParameters([
        { name: "accounts:num_users", intValue: "1" },
        { name: "gmail:num_emails_sent", intValue: "12" }
      ])
    ).toEqual({ total: null, used: null });
  });
});
