import { describe, it, expect, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { initSegmentedTrack, upsertSegment } from "@/lib/tracking/segment-store";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { computeTrackSegment } from "@/mcp/tools/tracking-tools";
import { files, pieces } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/__tests__/helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});
vi.mock("@/mcp/jobs-client", async (orig) => {
  const actual = await orig<typeof import("@/mcp/jobs-client")>();
  return { ...actual, runJobViaServer: vi.fn() };
});

afterEach(() => { cleanupTempDir(); vi.clearAllMocks(); });

async function seed(pieceId: string, fileId: string, trackId: string) {
  createTempStorageDir();
  const { getDb } = await import("@/lib/db/client");
  const db = getDb();
  db.insert(pieces).values({ id: pieceId, name: pieceId, createdAt: new Date() }).run();
  db.insert(files).values({
    id: fileId, pieceId, filename: "v.mp4", name: "v.mp4", description: "",
    type: "video", storagePath: `${pieceId}/v.mp4`, contentType: "video/mp4",
    size: 1, createdAt: new Date(), mediaWidth: 640, mediaHeight: 360, mediaDuration: 30,
  }).run();
  await initSegmentedTrack({ trackId, fileId, framerate: 30, method: "yoloe+botsort" });
  await upsertSegment(trackId, {
    id: "seg-0-30000", startTime: 0, endTime: 30, method: "yoloe+botsort", status: "ok",
    samples: [{ t: 22, x: 9, y: 9, w: 9, h: 9, confidence: 1, visible: true }],
  });
}

describe("computeTrackSegment persists agentAnchors (corrections only)", () => {
  it("persists in-range param anchors when correcting an existing track", async () => {
    await seed("p3", "f3", "trk3");
    const { runJobViaServer } = await import("@/mcp/jobs-client");
    (runJobViaServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: "j", resumed: false,
      result: { samples: [{ t: 22, x: 5, y: 5, w: 5, h: 5, confidence: 1, visible: true }], framerate: 30 },
    });
    await computeTrackSegment({
      fileId: "f3", trackId: "trk3", range: { start: 21.5, end: 26.5 },
      method: "yoloe+botsort",
      anchors: [
        { fileId: "f3", time: 22, bbox: [10, 11, 12, 13] },
        { fileId: "f3", time: 24, bbox: [20, 21, 22, 23] },
        { fileId: "f3", time: 29, bbox: [99, 99, 99, 99] }, // OUT of range → not persisted
      ],
    });
    const t = await readTrack("p3", "trk3");
    expect((t!.agentAnchors ?? []).map((a) => [a.time, a.bbox])).toEqual([
      [22, [10, 11, 12, 13]],
      [24, [20, 21, 22, 23]],
    ]);
    expect((t!.agentAnchors ?? []).every((a) => a.id === `agt-${Math.round(a.time * 1000)}`)).toBe(true);
  });

  it("does NOT persist agentAnchors on initial build (no trackId)", async () => {
    await seed("p4", "f4", "ignored"); // seed creates a track row but we call WITHOUT trackId
    const { runJobViaServer } = await import("@/mcp/jobs-client");
    (runJobViaServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: "j", resumed: false,
      result: { samples: [{ t: 1, x: 5, y: 5, w: 5, h: 5, confidence: 1, visible: true }], framerate: 30 },
    });
    const res = await computeTrackSegment({
      fileId: "f4", range: { start: 0, end: 5 }, method: "yoloe+botsort",
      anchors: [{ fileId: "f4", time: 1, bbox: [1, 2, 3, 4] }],
    });
    expect(res.success).toBe(true);
    if (!res.success) throw new Error("expected success");
    const t = await readTrack("p4", res.data!.trackId);
    expect(t!.agentAnchors ?? []).toEqual([]);
  });
});

