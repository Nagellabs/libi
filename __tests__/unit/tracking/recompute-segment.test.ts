import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { recomputeTrackSegmentServerSide } from "@/lib/tracking/recompute-segment";
import { initSegmentedTrack, upsertSegment } from "@/lib/tracking/segment-store";
import { readTrack } from "@/lib/tracking/storage";

afterEach(() => { cleanupTempDir(); });

describe("recomputeTrackSegmentServerSide", () => {
  it("re-tracks a BOUNDED window inside the containing segment and does NOT destroy the rest", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f1", pieceId: "p1", filename: "v.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 20,
      // NOT NULL columns required by the schema
      name: "v.mp4", description: "", type: "video", storagePath: "p1/v.mp4",
    }).run();
    await initSegmentedTrack({ trackId: "trk1", fileId: "f1", framerate: 30, method: "yoloe+botsort" });
    await upsertSegment("trk1", { id: "seg-0-10000", startTime: 0, endTime: 10,
      method: "yoloe+botsort", status: "ok", samples: [{ t: 0, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }] });

    let captured: { kind: string; params: Record<string, unknown> } | null = null;
    const r = await recomputeTrackSegmentServerSide(
      { db, fileId: "f1", trackId: "trk1", time: 5,
        manualAnchors: [{ id: "man-5000", time: 5, bbox: [100, 100, 50, 60] }] },
      {
        runJob: async (kind, params) => {
          captured = { kind, params };
          return { samples: [{ t: 5, x: 100, y: 100, w: 50, h: 60, confidence: 1, visible: true }], framerate: 30 };
        },
      },
    );

    expect(captured!.kind).toBe("tracking");
    // BOUNDED: containing seg is [0,10] but a manual re-anchor only re-tracks
    // ±W(3) around the pin (t=5) → [2,8]. It must NOT re-track the whole
    // segment (that's what destroyed real tracks).
    expect(captured!.params.range).toEqual({ start: 2, end: 8 });
    expect(captured!.params.method).toBe("yoloe+botsort");
    expect(captured!.params.anchors).toEqual([{ fileId: "f1", time: 5, bbox: [100, 100, 50, 60] }]);
    expect(r.segmentId).toBe("seg-2000-8000");
    const t = await readTrack("p1", "trk1");
    const ids = (t?.segments ?? []).map((s) => s.id);
    // The narrow re-tracked segment was added…
    expect(ids).toContain("seg-2000-8000");
    expect(
      (t?.segments ?? []).find((s) => s.id === "seg-2000-8000")?.samples?.[0]?.x,
    ).toBe(100);
    // …and the ORIGINAL wide segment was NOT destroyed.
    expect(ids).toContain("seg-0-10000");
  });

  it("anchor outside all OK segments → fallback window + method inherited from nearest OK segment", async () => {
    // Reasoning (post-fix bounded logic):
    //   upsertSegment writes durationSec from the derived samples; the only
    //   sample here is {t:0}, so track.durationSec = 0.
    //   recompute: no OK seg contains t=20 (only [0,5]) → `containing`
    //   undefined → segStart=0, segEnd = durationSec>0 ? durationSec : time+W
    //   = 20+3 = 23. range = { start: max(0,20-3)=17, end: min(23,20+3)=23 }
    //   = { start: 17, end: 23 }. Method inherited from the nearest OK seg.
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f2", pieceId: "p1", filename: "v2.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 30,
      name: "v2.mp4", description: "", type: "video", storagePath: "p1/v2.mp4",
    }).run();
    await initSegmentedTrack({ trackId: "trk2", fileId: "f2", framerate: 30, method: "sot" });
    await upsertSegment("trk2", {
      id: "seg-0-5000", startTime: 0, endTime: 5,
      method: "sot", status: "ok", objectKind: "object",
      samples: [{ t: 0, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }],
    });

    let captured: { kind: string; params: Record<string, unknown> } | null = null;
    await recomputeTrackSegmentServerSide(
      {
        db, fileId: "f2", trackId: "trk2", time: 20,
        manualAnchors: [{ id: "man-20000", time: 20, bbox: [9, 9, 4, 4] }],
      },
      {
        runJob: async (kind, params) => {
          captured = { kind, params };
          return { samples: [{ t: 20, x: 9, y: 9, w: 4, h: 4, confidence: 1, visible: true }], framerate: 30 };
        },
      },
    );

    // Method should be inherited from the nearest (and only) OK segment, not defaulted to "yoloe+botsort".
    expect(captured!.params.method).toBe("sot");
    // Range uses ±3 fallback window: durationSec=0 → dur=23 → { start:17, end:23 }
    expect(captured!.params.range).toEqual({ start: 17, end: 23 });
  });

  it("file not assigned to a piece → throws", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p9", name: "p9", createdAt: new Date() }).run();
    // Insert file with pieceId: null (unassigned global file)
    db.insert(files).values({
      id: "f9", pieceId: null, filename: "orphan.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(),
      name: "orphan.mp4", description: "", type: "video", storagePath: "_global/orphan.mp4",
    }).run();

    await expect(
      recomputeTrackSegmentServerSide({
        db, fileId: "f9", trackId: "whatever", time: 1, manualAnchors: [],
      }),
    ).rejects.toThrow();
  });
});

