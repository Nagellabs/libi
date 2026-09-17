import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "../../../helpers/test-db";

/**
 * What Category A's tier-1 sweep is allowed to touch.
 *
 * `installBundledDeps({ tier: "tier-1" })` used to admit a tier-2 MCP that
 * carried a dep flagged `installFlow: "tier-1"`, and a dedicated branch then
 * installed just those deps — routing around `ensureMcp` so the parent's
 * `installStatus` was not flipped to "installed". uv and yt-dlp were de-tiered
 * on 2026-09-08, no def has carried such a dep since, and both the admission
 * rule and the branch were unreachable. The shape is now unsupported: the
 * sweep is exactly the tier-1 defs, and a stray flag is reported rather than
 * silently obeyed.
 *
 * Everything here runs against a mocked `BUNDLED_MCP_SERVERS`, so it is
 * independent of what the real registry happens to declare today —
 * `category-a.test.ts` separately pins that no real def carries a stray flag.
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

vi.mock("@/lib/logger", async (orig) => ({
  ...(await orig<typeof import("@/lib/logger")>()),
  serverLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    // `lib/analysis/manager.ts` calls `logger.child(...)` at module load, and
    // it is transitively imported from here.
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const TIER1_DEF = {
  id: "tier1-def",
  name: "Tier 1",
  description: "test",
  npmUrl: null,
  type: "stdio",
  command: "",
  args: [],
  requireApproval: false,
  installFlow: "tier-1",
  dependencies: [],
};

/** A tier-2 MCP carrying a tier-1-flagged dep — the shape that no longer
 *  exists in the real registry and that this sweep must not act on. The dep's
 *  download URL is deliberately unreachable: reaching for it is the failure. */
const STRAY_DEF = {
  id: "tier2-def-with-stray-flag",
  name: "Tier 2",
  description: "test",
  npmUrl: null,
  type: "stdio",
  command: "",
  args: [],
  requireApproval: false,
  installFlow: "tier-2",
  dependencies: [
    {
      binary: "stray",
      installFlow: "tier-1",
      requireBundled: true,
      pinnedInstallToken: "2026-09-09",
      downloadUrl: {
        darwin: "http://127.0.0.1:1/stray",
        linux: "http://127.0.0.1:1/stray",
        win32: "http://127.0.0.1:1/stray",
      },
    },
  ],
};

vi.mock("@/mcp/registry/bundled", () => ({
  BUNDLED_MCP_SERVERS: [TIER1_DEF, STRAY_DEF],
}));

import { serverLogger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tier1-sweep-"));
  process.env.LIBI_HOME = home;
  vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  vi.mocked(serverLogger.warn).mockClear();
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("installBundledDeps({ tier: 'tier-1' })", () => {
  it("does not install a tier-1-flagged dep hanging off a tier-2 MCP", async () => {
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const dm = new DependencyManager();
    dm.setSkipDbWrites(true);

    const progress: string[] = [];
    // Resolves, rather than dying on the unreachable download URL: nothing
    // should reach for it. A rejection here IS the regression.
    await dm.installBundledDeps({
      tier: "tier-1",
      onProgress: (p) => progress.push(`${p.binary}:${p.status}`),
    });

    expect(progress.filter((p) => p.startsWith("stray:"))).toEqual([]);
    expect(fs.existsSync(path.join(home, "bin", "stray"))).toBe(false);
  });

  it("says so out loud rather than silently ignoring the flag", async () => {
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const dm = new DependencyManager();
    dm.setSkipDbWrites(true);
    await dm.installBundledDeps({ tier: "tier-1" });

    const warned = vi
      .mocked(serverLogger.warn)
      .mock.calls.filter(
        ([f]) => (f as { op?: string }).op === "tier1_dep_on_tier2_def",
      );
    expect(warned).toHaveLength(1);
    expect(warned[0]![0]).toMatchObject({
      tag: "lifecycle",
      op: "tier1_dep_on_tier2_def",
      mcpId: "tier2-def-with-stray-flag",
      binaries: ["stray"],
    });
  });

  it("says nothing when no def carries a stray flag (the real registry's shape)", async () => {
    const bundled = await import("@/mcp/registry/bundled");
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const restore = bundled.BUNDLED_MCP_SERVERS.splice(1, 1);
    try {
      const dm = new DependencyManager();
      dm.setSkipDbWrites(true);
      await dm.installBundledDeps({ tier: "tier-1" });
      expect(
        vi
          .mocked(serverLogger.warn)
          .mock.calls.filter(([f]) => (f as { op?: string }).op === "tier1_dep_on_tier2_def"),
      ).toEqual([]);
    } finally {
      bundled.BUNDLED_MCP_SERVERS.splice(1, 0, ...restore);
    }
  });

  it("an 'all' sweep still reaches the tier-2 def (the filter is tier-1-only)", async () => {
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const dm = new DependencyManager();
    dm.setSkipDbWrites(true);
    // The stray dep IS attempted here, against an unreachable URL — which is
    // the proof that the tier-1 case above was a filter and not an accident of
    // the fixture. `ensureMcp` records a failed install rather than throwing,
    // so the evidence is the progress stream, not a rejection.
    const progress: string[] = [];
    await dm.installBundledDeps({ tier: "all", onProgress: (p) => progress.push(`${p.binary}:${p.status}`) });
    expect(progress.some((p) => p.startsWith("stray:"))).toBe(true);
    expect(
      vi
        .mocked(serverLogger.warn)
        .mock.calls.filter(([f]) => (f as { op?: string }).op === "tier1_dep_on_tier2_def"),
    ).toEqual([]);
  });
});
