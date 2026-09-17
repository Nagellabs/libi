import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { seedDatabase } from "@/lib/db/init";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/bundled-mcps/aux-checks", async () => {
  const actual = await vi.importActual<typeof import("@/mcp/bundled-mcps/aux-checks")>(
    "@/mcp/bundled-mcps/aux-checks",
  );
  return {
    ...actual,
    checkBinary: vi.fn(async (name: string) => {
      if (name === "yt-dlp") {
        return { name: "yt-dlp", ok: true, detail: "/usr/local/bin/yt-dlp (180ms cold start)" };
      }
      return { name, ok: false, detail: `${name} not found on PATH` };
    }),
  };
});

import { diagnoseMcp } from "@/mcp/bundled-mcps/diagnose";
import { checkBinary } from "@/mcp/bundled-mcps/aux-checks";

describe("diagnoseMcp", () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
    vi.mocked(checkBinary).mockClear();
  });
  afterEach(() => {
    resetTestDb();
    vi.restoreAllMocks();
  });

  it("returns success=false for unknown mcpId", async () => {
    const result = await diagnoseMcp({ mcpId: "no-such-thing" });
    expect(result.success).toBe(false);
  });

  it("returns the row + spawn config + aux checks for youtube-download", async () => {
    const result = await diagnoseMcp({ mcpId: "youtube-download" });
    if (!result.success) throw new Error(result.error);
    expect(result.mcpId).toBe("youtube-download");
    expect(result.installStatus).toBeDefined();
    expect(result.serverStatus).toBeDefined();
    expect(result.spawn.command).toBeDefined();
    expect(Array.isArray(result.spawn.args)).toBe(true);
    expect(Array.isArray(result.spawn.envKeys)).toBe(true);
    expect(result.auxiliary.length).toBeGreaterThan(0);
    expect(result.auxiliary[0].name).toContain("yt-dlp");
  });

  it("reports inCurrentSession=false for a failed row (filtered out)", async () => {
    db.update(mcpServers)
      .set({ installStatus: "failed", installError: "uv sync exploded" })
      .where(eq(mcpServers.id, "libi-tracking"))
      .run();
    const result = await diagnoseMcp({ mcpId: "libi-tracking" });
    if (!result.success) throw new Error(result.error);
    expect(result.inCurrentSession).toBe(false);
    expect(result.whyExcluded).toMatch(/failed: uv sync exploded/);
  });

  it("runs no API-key aux check for any row — libi holds no provider key", async () => {
    const result = await diagnoseMcp({ mcpId: "libi-tracking" });
    if (!result.success) throw new Error(result.error);
    expect(result.auxiliary).toEqual([]);
  });

  it("produces hints in plain English", async () => {
    const result = await diagnoseMcp({ mcpId: "libi-tracking" });
    if (!result.success) throw new Error(result.error);
    expect(result.hints.length).toBeGreaterThan(0);
    expect(typeof result.hints[0]).toBe("string");
  });

  it("does NOT re-probe by default", async () => {
    // No mock needed — if it re-probed, it'd error on the real network
    const result = await diagnoseMcp({ mcpId: "youtube-download" });
    expect(result.success).toBe(true);
  });
});
