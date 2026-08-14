import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { applySegmentResult, shouldPersistLostSegment } from "@/lib/tracking/apply-segment-result";
import { readTrack } from "@/lib/tracking/storage";
import type { Track } from "@/lib/tracking/types";

afterEach(() => { cleanupTempDir(); });

describe("applySegmentResult", () => {
  it("creates a segmented track on first segment and upserts in place", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "Test Piece" }).run();
    db.insert(files).values({
      id: "f1", pieceId: "p1", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
      name: "v.mp4", description: "", type: "video", storagePath: "p1/v.mp4",
    }).run();

    const out = { samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }], framerate: 30 };
    const r = await applySegmentResult({
      db,
      file: { id: "f1", pieceId: "p1", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10 },
      trackId: "trk-a",
      range: { start: 0, end: 5 },
      method: "yoloe+botsort",
      objectKind: "object",
      out,
    });
    expect(r.segmentId).toBe("seg-0-5000");
    const t = await readTrack("p1", "trk-a");
    expect(t?.segments?.[0]?.samples.length).toBe(1);
    expect(t?.segments?.[0]?.status).toBe("ok");
  });

  it("upserts in place on an existing track and yields 'lost' when no visible samples", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f1", pieceId: "p1", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
      name: "v.mp4", description: "", type: "video", storagePath: "p1/v.mp4",
    }).run();

    await applySegmentResult({
      db, file: { id: "f1", pieceId: "p1", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10 },
      trackId: "trk-b", range: { start: 0, end: 5 }, method: "yoloe+botsort", objectKind: "object",
      out: { samples: [{ t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }], framerate: 30 },
    });

    // second call: same trackId, different range, NO visible samples → 'lost'
    const r2 = await applySegmentResult({
      db, file: { id: "f1", pieceId: "p1", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10 },
      trackId: "trk-b", range: { start: 5, end: 8 }, method: "yoloe+botsort", objectKind: "object",
      out: { samples: [{ t: 5, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false }], framerate: 30 },
    });
    expect(r2.segmentId).toBe("seg-5000-8000");

    const t = await readTrack("p1", "trk-b");
    expect(t?.segments?.length).toBe(2);
    const seg2 = t?.segments?.find((s) => s.id === "seg-5000-8000");
    expect(seg2?.status).toBe("lost");
    // first segment still present (upsert in place did not wipe siblings)
    expect(t?.segments?.some((s) => s.id === "seg-0-5000")).toBe(true);
  });
});

describe("applySegmentResult fresh-track all-lost", () => {
  it("persists an honest 'lost' segment when the FIRST segment has no visible samples", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "pz", name: "pz", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "fz", pieceId: "pz", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 608, mediaHeight: 1080, mediaDuration: 21.267,
      name: "v.mp4", description: "", type: "video", storagePath: "pz/v.mp4",
    }).run();

    const r = await applySegmentResult({
      db, file: { id: "fz", pieceId: "pz", mediaWidth: 608, mediaHeight: 1080, mediaDuration: 21.267 },
      trackId: "trk-fresh-lost", range: { start: 0, end: 2.367 },
      method: "yoloe+botsort", objectKind: "object",
      out: { samples: [{ t: 0, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false }], framerate: 30 },
    });
    expect(r.segmentId).toBe("seg-0-2367");

    // The track row + a 'lost' segment now EXIST (not silently discarded).
    const t = await readTrack("pz", "trk-fresh-lost");
    expect(t?.segments?.length).toBe(1);
    expect(t?.segments?.[0]?.status).toBe("lost");
    // And the summary flags it as an engine miss.
    expect(r.summary.flags).toContain("no_output");
  });
});