describe("recompute-segment Fix-B: no-detection hole filled from anchor when prior was visible", () => {
  it("fills a pure no-detection hole (visible:false, no targetSim) when prior was visible and anchor is present", async () => {
    // This is the literal seg-933-6933 Fix-B case: the engine returns visible:false
    // (no-detection, NOT low-sim — targetSim is absent) for a window [2.7,3.8]
    // where the prior track was visible. An in-range manual anchor at t=3 asserts
    // the subject IS there. After fill: samples at 2.7..3.8 must be visible:true,
    // confidence:0, box from anchor interpolation.
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p20", name: "p20", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f20", pieceId: "p20", filename: "v20.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
      name: "v20.mp4", description: "", type: "video", storagePath: "p20/v20.mp4",
    }).run();

    // Prior: visible everywhere across [0..6] (the reanchor window for time=3).
    const priorSamples = Array.from({ length: 61 }, (_, i) => ({
      t: i / 10, x: 50, y: 50, w: 20, h: 20, confidence: 1, visible: true,
    }));
    await initSegmentedTrack({ trackId: "trk20", fileId: "f20", framerate: 10, method: "yoloe+botsort" });
    await upsertSegment("trk20", {
      id: "seg-0-10000", startTime: 0, endTime: 10,
      method: "yoloe+botsort", status: "ok",
      samples: priorSamples,
    });

    // Job returns: visible:false across the whole window (no-detection — NO targetSim),
    // simulating the engine losing the subject entirely in [2.7,3.8].
    // The window around time=3 is [0,6] (max(0,3-3)=0, min(10,3+3)=6).
    const jobSamples = Array.from({ length: 61 }, (_, i) => ({
      t: i / 10,
      x: 0, y: 0, w: 0, h: 0,
      confidence: 0, visible: false,
      // No targetSim — pure no-detection, NOT a wrong-subject lock
    }));

    await recomputeTrackSegmentServerSide(
      {
        db, fileId: "f20", trackId: "trk20", time: 3,
        manualAnchors: [{ id: "man-3000", time: 3, bbox: [100, 100, 30, 30] }],
      },
      {
        runJob: async (_kind, _params) => ({ samples: jobSamples, framerate: 10 }),
      },
    );

    // reanchorWindow: containing=[0,10], time=3, W=3 → {start:0, end:6} → segmentId="seg-0-6000"
    const track = await readTrack("p20", "trk20");
    const seg = (track?.segments ?? []).find((s) => s.id === "seg-0-6000");
    expect(seg).toBeDefined();

    // Samples at 2.7 and 3.8 — prior was visible, anchor present → must be filled
    const at27 = seg!.samples.find((s: { t: number }) => Math.abs(s.t - 2.7) < 0.05)!;
    const at38 = seg!.samples.find((s: { t: number }) => Math.abs(s.t - 3.8) < 0.05)!;
    expect(at27).toBeDefined();
    expect(at38).toBeDefined();
    expect(at27.visible).toBe(true);  // filled, not a gap
    expect(at38.visible).toBe(true);  // filled, not a gap
    expect(at27.confidence).toBe(0);  // honest: held, not detected
    expect(at38.confidence).toBe(0);

    // No visible:false samples in the 2.7..3.8 hole range should remain
    const inHole = seg!.samples.filter(
      (s: { t: number; visible: boolean }) => s.t >= 2.7 && s.t <= 3.8,
    );
    expect(inHole.every((s: { visible: boolean }) => s.visible)).toBe(true);
  });
});

