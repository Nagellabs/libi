/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
// registeredToolNames + TRACKING_TOOL_NAMES are imported dynamically inside the
// surface-assertion its below to avoid polluting the module registry before the
// vi.doMock calls used by the behavioural test (which relies on vi.resetModules
// in afterEach to isolate module instances).

describe("ground_target MCP surface", () => {
  // Each it() uses dynamic imports so we can call vi.resetModules() in afterEach
  // and leave the module registry clean for the vi.doMock-based behavioural tests below.
  afterEach(() => vi.resetModules());

  it("libi.ground_target is registered on the libi-tracking MCP", async () => {
    const { createTrackingMcpServer } = await import("@/mcp/tracking-mcp/server");
    const { registeredToolNames, TRACKING_TOOL_NAMES } = await import("@/__tests__/helpers/mcp-tools");
    const names = registeredToolNames(createTrackingMcpServer());
    expect(names).toContain("libi.ground_target");
    for (const t of TRACKING_TOOL_NAMES) expect(names).toContain(t);
  });

  it("libi.ground_target IS registered on the core libi MCP (always-on)", async () => {
    const { createLibiMcpServer } = await import("@/mcp/server");
    const { registeredToolNames } = await import("@/__tests__/helpers/mcp-tools");
    const names = registeredToolNames(createLibiMcpServer());
    expect(names).toContain("libi.ground_target");
  });
});

describe("groundTarget", () => {
  beforeEach(async () => { createTestDb(); await createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); vi.restoreAllMocks(); vi.resetModules(); });

  it("returns numbered candidate boxes for a frame", async () => {
    vi.doMock("@/mcp/jobs-client", async (orig) => ({
      ...(await (orig as any)() as object),
      runJobViaServer: vi.fn().mockResolvedValue({
        jobId: "j", resumed: false,
        result: { samples: [], framerate: 1, candidates: [
          { index: 1, bbox: [10, 10, 40, 60], label: "person", conf: 0.9 },
          { index: 2, bbox: [200, 50, 30, 30], label: "person", conf: 0.7 },
        ] },
      }),
    }));
    const { getDb } = await import("@/lib/db/client"); const db = getDb();
    const { pieces, files } = await import("@/lib/db/schema/sqlite");
    await db.insert(pieces).values({ id: "p", name: "P", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(files).values({ id: "f", pieceId: "p", filename: "v.mp4", contentType: "video/mp4", createdAt: new Date(), mediaWidth: 100, mediaHeight: 100, mediaDuration: 5, name: "v", description: "", type: "video", storagePath: "p/v.mp4" } as any);
    const { groundTarget } = await import("@/mcp/tools/tracking-tools");
    const r: any = await groundTarget({ fileId: "f", time: 1.0, classes: ["person"] } as any);
    expect(r.success).toBe(true);
    expect(r.data.candidates).toHaveLength(2);
    expect(r.data.candidates[0].index).toBe(1);
  });
});
