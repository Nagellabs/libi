import { describe, it, expect } from "vitest";
import { buildTrackingEntry } from "@/lib/mcp-config";
import { STATIC_BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("buildTrackingEntry", () => {
  it("returns the tsx-direct command (node + node_modules/tsx/dist/cli.mjs) for the tracking MCP entrypoint", () => {
    // Mirrors buildLibiEntry(): resolves tsx's actual CLI entry point run via
    // `node`, not the node_modules/.bin/tsx shim electron-builder never
    // copies. mcp/** + node_modules/tsx (a real dependency) are guaranteed
    // present in every legitimate build, so resolveBundledSpawn no longer
    // falls back to the unsafe `npx libi serve-mcp-tracking` here.
    const e = buildTrackingEntry();
    expect(e.command).toMatch(/(^|[\\/])node(\.exe)?$/);
    const joined = e.args.join(" ");
    expect(joined).toContain("tsx/dist/cli.mjs");
    expect(joined).toContain("tracking-mcp/index.ts");
    expect(e.command).not.toBe("npx");
    expect(joined).not.toContain("serve-mcp-tracking");
  });
});

describe("libi-tracking bundled def", () => {
  it("is registered as a tier-2, non-core bundled MCP with an install plan path", () => {
    const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-tracking");
    expect(def).toBeTruthy();
    expect(def!.core).toBe(false);
    expect(def!.installFlow).toBe("tier-2");
    expect(typeof def!.installPlanPath).toBe("string");
  });
});
