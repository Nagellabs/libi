import { describe, it, expect, vi } from "vitest";
import {
  selectCandidateFrameTimes,
  CANDIDATE_PALETTE,
  CANDIDATE_PRESENCE_TOL_SEC,
  candidateColor,
  candidateBoxesAt,
  renderCandidateFrames,
} from "@/lib/tracking/identity-candidates-render";
import type { IdentityCandidate } from "@/lib/tracking/identity-candidates";

// Minimal solid 1x1 PNG buffer (raw bytes for a valid PNG).
// 137 80 78 71 ... — a 1×1 red PNG generated offline.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function makeExtract(_returnBuf = TINY_PNG) {
  return vi.fn(async (_srcPath: string, _time: number): Promise<Buffer> => {
    return _returnBuf;
  });
}

function makeCandidate(
  id: number,
  perFrame: { t: number; bbox: [number, number, number, number] }[],
): IdentityCandidate {
  return {
    candidateId: id,
    perFrame,
    meanTargetSim: null,
    frameCount: perFrame.length,
  };
}

// A simple fixed range + 1 time for all render tests.
const RANGE = { start: 5, end: 6 };
const FRAME_W = 16;
const FRAME_H = 16;

describe("identity-candidates-render helpers", () => {
  it("assigns a distinct palette color per candidate id (stable, cycling)", () => {
    expect(CANDIDATE_PALETTE.length).toBeGreaterThanOrEqual(4);
    expect(CANDIDATE_PALETTE[0]).not.toBe(CANDIDATE_PALETTE[1]);
  });

  it("selects sampled times within the window (uses verify-grid)", () => {
    const times = selectCandidateFrameTimes({ start: 20, end: 25 }, 5);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.every((t) => t >= 20 && t <= 25)).toBe(true);
  });
});

describe("candidateBoxesAt — pure selection helper", () => {
  it("present: candidate with perFrame at t=5.5 IS included when queried at t=5.5", () => {
    const c = makeCandidate(1, [{ t: 5.5, bbox: [10, 10, 50, 50] }]);
    const boxes = candidateBoxesAt([c], 5.5);
    expect(boxes.map((b) => b.candidateId)).toContain(1);
  });

  it("stale: candidate whose perFrame is all at t=0 is EXCLUDED when queried at t=5.5", () => {
    // This is the load-bearing regression test for the phantom-stale-box defect.
    // If the `if (Math.abs(pf.t - t) > tol) continue;` guard is removed, this FAILS.
    const c = makeCandidate(2, [{ t: 0.0, bbox: [1, 1, 4, 4] }]);
    const boxes = candidateBoxesAt([c], 5.5);
    expect(boxes.map((b) => b.candidateId)).not.toContain(2);
  });

  it("empty perFrame is excluded", () => {
    const c = makeCandidate(99, []);
    const boxes = candidateBoxesAt([c], 5.5);
    expect(boxes).toHaveLength(0);
  });

  it("two candidates get distinct colors; color follows array-index mod CANDIDATE_PALETTE.length", () => {
    const c0 = makeCandidate(10, [{ t: 5.5, bbox: [0, 0, 10, 10] }]);
    const c1 = makeCandidate(20, [{ t: 5.5, bbox: [20, 20, 10, 10] }]);
    const boxes = candidateBoxesAt([c0, c1], 5.5);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].color).toBe(CANDIDATE_PALETTE[0 % CANDIDATE_PALETTE.length]);
    expect(boxes[1].color).toBe(CANDIDATE_PALETTE[1 % CANDIDATE_PALETTE.length]);
    expect(boxes[0].color).not.toBe(boxes[1].color);
  });

  it("boundary: |pf.t - t| exactly 0.5 (== tol) is INCLUDED", () => {
    // The tolerance is inclusive: strictly-greater-than means exactly-equal passes.
    const c = makeCandidate(3, [{ t: 5.0, bbox: [1, 1, 4, 4] }]);
    const boxes = candidateBoxesAt([c], 5.5, 0.5);
    expect(boxes.map((b) => b.candidateId)).toContain(3);
  });

  it("boundary: |pf.t - t| = 0.51 (> tol) is EXCLUDED", () => {
    // Pins the tolerance value precisely: 0.51 must be rejected.
    const c = makeCandidate(4, [{ t: 5.0, bbox: [1, 1, 4, 4] }]);
    const boxes = candidateBoxesAt([c], 5.51, 0.5);
    expect(boxes.map((b) => b.candidateId)).not.toContain(4);
  });
});

describe("renderCandidateFrames — core render mapping", () => {
  it("(a) a candidate present at sampled time IS drawn (returns frames)", async () => {
    const extract = makeExtract();
    // candidate has a perFrame entry right at t=5.5 — well within the range.
    const nearCandidate = makeCandidate(1, [{ t: 5.5, bbox: [1, 1, 4, 4] }]);

    const frames = await renderCandidateFrames(
      {
        srcPath: "/fake/video.mp4",
        frameW: FRAME_W,
        frameH: FRAME_H,
        candidates: [nearCandidate],
        range: RANGE,
        framesPerWindow: 1,
      },
      { extractFrame: extract },
    );

    expect(frames.length).toBeGreaterThanOrEqual(1);
    // Extract was called (we actually rendered a frame).
    expect(extract).toHaveBeenCalled();
    // Each frame has a non-empty base64 PNG.
    for (const f of frames) {
      expect(f.pngBase64.length).toBeGreaterThan(10);
    }
  });

  it("(c) candidateColor cycles past CANDIDATE_PALETTE.length (mod wraps)", () => {
    const len = CANDIDATE_PALETTE.length;
    // Index 0 and index len should map to the same color (full cycle).
    expect(candidateColor(0)).toBe(candidateColor(len));
    // Index len-1 and index 2*len-1 should also match.
    expect(candidateColor(len - 1)).toBe(candidateColor(2 * len - 1));
    // Index 0 and index 1 should be distinct.
    expect(candidateColor(0)).not.toBe(candidateColor(1));
  });

  it("(d) a candidate with empty perFrame is skipped — no crash", async () => {
    const extract = makeExtract();
    const emptyCandidate = makeCandidate(99, []);

    await expect(
      renderCandidateFrames(
        {
          srcPath: "/fake/video.mp4",
          frameW: FRAME_W,
          frameH: FRAME_H,
          candidates: [emptyCandidate],
          range: RANGE,
          framesPerWindow: 1,
        },
        { extractFrame: extract },
      ),
    ).resolves.not.toThrow();
  });

  it("per-frame error isolation: one failing extract doesn't abort the whole batch", async () => {
    let callCount = 0;
    const extract = vi.fn(async (_srcPath: string, _time: number): Promise<Buffer> => {
      callCount++;
      if (callCount === 1) throw new Error("frame read error");
      return TINY_PNG;
    });

    const candidate = makeCandidate(1, [{ t: 5.5, bbox: [1, 1, 4, 4] }]);

    // Use framesPerWindow: 3 so we get multiple frames; the first will error.
    const frames = await renderCandidateFrames(
      {
        srcPath: "/fake/video.mp4",
        frameW: FRAME_W,
        frameH: FRAME_H,
        candidates: [candidate],
        range: { start: 5, end: 10 },
        framesPerWindow: 3,
      },
      { extractFrame: extract },
    );

    // Should still return some frames (those that didn't fail).
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });
});