describe("recompute-segment reject+fill (no-regress)", () => {
  it("rejects a sustained wrong-subject run and rides the manual anchor through it", async () => {
    // Mock job returns: t=0..2 at 0.1s steps, all sim~0.6 (cameraman, visible:true, x=9).
    // The prior track has those same times as visible.
    // Manual anchor at t=1 says the subject is at x=200.
    // After reject: all cameraman samples become visible:false.
    // After fill: samples where prior was visible are ridden from the anchor
    //   at t=1 (x=200), so mid.x===200, visible:true, confidence:0.
    // None of the final samples should be visible && x===9.
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p10", name: "p10", createdAt: new Date() }).run();
    db.insert(files).values({
      id: "f10", pieceId: "p10", filename: "v10.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 10,
      name: "v10.mp4", description: "", type: "video", storagePath: "p10/v10.mp4",
    }).run();

    // Seed an existing segment with prior visible samples at t=0..2 (so fill knows it was visible).
    const priorSamples = Array.from({ length: 21 }, (_, i) => ({
      t: i / 10, x: 50, y: 50, w: 20, h: 20, confidence: 1, visible: true,
    }));
    await initSegmentedTrack({ trackId: "trk10", fileId: "f10", framerate: 10, method: "yoloe+botsort" });
    await upsertSegment("trk10", {
      id: "seg-0-10000", startTime: 0, endTime: 10,
      method: "yoloe+botsort", status: "ok",
      samples: priorSamples,
    });

    // The mock job returns sustained cameraman samples: x=9, targetSim=0.6.
    const jobSamples = Array.from({ length: 21 }, (_, i) => ({
      t: i / 10, x: 9, y: 9, w: 10, h: 10, confidence: 1, visible: true, targetSim: 0.6,
    }));

    await recomputeTrackSegmentServerSide(
      {
        db, fileId: "f10", trackId: "trk10", time: 1,
        manualAnchors: [{ id: "man-1000", time: 1, bbox: [200, 0, 20, 20] }],
      },
      {
        runJob: async (_kind, _params) => ({ samples: jobSamples, framerate: 10 }),
      },
    );

    // Read the upserted segment (reanchorWindow: containing=[0,10], time=1, window=3
    // → start=max(0,1-3)=0, end=min(10,1+3)=4 → segmentId="seg-0-4000").
    const track = await readTrack("p10", "trk10");
    const seg = (track?.segments ?? []).find((s) => s.id === "seg-0-4000");
    expect(seg).toBeDefined();

    const mid = seg!.samples.find((s: { t: number }) => Math.abs(s.t - 1) < 1e-6)!;
    expect(mid).toBeDefined();
    expect(mid.visible).toBe(true);
    expect(mid.x).toBe(200);         // rode the manual anchor, NOT cameraman x=9
    expect(mid.confidence).toBe(0);  // honest held

    // No sample in the window is a visible cameraman box (x===9)
    expect(seg!.samples.some((s: { visible: boolean; x: number }) =>
      s.visible && s.x === 9)).toBe(false);
  });
});
