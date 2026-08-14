import { describe, it, expect, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { initSegmentedTrack, upsertSegment } from "@/lib/tracking/segment-store";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { listTrackSegments, computeTrackSegment } from "@/mcp/tools/tracking-tools";
import { files, pieces } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/__tests__/helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});

// Mock runJobViaServer so no real HTTP is attempted. We capture the params it
// receives so the payload + priority tests can assert on the anchor set forwarded
// to the engine.
vi.mock("@/mcp/jobs-client", async (orig) => {
  const actual = await orig<typeof import("@/mcp/jobs-client")>();
  return { ...actual, runJobViaServer: vi.fn() };
});

afterEach(() => { cleanupTempDir(); vi.clearAllMocks(); });

describe("Gate A: manual anchors survive agent recompute + are visible", () => {
  it("upsertSegment preserves manualAnchors; listTrackSegments reports them", async () => {
    createTempStorageDir();
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f1", pieceId: "p1", filename: "v.mp4", name: "v.mp4", description: "",
      type: "video", storagePath: "p1/v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
    }).run();
    await initSegmentedTrack({ trackId: "trk1", fileId: "f1", framerate: 30, method: "yoloe+botsort" });
    const t0 = await readTrack("p1", "trk1");
    await writeTrack("p1", { ...t0!, manualAnchors: [{ id: "man-3000", time: 3, bbox: [1, 2, 3, 4] }] });

    // Simulate an agent recompute writing a segment over the track.
    await upsertSegment("trk1", { id: "seg-0-10000", startTime: 0, endTime: 10,
      method: "yoloe+botsort", status: "ok",
      samples: [{ t: 0, x: 9, y: 9, w: 9, h: 9, confidence: 1, visible: true }] });

    const after = await readTrack("p1", "trk1");
    expect(after?.manualAnchors).toEqual([{ id: "man-3000", time: 3, bbox: [1, 2, 3, 4] }]);

    const res = await listTrackSegments({ trackId: "trk1" });
    expect(res.success).toBe(true);
    if (!res.success) throw new Error("expected success");
    expect(res.data?.manualAnchors).toEqual([{ time: 3, bbox: [1, 2, 3, 4] }]);
    expect(res.data?.manualAnchorCount).toBe(1);
  });

  it("computeTrackSegment forwards stored in-range manual anchors into the runner payload", async () => {
    createTempStorageDir();
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    db.insert(pieces).values({ id: "p2", name: "p2", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f2", pieceId: "p2", filename: "v.mp4", name: "v.mp4", description: "",
      type: "video", storagePath: "p2/v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
    }).run();

    // Set up a track with one existing OK segment and a stored manual anchor at t=5.
    await initSegmentedTrack({ trackId: "trk2", fileId: "f2", framerate: 30, method: "yoloe+botsort" });
    await upsertSegment("trk2", {
      id: "seg-0-10000", startTime: 0, endTime: 10,
      method: "yoloe+botsort", status: "ok",
      samples: [{ t: 5, x: 100, y: 100, w: 50, h: 60, confidence: 1, visible: true }],
    });
    const t0 = await readTrack("p2", "trk2");
    await writeTrack("p2", {
      ...t0!,
      manualAnchors: [{ id: "man-5000", time: 5, bbox: [100, 100, 50, 60] }],
    });

    const { runJobViaServer } = await import("@/mcp/jobs-client");
    const mockRun = vi.mocked(runJobViaServer);
    mockRun.mockResolvedValue({
      jobId: "j1",
      resumed: false,
      result: {
        samples: [{ t: 5, x: 100, y: 100, w: 50, h: 60, confidence: 1, visible: true }],
        framerate: 30,
      },
    } as unknown as Awaited<ReturnType<typeof runJobViaServer>>);

    await computeTrackSegment({
      fileId: "f2",
      trackId: "trk2",
      range: { start: 0, end: 10 },
      method: "yoloe+botsort",
      anchors: [],
      objectKind: "object",
    });

    expect(mockRun).toHaveBeenCalledOnce();
    const calledParams = mockRun.mock.calls[0][1] as { anchors: Array<{ fileId: string; time: number; bbox: number[] }> };
    // The stored manual anchor at t=5 must appear in the forwarded anchor set.
    const anchorAt5 = calledParams.anchors.find((a) => Math.abs(a.time - 5) < 0.1);
    expect(anchorAt5).toBeDefined();
    expect(anchorAt5?.bbox).toEqual([100, 100, 50, 60]);
  });

  it("stored manual anchor WINS over a colliding params.anchors entry at the same time (Gate A priority)", async () => {
    createTempStorageDir();
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    db.insert(pieces).values({ id: "p3", name: "p3", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f3", pieceId: "p3", filename: "v.mp4", name: "v.mp4", description: "",
      type: "video", storagePath: "p3/v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
    }).run();

    // Track with stored manual anchor at t=5 with bbox [100,100,50,60].
    await initSegmentedTrack({ trackId: "trk3", fileId: "f3", framerate: 30, method: "yoloe+botsort" });
    await upsertSegment("trk3", {
      id: "seg-0-10000", startTime: 0, endTime: 10,
      method: "yoloe+botsort", status: "ok",
      samples: [{ t: 5, x: 100, y: 100, w: 50, h: 60, confidence: 1, visible: true }],
    });
    const t0 = await readTrack("p3", "trk3");
    await writeTrack("p3", {
      ...t0!,
      manualAnchors: [{ id: "man-5000", time: 5, bbox: [100, 100, 50, 60] }],
    });

    const { runJobViaServer } = await import("@/mcp/jobs-client");
    const mockRun = vi.mocked(runJobViaServer);
    mockRun.mockResolvedValue({
      jobId: "j2",
      resumed: false,
      result: {
        samples: [{ t: 5, x: 100, y: 100, w: 50, h: 60, confidence: 1, visible: true }],
        framerate: 30,
      },
    } as unknown as Awaited<ReturnType<typeof runJobViaServer>>);

    // Agent supplies a DIFFERENT bbox at the SAME time t=5 via params.anchors.
    // The stored manual bbox [100,100,50,60] must WIN over the agent's [1,1,1,1].
    await computeTrackSegment({
      fileId: "f3",
      trackId: "trk3",
      range: { start: 0, end: 10 },
      method: "yoloe+botsort",
      anchors: [{ fileId: "f3", time: 5, bbox: [1, 1, 1, 1] }],
      objectKind: "object",
    });

    expect(mockRun).toHaveBeenCalledOnce();
    const calledParams = mockRun.mock.calls[0][1] as { anchors: Array<{ fileId: string; time: number; bbox: number[] }> };

    // Exactly ONE anchor at t=5 (no duplicate).
    const anchorsAt5 = calledParams.anchors.filter((a) => Math.abs(a.time - 5) < 0.1);
    expect(anchorsAt5).toHaveLength(1);

    // That anchor carries the STORED MANUAL bbox, not the agent-supplied one.
    expect(anchorsAt5[0].bbox).toEqual([100, 100, 50, 60]);

    // The agent-supplied conflicting bbox must NOT be present at t=5.
    const agentBboxAt5 = calledParams.anchors.find(
      (a) => Math.abs(a.time - 5) < 0.1 && a.bbox[0] === 1 && a.bbox[1] === 1,
    );
    expect(agentBboxAt5).toBeUndefined();
  });
});
