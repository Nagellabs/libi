import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { listBundledMcps } from "@/mcp/tools/mcp-status-tools";
import { seedDatabase } from "@/lib/db/init";

describe("listBundledMcps — per-dep status", () => {
  beforeEach(() => {
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
    // Hand-write a libi row with three deps in different states.
    db.update(mcpServers)
      .set({
        dependencyStatus: JSON.stringify([
          { binary: "ffmpeg", installed: true, path: "/x/ffmpeg", source: "bundled", runtimeStatus: "installed" },
          { binary: "chromium", installed: false, path: null, source: null, runtimeStatus: "installing", bytesDownloaded: 80_000_000, bytesTotal: 165_000_000 },
          { binary: "face-api", installed: false, path: null, source: null, runtimeStatus: "failed", error: "checksum mismatch" },
        ]),
      })
      .where(eq(mcpServers.id, "libi"))
      .run();
  });

  afterEach(() => resetTestDb());

  it("returns per-dep runtimeStatus + progress + error in the response", async () => {
    const out = await listBundledMcps({} as never);
    expect(out.success).toBe(true);
    const data = out.data as { mcps: Array<{ id: string; dependencies: Array<Record<string, unknown>> }> };
    const libi = data.mcps.find((m) => m.id === "libi");
    expect(libi).toBeDefined();
    expect(libi!.dependencies).toHaveLength(3);
    const ffmpeg = libi!.dependencies.find((d) => d.binary === "ffmpeg")!;
    expect(ffmpeg.runtimeStatus).toBe("installed");
    const chrom = libi!.dependencies.find((d) => d.binary === "chromium")!;
    expect(chrom.runtimeStatus).toBe("installing");
    expect(chrom.bytesDownloaded).toBe(80_000_000);
    expect(chrom.bytesTotal).toBe(165_000_000);
    const fa = libi!.dependencies.find((d) => d.binary === "face-api")!;
    expect(fa.runtimeStatus).toBe("failed");
    expect(fa.error).toBe("checksum mismatch");
  });

  it("returns an empty array when dependencyStatus is null or malformed", async () => {
    const db = getDb();
    db.update(mcpServers)
      .set({ dependencyStatus: "not-json" })
      .where(eq(mcpServers.id, "libi"))
      .run();
    const out = await listBundledMcps({} as never);
    const data = out.data as { mcps: Array<{ id: string; dependencies: unknown[] }> };
    const libi = data.mcps.find((m) => m.id === "libi");
    expect(libi!.dependencies).toEqual([]);
  });
});