describe("computeTrackSegment seed precedence", () => {
  it("forwards manual > agent > params (in-range) to the engine", async () => {
    await seed("p1", "f1", "trk1");
    const t0 = await readTrack("p1", "trk1");
    await writeTrack("p1", {
      ...t0!,
      manualAnchors: [{ id: "man-22000", time: 22, bbox: [1, 1, 1, 1] }],
      agentAnchors: [{ id: "agt-24000", time: 24, bbox: [2, 2, 2, 2] }],
    });
    const { runJobViaServer } = await import("@/mcp/jobs-client");
    (runJobViaServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: "j1", resumed: false,
      result: { samples: [{ t: 22, x: 5, y: 5, w: 5, h: 5, confidence: 1, visible: true }], framerate: 30 },
    });

    await computeTrackSegment({
      fileId: "f1", trackId: "trk1", range: { start: 21.5, end: 26.5 },
      method: "yoloe+botsort", classes: ["person"],
      anchors: [{ fileId: "f1", time: 22, bbox: [3, 3, 3, 3] }, { fileId: "f1", time: 25, bbox: [7, 7, 7, 7] }],
    });

    const call = (runJobViaServer as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const fwd = (call[1] as { anchors: { time: number; bbox: number[] }[] }).anchors;
    const at22 = fwd.find((a) => a.time === 22);
    const at24 = fwd.find((a) => a.time === 24);
    const at25 = fwd.find((a) => a.time === 25);
    expect(at22!.bbox).toEqual([1, 1, 1, 1]); // manual wins over param at t=22
    expect(at24!.bbox).toEqual([2, 2, 2, 2]); // stored agent re-seeds
    expect(at25!.bbox).toEqual([7, 7, 7, 7]); // param survives (no collision)
  });
});

import { summarizeTrack } from "@/lib/tracking/summary";

describe("computeTrackSegment never-make-worse guard", () => {
  it("no visible samples → keeps prior segment AND still persists agentAnchors", async () => {
    await seed("p5", "f5", "trk5");
    const { runJobViaServer } = await import("@/mcp/jobs-client");
    (runJobViaServer as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: "j", resumed: false,
      result: { samples: [{ t: 22, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false }], framerate: 30 },
    });
    const before = await readTrack("p5", "trk5");
    const res = await computeTrackSegment({
      fileId: "f5", trackId: "trk5", range: { start: 21.5, end: 26.5 },
      method: "yoloe+botsort",
      anchors: [{ fileId: "f5", time: 22, bbox: [30, 31, 32, 33] }],
    });
    expect(res.success).toBe(true);
    const after = await readTrack("p5", "trk5");
    // prior seg-0-30000 untouched (no new seg-21500-26500 upserted)
    expect(after!.segments!.find((s) => s.id === "seg-21500-26500")).toBeUndefined();
    expect(after!.segments!.find((s) => s.id === "seg-0-30000")!.samples)
      .toEqual(before!.segments!.find((s) => s.id === "seg-0-30000")!.samples);
    // agentAnchors STILL persisted (correction survives + re-seeds next time)
    expect((after!.agentAnchors ?? []).map((a) => [a.time, a.bbox])).toEqual([[22, [30, 31, 32, 33]]]);
  });
});

import { listTrackSegments } from "@/mcp/tools/tracking-tools";

describe("listTrackSegments reports agentAnchors", () => {
  it("returns agentAnchors + agentAnchorCount", async () => {
    await seed("p6", "f6", "trk6");
    const t0 = await readTrack("p6", "trk6");
    await writeTrack("p6", {
      ...t0!,
      agentAnchors: [{ id: "agt-22000", time: 22, bbox: [1, 2, 3, 4] }],
    });
    const res = await listTrackSegments({ trackId: "trk6" });
    expect(res.success).toBe(true);
    if (!res.success) throw new Error("expected success");
    expect(res.data!.agentAnchors).toEqual([{ time: 22, bbox: [1, 2, 3, 4] }]);
    expect(res.data!.agentAnchorCount).toBe(1);
  });
});
