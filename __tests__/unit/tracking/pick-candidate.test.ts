import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { applySegmentResult } from "@/lib/tracking/apply-segment-result";
import { pickCandidate } from "@/mcp/tools/tracking-tools";
import { readTrack } from "@/lib/tracking/storage";
import type { IdentityCandidate } from "@/lib/tracking/identity-candidates";

afterEach(() => {
  cleanupTempDir();
});

describe("pickCandidate", () => {
  it("writes the picked candidate as an authoritative agent segment that owns its window", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "Test Piece", createdAt: new Date() }).run();
    db.insert(files)
      .values({
        id: "f1",
        pieceId: "p1",
        filename: "v.mp4",
        contentType: "video/mp4",
        size: 1,
        createdAt: new Date(),
        mediaWidth: 1920,
        mediaHeight: 1080,
        mediaDuration: 30,
        name: "v.mp4",
        description: "",
        type: "video",
        storagePath: "p1/v.mp4",
      })
      .run();

    // Seed the track: an ENGINE segment over [20,25] that locks the WRONG
    // subject (cameraman) — fixed at x=900.
    await applySegmentResult({
      db,
      file: { id: "f1", pieceId: "p1", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 30 },
      trackId: "trk-pick",
      range: { start: 20, end: 25 },
      method: "yoloe+botsort",
      objectKind: "object",
      provenance: "engine",
      out: {
        samples: [
          { t: 20, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true },
          { t: 22, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true },
          { t: 24, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true },
        ],
        framerate: 30,
      },
    });

    // Sanity: the engine seed owns the window before the pick.
    const before = await readTrack("p1", "trk-pick");
    const beforeAt22 = before!.samples.find((p) => Math.abs(p.t - 22) < 0.1)!;
    expect(beforeAt22.x).toBeCloseTo(900, 0);

    // Lisa is candidate #3, fixed at x=120.
    const lisaXAt22 = 120;
    const injectedCandidates: IdentityCandidate[] = [
      {
        candidateId: 7,
        perFrame: [
          { t: 20, bbox: [900, 100, 80, 200] },
          { t: 22, bbox: [900, 100, 80, 200] },
          { t: 24, bbox: [900, 100, 80, 200] },
        ],
        meanTargetSim: 0.41,
        frameCount: 3,
      },
      {
        candidateId: 3,
        perFrame: [
          { t: 20, bbox: [lisaXAt22, 80, 90, 220] },
          { t: 22, bbox: [lisaXAt22, 80, 90, 220] },
          { t: 24, bbox: [lisaXAt22, 80, 90, 220] },
        ],
        meanTargetSim: 0.88,
        frameCount: 3,
      },
    ];

    const res = await pickCandidate({
      trackId: "trk-pick",
      range: { start: 20, end: 25 },
      candidateId: 3,
      _db: db,
      _candidates: injectedCandidates,
    });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error("pickCandidate failed: " + res.error);
    expect(res.data?.trackId).toBe("trk-pick");

    const t = await readTrack("p1", "trk-pick");
    // The picked segment is provenance:"agent" and covers the window.
    const seg = t!.segments!.find(
      (s) => s.startTime <= 20 && s.endTime >= 25 && s.provenance === "agent",
    );
    expect(seg).toBeTruthy();

    // Derived in-window samples now follow the PICKED (Lisa) boxes, NOT engine.
    const at22 = t!.samples.find((p) => Math.abs(p.t - 22) < 0.1)!;
    expect(at22.x).toBeCloseTo(lisaXAt22, 0);
    expect(at22.x).not.toBeCloseTo(900, 0);

    // The pick is recorded in agentAnchors so a later recompute re-seeds from it.
    expect((t!.agentAnchors ?? []).length).toBeGreaterThan(0);
    const anchorAt22 = (t!.agentAnchors ?? []).find((a) => Math.abs(a.time - 22) < 0.1);
    expect(anchorAt22).toBeTruthy();
    expect(anchorAt22!.bbox[0]).toBeCloseTo(lisaXAt22, 0);

    // I2: agentAnchors must be SPARSE (≤8) — NOT one per perFrame point. With
    // the old per-frame flood a dense perFrame would persist hundreds and
    // over-constrain later re-tracks.
    expect((t!.agentAnchors ?? []).length).toBeLessThanOrEqual(8);
  });

  it("I2: writes SPARSE (≤8) agentAnchors even for a dense perFrame candidate", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p-sparse", name: "p-sparse", createdAt: new Date() }).run();
    db.insert(files)
      .values({
        id: "f-sparse",
        pieceId: "p-sparse",
        filename: "v.mp4",
        contentType: "video/mp4",
        size: 1,
        createdAt: new Date(),
        mediaWidth: 1920,
        mediaHeight: 1080,
        mediaDuration: 30,
        name: "v.mp4",
        description: "",
        type: "video",
        storagePath: "p-sparse/v.mp4",
      })
      .run();

    await applySegmentResult({
      db,
      file: {
        id: "f-sparse",
        pieceId: "p-sparse",
        mediaWidth: 1920,
        mediaHeight: 1080,
        mediaDuration: 30,
      },
      trackId: "trk-sparse",
      range: { start: 20, end: 25 },
      method: "yoloe+botsort",
      objectKind: "object",
      provenance: "engine",
      out: {
        samples: [{ t: 22, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true }],
        framerate: 30,
      },
    });

    // ~150 perFrame points (5s @ 30fps) — the old per-frame write would have
    // persisted ~150 agentAnchors.
    const densePerFrame = Array.from({ length: 150 }, (_, i) => ({
      t: 20 + i * (5 / 150),
      bbox: [120, 80, 90, 220] as [number, number, number, number],
    }));

    const res = await pickCandidate({
      trackId: "trk-sparse",
      range: { start: 20, end: 25 },
      candidateId: 3,
      _db: db,
      _candidates: [
        { candidateId: 3, perFrame: densePerFrame, meanTargetSim: 0.9, frameCount: 150 },
      ],
    });

    expect(res.success).toBe(true);
    const t = await readTrack("p-sparse", "trk-sparse");
    expect((t!.agentAnchors ?? []).length).toBeGreaterThan(0);
    expect((t!.agentAnchors ?? []).length).toBeLessThanOrEqual(8);
  });

  it("I1: NEVER MAKE WORSE — a candidate with no usable frames fails loud and leaves prior samples untouched", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p-nmw", name: "p-nmw", createdAt: new Date() }).run();
    db.insert(files)
      .values({
        id: "f-nmw",
        pieceId: "p-nmw",
        filename: "v.mp4",
        contentType: "video/mp4",
        size: 1,
        createdAt: new Date(),
        mediaWidth: 1920,
        mediaHeight: 1080,
        mediaDuration: 30,
        name: "v.mp4",
        description: "",
        type: "video",
        storagePath: "p-nmw/v.mp4",
      })
      .run();

    // Pre-existing GOOD engine segment over [20,25] at x=900 (mirrors the
    // happy-path setup).
    await applySegmentResult({
      db,
      file: { id: "f-nmw", pieceId: "p-nmw", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 30 },
      trackId: "trk-nmw",
      range: { start: 20, end: 25 },
      method: "yoloe+botsort",
      objectKind: "object",
      provenance: "engine",
      out: {
        samples: [
          { t: 20, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true },
          { t: 22, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true },
          { t: 24, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true },
        ],
        framerate: 30,
      },
    });

    const before = await readTrack("p-nmw", "trk-nmw");
    const beforeAt22 = before!.samples.find((p) => Math.abs(p.t - 22) < 0.1)!;
    expect(beforeAt22.x).toBeCloseTo(900, 0);
    const beforeAnchorCount = (before!.agentAnchors ?? []).length;

    // Picked candidate has NO usable frames (empty perFrame).
    const res = await pickCandidate({
      trackId: "trk-nmw",
      range: { start: 20, end: 25 },
      candidateId: 3,
      _db: db,
      _candidates: [{ candidateId: 3, perFrame: [], meanTargetSim: 0.9, frameCount: 0 }],
    });

    // Fails loud with the no-usable-frames error.
    expect(res.success).toBe(false);
    if (res.success) throw new Error("expected pickCandidate to fail on empty perFrame");
    expect(res.error).toMatch(/no usable frames/i);

    // Prior engine samples in [20,25] are UNTOUCHED — no blank/lost agent
    // segment was written.
    const after = await readTrack("p-nmw", "trk-nmw");
    const afterAt22 = after!.samples.find((p) => Math.abs(p.t - 22) < 0.1)!;
    expect(afterAt22.x).toBeCloseTo(900, 0);
    const agentSeg = (after!.segments ?? []).find(
      (s) => s.provenance === "agent" && s.startTime <= 20 && s.endTime >= 25,
    );
    expect(agentSeg).toBeUndefined();
    // agentAnchors not flooded by the failed pick.
    expect((after!.agentAnchors ?? []).length).toBe(beforeAnchorCount);
  });

  it("returns ambiguous:false-equivalent failure when the candidateId is not found", async () => {
    await createTempStorageDir();
    const db = createTestDb();
    db.insert(pieces).values({ id: "p2", name: "p2", createdAt: new Date() }).run();
    db.insert(files)
      .values({
        id: "f2",
        pieceId: "p2",
        filename: "v.mp4",
        contentType: "video/mp4",
        size: 1,
        createdAt: new Date(),
        mediaWidth: 1920,
        mediaHeight: 1080,
        mediaDuration: 30,
        name: "v.mp4",
        description: "",
        type: "video",
        storagePath: "p2/v.mp4",
      })
      .run();

    await applySegmentResult({
      db,
      file: { id: "f2", pieceId: "p2", mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 30 },
      trackId: "trk-pick-2",
      range: { start: 20, end: 25 },
      method: "yoloe+botsort",
      objectKind: "object",
      provenance: "engine",
      out: {
        samples: [{ t: 22, x: 900, y: 100, w: 80, h: 200, confidence: 1, visible: true }],
        framerate: 30,
      },
    });

    const res = await pickCandidate({
      trackId: "trk-pick-2",
      range: { start: 20, end: 25 },
      candidateId: 999,
      _db: db,
      _candidates: [
        { candidateId: 3, perFrame: [{ t: 22, bbox: [120, 80, 90, 220] }], meanTargetSim: 0.9, frameCount: 1 },
      ],
    });

    expect(res.success).toBe(false);
  });
});
