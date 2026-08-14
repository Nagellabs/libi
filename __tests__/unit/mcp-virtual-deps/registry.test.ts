import { describe, it, expect } from "vitest";
import type { VirtualDep } from "@/lib/mcp-virtual-deps/types";

function fake(id: string, label = id): VirtualDep & { _installed: boolean } {
  const obj: VirtualDep & { _installed: boolean } = {
    id,
    label,
    _installed: false,
    async inspect() {
      return {
        binary: this.label,
        installed: this._installed,
        path: null,
        source: this._installed ? "bundled" : null,
        runtimeStatus: this._installed ? "installed" : "pending",
        error: null,
      };
    },
    async install() {
      this._installed = true;
    },
  };
  return obj;
}

describe("getVirtualDepsForMcp", () => {
  it("returns [] for an unknown mcpId", async () => {
    const { getVirtualDepsForMcp } = await import("@/lib/mcp-virtual-deps/registry");
    expect(getVirtualDepsForMcp("nonexistent")).toEqual([]);
  });

  it("inspect→install→inspect round-trips a registered dep", async () => {
    const { registerVirtualDeps, getVirtualDepsForMcp, _resetForTests } = await import(
      "@/lib/mcp-virtual-deps/registry"
    );
    _resetForTests();
    const f = fake("test-dep", "test dep");
    registerVirtualDeps("test-mcp", [f]);
    const deps = getVirtualDepsForMcp("test-mcp");
    expect(deps).toHaveLength(1);
    expect((await deps[0].inspect()).installed).toBe(false);
    await deps[0].install();
    expect((await deps[0].inspect()).installed).toBe(true);
  });

  it("throws on duplicate id within the same mcp", async () => {
    const { registerVirtualDeps, _resetForTests } = await import(
      "@/lib/mcp-virtual-deps/registry"
    );
    _resetForTests();
    expect(() =>
      registerVirtualDeps("test-mcp", [fake("dup"), fake("dup")]),
    ).toThrow(/duplicate/);
  });
});
