import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { buildLibiHttpEntry, invalidateMcpConfig } from "@/lib/mcp-config";

// `clearMcpConfigCache()` used to do this. It was deleted: its docblock said
// it existed for the aggregator child's `/reload`, and that handler explicitly
// does NOT drop a config cache (the aggregator serves libi's own tools and
// reads none), so this test file was its only caller. Dropping the shared
// globalThis slot is the same thing, without an export that lies about why it
// is there — see `MCP_CONFIG_GLOBAL_KEY` in lib/mcp-config.ts.
function dropSharedMcpConfigState(): void {
  delete (globalThis as unknown as Record<string, unknown>)["__libiMcpConfig_v1"];
}

describe("libi http entry", () => {
  beforeEach(() => { createTestDb(); });
  afterEach(() => { vi.restoreAllMocks(); dropSharedMcpConfigState(); });

  it("buildLibiHttpEntry points at mcp/http/index.ts with LIBI_HOME pinned", () => {
    const e = buildLibiHttpEntry();
    expect(e.args.join(" ")).toMatch(/mcp[\\/]http[\\/]index\.(ts|js)/);
    expect(e.env.LIBI_HOME).toBe(process.env.LIBI_HOME);
  });

  it("invalidateMcpConfig POSTs /reload to the aggregator and never throws when it is down", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(() => invalidateMcpConfig({ reason: "test" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/reload$/), expect.objectContaining({ method: "POST" }));
    fetchSpy.mockRestore();
  });
});