describe("shouldPersistLostSegment (multi-window NEVER-MAKE-WORSE gate)", () => {
  const mkTrack = (segments: NonNullable<Track["segments"]>): Pick<Track, "segments"> =>
    ({ segments });
  const goodSeg = (start: number, end: number, id = `seg-${start * 1000}-${end * 1000}`) => ({
    id, startTime: start, endTime: end,
    method: "yoloe+botsort" as const, status: "ok" as const,
    samples: [{ t: (start + end) / 2, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }],
  });
  const lostSeg = (start: number, end: number, id = `seg-${start * 1000}-${end * 1000}`) => ({
    id, startTime: start, endTime: end,
    method: "yoloe+botsort" as const, status: "lost" as const,
    samples: [{ t: start, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false }],
  });

  it("persists on a fresh track (no prior track at all)", () => {
    expect(shouldPersistLostSegment(null, { start: 0, end: 5 })).toBe(true);
  });

  it("persists an all-lost result for a NON-overlapping window even when the track already exists (the multi-shot fan-out bug)", () => {
    // Shot 1 [0,2.367] persisted (even as lost) created the track; shot 2
    // [2.367, 5] all-lost must STILL be persisted — nothing covers it.
    const track = mkTrack([lostSeg(0, 2.367)]);
    expect(shouldPersistLostSegment(track, { start: 2.367, end: 5 })).toBe(true);
  });

  it("persists when the prior track has a GOOD segment for a different, non-overlapping window", () => {
    const track = mkTrack([goodSeg(0, 5)]);
    // Contiguous shot boundary (end == next start) is NOT overlap.
    expect(shouldPersistLostSegment(track, { start: 5, end: 8 })).toBe(true);
  });

  it("protects (discards the lost result) when a prior segment overlapping the range has visible samples", () => {
    const track = mkTrack([goodSeg(0, 5)]);
    expect(shouldPersistLostSegment(track, { start: 0, end: 5 })).toBe(false);
    expect(shouldPersistLostSegment(track, { start: 1, end: 3 })).toBe(false);
  });

  it("persists when the overlapping prior segment is itself lost/empty (nothing worth protecting)", () => {
    const track = mkTrack([lostSeg(0, 5)]);
    expect(shouldPersistLostSegment(track, { start: 0, end: 5 })).toBe(true);
  });

  it("persists when the overlapping prior segment's visible samples all lie OUTSIDE the disputed range", () => {
    // Wide engine seed [0,20] visible only around t=2.5; a lost result for
    // [10,15] shadows nothing visible — persist the honest lost.
    const wide = goodSeg(0, 20);
    wide.samples = [{ t: 2.5, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }];
    expect(shouldPersistLostSegment(mkTrack([wide]), { start: 10, end: 15 })).toBe(true);
  });
});

describe("multi-window fan-out persistence (regression: shots after the first must not be dropped)", () => {
  it("persists a lost segment for window B after a good segment exists for window A", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "pm", name: "pm", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "fm", pieceId: "pm", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 608, mediaHeight: 1080, mediaDuration: 10,
      name: "v.mp4", description: "", type: "video", storagePath: "pm/v.mp4",
    }).run();
    const file = { id: "fm", pieceId: "pm", mediaWidth: 608, mediaHeight: 1080, mediaDuration: 10 };

    // Window A: good.
    await applySegmentResult({
      db, file, trackId: "trk-multi", range: { start: 0, end: 4 },
      method: "yoloe+botsort", objectKind: "object",
      out: { samples: [{ t: 1, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }], framerate: 30 },
    });

    // Window B (non-overlapping): all-lost. Gate must say persist...
    const prior = await readTrack("pm", "trk-multi");
    expect(shouldPersistLostSegment(prior, { start: 4, end: 8 })).toBe(true);
    // ...and persisting yields an honest lost segment alongside the good one.
    await applySegmentResult({
      db, file, trackId: "trk-multi", range: { start: 4, end: 8 },
      method: "yoloe+botsort", objectKind: "object",
      out: { samples: [{ t: 4, x: 0, y: 0, w: 0, h: 0, confidence: 0, visible: false }], framerate: 30 },
    });
    const t = await readTrack("pm", "trk-multi");
    expect(t?.segments?.length).toBe(2);
    expect(t?.segments?.find((s) => s.id === "seg-4000-8000")?.status).toBe("lost");
    expect(t?.segments?.find((s) => s.id === "seg-0-4000")?.status).toBe("ok");

    // An all-lost result for window A (overlapping the GOOD segment) is protected.
    expect(shouldPersistLostSegment(t, { start: 0, end: 4 })).toBe(false);
  });
});

describe("applySegmentResult provenance", () => {
  it("defaults to engine and stamps createdAt", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p3", name: "p3", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f3", pieceId: "p3", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
      name: "v.mp4", description: "", type: "video", storagePath: "p3/v.mp4",
    }).run();

    await applySegmentResult({
      db,
      file: { id: "f3", pieceId: "p3", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10 },
      trackId: "trk-prov-default",
      range: { start: 0, end: 5 },
      method: "yoloe+botsort",
      objectKind: "object",
      out: { samples: [{ t: 1, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }], framerate: 30 },
    });

    const t = await readTrack("p3", "trk-prov-default");
    const seg = t?.segments?.[0];
    expect(seg?.provenance).toBe("engine");
    expect(typeof seg?.createdAt).toBe("number");
  });

  it("honors an explicit provenance", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p4", name: "p4", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f4", pieceId: "p4", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
      name: "v.mp4", description: "", type: "video", storagePath: "p4/v.mp4",
    }).run();

    await applySegmentResult({
      db,
      file: { id: "f4", pieceId: "p4", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10 },
      trackId: "trk-prov-manual",
      range: { start: 0, end: 5 },
      method: "yoloe+botsort",
      objectKind: "object",
      provenance: "manual",
      out: { samples: [{ t: 1, x: 1, y: 2, w: 3, h: 4, confidence: 1, visible: true }], framerate: 30 },
    });

    const t = await readTrack("p4", "trk-prov-manual");
    const seg = t?.segments?.[0];
    expect(seg?.provenance).toBe("manual");
  });
});
