/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
// registeredToolNames + TRACKING_TOOL_NAMES are imported dynamically inside the
// surface-assertion its below to avoid polluting the module registry before the
// vi.doMock calls used by the behavioural test (which relies on vi.resetModules
// in afterEach to isolate module instances).

describe("compute_object_track MCP surface (fan-out file)", () => {
  // Each it() uses dynamic imports so we can call vi.resetModules() in afterEach
  // and leave the module registry clean for the vi.doMock-based behavioural tests below.
  afterEach(() => vi.resetModules());

  it("libi.compute_object_track is registered on the libi-tracking MCP", async () => {
    const { createTrackingMcpServer } = await import("@/mcp/tracking-mcp/server");
    const { registeredToolNames, TRACKING_TOOL_NAMES } = await import("@/__tests__/helpers/mcp-tools");
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.compute_object_track");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("libi.compute_object_track IS registered on the core libi MCP (always-on)", async () => {
    const { createLibiMcpServer } = await import("@/mcp/server");
    const { registeredToolNames } = await import("@/__tests__/helpers/mcp-tools");
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.compute_object_track");
  });
});

describe("computeObjectTrack fan-out", () => {
  beforeEach(async () => { createTestDb(); await createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); vi.restoreAllMocks(); vi.resetModules(); });

  it("emits one segment per detected shot and a stitched summary", async () => {
    vi.doMock("@/lib/tracking/shot-fanout", () => ({
      detectShotRanges: vi.fn().mockResolvedValue([{ start: 0, end: 2 }, { start: 2, end: 5 }]),
    }));
    vi.doMock("@/mcp/jobs-client", async (orig) => ({
      ...(await (orig as any)() as object),
      runJobViaServer: vi.fn().mockResolvedValue({
        jobId: "j", resumed: false,
        result: { samples: [{ t: 0, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true }], framerate: 5 },
      }),
    }));
    const { getDb } = await import("@/lib/db/client"); const db = getDb();
    const { pieces, files } = await import("@/lib/db/schema/sqlite");
    await db.insert(pieces).values({ id: "p", name: "P", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(files).values({ id: "f", pieceId: "p", filename: "v.mp4", contentType: "video/mp4", createdAt: new Date(), mediaWidth: 100, mediaHeight: 100, mediaDuration: 5, name: "v", description: "", type: "video", storagePath: "p/v.mp4" } as any);
    const { computeObjectTrack } = await import("@/mcp/tools/tracking-tools");
    const res: any = await computeObjectTrack({
      fileId: "f", objectKind: "object",
      anchors: [{ fileId: "f", time: 1, bbox: [1, 1, 4, 4] }],
    } as any);
    expect(res.success).toBe(true);
    expect(res.data.segments.length).toBe(2);
    expect(res.data.summary.perSegment.length).toBe(2);
    expect(typeof res.data.trackId).toBe("string");
  });
});
