import { describe, it, expect } from "vitest";
import { applyFitAndScale, resolveTrackedRect } from "@/lib/engine/overlay-renderer";
import { hitTest } from "@/lib/engine/overlays";
import type { Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";

const frame = { width: 608, height: 1080 };
const rect = { x: 0, y: 0, width: 608, height: 1080 };
const sample = { x: 200, y: 400, w: 100, h: 200 };

describe("resolveTrackedRect", () => {
  it("absent or zero offset is byte-identical to applyFitAndScale", () => {
    const base = applyFitAndScale(sample, rect, "tight", 1, frame);
    expect(resolveTrackedRect(sample, { rect, fit: "tight", scale: 1 }, frame)).toEqual(base);
    expect(
      resolveTrackedRect(sample, { rect, fit: "tight", scale: 1, offset: { x: 0, y: 0 } }, frame),
    ).toEqual(base);
  });

  it("translates by fractions of the RESOLVED box; size unchanged", () => {
    const base = applyFitAndScale(sample, rect, "tight", 1, frame);
    const r = resolveTrackedRect(
      sample,
      { rect, fit: "tight", scale: 1, offset: { x: 0.5, y: -1 } },
      frame,
    );
    expect(r.w).toBe(base.w);
    expect(r.h).toBe(base.h);
    expect(r.x).toBeCloseTo(base.x + 0.5 * base.w, 6);
    expect(r.y).toBeCloseTo(base.y - base.h, 6);
  });

  it("rides the subject's scale: half-size sample ⇒ half the px offset (tight fit)", () => {
    const big = { width: 4000, height: 4000 }; // keep clampToFrame inert
    const near = { x: 1000, y: 1000, w: 200, h: 400 };
    const far = { x: 1000, y: 1000, w: 100, h: 200 };
    const off = { x: 0, y: -0.5 };
    const dNear =
      applyFitAndScale(near, rect, "tight", 1, big).y -
      resolveTrackedRect(near, { rect, fit: "tight", scale: 1, offset: off }, big).y;
    const dFar =
      applyFitAndScale(far, rect, "tight", 1, big).y -
      resolveTrackedRect(far, { rect, fit: "tight", scale: 1, offset: off }, big).y;
    expect(dNear).toBeCloseTo(2 * dFar, 6);
  });
});

describe("hitTest honors the follow offset", () => {
  const track: Track = {
    id: "trk",
    fileId: "f1",
    method: "yoloe+botsort",
    framerate: 30,
    durationSec: 10,
    samples: [
      { t: 0, ...sample, confidence: 1, visible: true },
      { t: 10, ...sample, confidence: 1, visible: true },
    ],
    segments: [],
  } as unknown as Track;

  const overlay = {
    id: "o1",
    kind: "tracked",
    startTime: 0,
    duration: 10,
    z: 1,
    rect,
    opacity: 1,
    trackId: "trk",
    content: { kind: "emoji", char: "⬇" },
    fit: "tight",
    scale: 1,
    smoothing: "linear",
    offset: { x: 0, y: -1 },
  } as unknown as Overlay;

  it("hits at the OFFSET art location, misses at the raw track box", () => {
    // Raw box center: (250, 500). Offset {0,-1} moves the art one box-height up
    // → new center (250, 300).
    expect(hitTest(250, 300, [overlay], 1, { trk: track }, frame)?.id).toBe("o1");
    expect(hitTest(250, 500, [overlay], 1, { trk: track }, frame)).toBeNull();
  });
});
