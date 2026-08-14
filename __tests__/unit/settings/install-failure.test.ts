import { describe, expect, it } from "vitest";
import { hasInstallFailure } from "@/lib/settings/install-failure";
import type { DependencyStatus } from "@/mcp/registry/types";

describe("hasInstallFailure", () => {
  it("returns true when installStatus is failed", () => {
    const result = hasInstallFailure(
      { installStatus: "failed" },
      []
    );
    expect(result).toBe(true);
  });

  it("returns true when any deps has runtimeStatus failed", () => {
    const deps: DependencyStatus[] = [
      {
        binary: "test-binary",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "failed",
        error: "Test error",
      },
    ];
    const result = hasInstallFailure(
      { installStatus: "pending" },
      deps
    );
    expect(result).toBe(true);
  });

  it("returns false when installStatus is pending and all deps are installed", () => {
    const deps: DependencyStatus[] = [
      {
        binary: "test-binary",
        installed: true,
        path: "/usr/bin/test",
        source: "system",
        runtimeStatus: "installed",
      },
    ];
    const result = hasInstallFailure(
      { installStatus: "pending" },
      deps
    );
    expect(result).toBe(false);
  });

  it("returns false when installStatus is pending and deps is undefined", () => {
    const result = hasInstallFailure(
      { installStatus: "pending" },
      undefined
    );
    expect(result).toBe(false);
  });

  it("returns true when installStatus is installed but deps has failed runtimeStatus", () => {
    const deps: DependencyStatus[] = [
      {
        binary: "test-binary",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "failed",
        error: "Stale failure",
      },
    ];
    const result = hasInstallFailure(
      { installStatus: "installed" },
      deps
    );
    expect(result).toBe(true);
  });

  it("returns false when installStatus is needs_config and deps is empty", () => {
    const result = hasInstallFailure(
      { installStatus: "needs_config" },
      []
    );
    expect(result).toBe(false);
  });

  it("returns false when installStatus is checking and deps is undefined", () => {
    const result = hasInstallFailure(
      { installStatus: "checking" },
      undefined
    );
    expect(result).toBe(false);
  });

  it("returns false when installStatus is not_required and deps is empty", () => {
    const result = hasInstallFailure(
      { installStatus: "not_required" },
      []
    );
    expect(result).toBe(false);
  });

  it("handles deps array with mixed runtimeStatus values", () => {
    const deps: DependencyStatus[] = [
      {
        binary: "binary1",
        installed: true,
        path: "/usr/bin/binary1",
        source: "system",
        runtimeStatus: "installed",
      },
      {
        binary: "binary2",
        installed: false,
        path: null,
        source: null,
        runtimeStatus: "failed",
      },
    ];
    const result = hasInstallFailure(
      { installStatus: "pending" },
      deps
    );
    expect(result).toBe(true);
  });

  it("returns false when deps array has no failed runtimeStatus", () => {
    const deps: DependencyStatus[] = [
      {
        binary: "binary1",
        installed: true,
        path: "/usr/bin/binary1",
        source: "system",
        runtimeStatus: "installed",
      },
      {
        binary: "binary2",
        installed: true,
        path: "/usr/bin/binary2",
        source: "bundled",
        runtimeStatus: "installed",
      },
    ];
    const result = hasInstallFailure(
      { installStatus: "pending" },
      deps
    );
    expect(result).toBe(false);
  });
});
