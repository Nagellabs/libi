import { describe, it, expect } from "vitest";
import { deriveAggregateStatus } from "@/lib/settings/aggregate-status";
import type { DependencyStatus, DepRuntimeStatus } from "@/mcp/registry/types";

function dep(installed: boolean, runtimeStatus: DepRuntimeStatus): DependencyStatus {
  return { binary: "dep", installed, path: null, source: null, runtimeStatus };
}

const ok = dep(true, "installed");
const pending = dep(false, "pending");
const installing = dep(false, "installing");
const failed = dep(false, "failed");

describe("deriveAggregateStatus", () => {
  it("returns 'installed' when every dep is installed", () => {
    expect(deriveAggregateStatus([ok, ok])).toBe("installed");
  });
  it("returns 'failed' when ANY dep is failed (highest priority)", () => {
    expect(deriveAggregateStatus([ok, failed, installing])).toBe("failed");
  });
  it("returns 'installing' when no failures but anything is installing", () => {
    expect(deriveAggregateStatus([ok, installing])).toBe("installing");
  });
  it("returns 'pending' when nothing failed/installing but something pending", () => {
    expect(deriveAggregateStatus([ok, pending])).toBe("pending");
  });
  it("returns 'installed' on empty list (vacuous truth)", () => {
    expect(deriveAggregateStatus([])).toBe("installed");
  });
});
