import { describe, expect, it } from "vitest";
import { resolveExportBase, isBaseShapedVideoOverlay, baseCut, streamCopyKeepsTimeline } from "@/lib/export/export-base";
import type { Composition, Overlay } from "@/lib/engine/types";

function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1", width: 1920, height: 1080, fps: 30,
    overlays: [], audioClips: [],
    ...over,
  } as unknown as Composition;
}

function baseOverlay(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "vid-1", kind: "video", fileId: "f1",
    startTime: 0, duration: 10, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    fit: "cover",
    ...over,
  } as unknown as Overlay;
}

describe("isBaseShapedVideoOverlay", () => {
  it("accepts a full-frame, untransformed, bottom-z video overlay at t=0", () => {
    const c = comp({ overlays: [baseOverlay()] });
    expect(isBaseShapedVideoOverlay(c.overlays![0], c)).toBe(true);
  });

  it("rejects a rect that is not the full canvas", () => {
    const o = baseOverlay({ rect: { x: 10, y: 0, width: 1900, height: 1080 } });
    expect(isBaseShapedVideoOverlay(o, comp({ overlays: [o] }))).toBe(false);
  });

  it("rejects a non-zero startTime (ffmpeg base input starts at 0)", () => {
    const o = baseOverlay({ startTime: 2 });
    expect(isBaseShapedVideoOverlay(o, comp({ overlays: [o] }))).toBe(false);
  });

  it("rejects partial opacity — the base is opaque by definition", () => {
    const o = baseOverlay({ opacity: 0.5 });
    expect(isBaseShapedVideoOverlay(o, comp({ overlays: [o] }))).toBe(false);
  });

  it("rejects fit:'contain' (base scenes letterboxed; the fast path composites cover)", () => {
    const o = baseOverlay({ fit: "contain" });
    expect(isBaseShapedVideoOverlay(o, comp({ overlays: [o] }))).toBe(false);
  });

  it("rejects a rotated overlay", () => {
    // NOTE: adapted from the brief's `{ rotation: 15 }` — there is no legacy
    // top-level `rotation` field (deliberately deleted; see
    // lib/engine/overlay-transform.ts:22-24, "There is no legacy `rotation`
    // (degrees) field: it was deleted..."). `transform3d` is the only rotation
    // authority `overlayHasNonIdentityTransform` reads, so a genuine rotation
    // must be expressed there or the predicate has nothing to reject.
    const o = baseOverlay({
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (15 * Math.PI) / 180 } },
    });
    expect(isBaseShapedVideoOverlay(o, comp({ overlays: [o] }))).toBe(false);
  });

  it("rejects a keyframed overlay", () => {
    // NOTE: adapted from the brief's `{ rect: [{ t: 0, value: {...} }] } }` —
    // `Keyframed<T>` (lib/engine/animatable.ts) wraps the entries in a
    // `{ keyframes: [...] }` object, it is not a bare array. `overlayHasKeyframes`
    // reads `track.keyframes`, so a bare array under `rect` has no `.keyframes`
    // property and would never trip the check.
    const o = baseOverlay({
      keyframes: { rect: { keyframes: [{ t: 0, value: { x: 0, y: 0, width: 10, height: 10 } }] } },
    });
    expect(isBaseShapedVideoOverlay(o, comp({ overlays: [o] }))).toBe(false);
  });

  it("rejects a video overlay that is NOT the lowest z", () => {
    const bg = baseOverlay({ id: "vid-bg", z: 5 });
    const other = baseOverlay({ id: "vid-other", z: 1, kind: "text" });
    expect(isBaseShapedVideoOverlay(bg, comp({ overlays: [bg, other] }))).toBe(false);
  });
});

describe("resolveExportBase", () => {
  it("returns null for a comp with no base at all", () => {
    expect(resolveExportBase(comp())).toBeNull();
  });

  it("resolves a base-shaped video overlay, carrying trim through", () => {
    const o = baseOverlay({ trim: { start: 1, end: 6 } });
    const r = resolveExportBase(comp({ overlays: [o] }));
    expect(r).toEqual({
      fileId: "f1",
      duration: 10,
      trim: { start: 1, end: 6 },
      overlayId: "vid-1",
      // Not hydrated on this fixture → UNKNOWN, which the classifier reads as
      // "cannot stream-copy" (see streamCopyPreservesFraming).
      sourceWidth: null,
      sourceHeight: null,
    });
  });

  it("resolves the LOWER-z video as base when two full-frame videos stack", () => {
    // Revised from Task 1's "returns null when two video overlays stack": extra
    // video overlays above the base are composited by ffmpeg-overlay as extra
    // `-i` inputs, so a second video no longer disqualifies the fast path. Only
    // the bottom, full-frame one is the base — the other is an overlay on top.
    const a = baseOverlay({ id: "a", z: 0 });
    const b = baseOverlay({ id: "b", z: 1 });
    expect(resolveExportBase(comp({ overlays: [a, b] }))?.overlayId).toBe("a");
  });

  it("resolves the plate as base when an inset PIP video sits on top", () => {
    // The background-removal shape: a full-frame plate + a small cutout above
    // it. Pre-relaxation this returned null and every such export went through
    // headless Chromium.
    const plate = baseOverlay({ id: "plate", z: 0 });
    const pip = baseOverlay({
      id: "pip",
      z: 1,
      rect: { x: 100, y: 100, width: 480, height: 270 },
    });
    const r = resolveExportBase(comp({ overlays: [plate, pip] }));
    expect(r?.overlayId).toBe("plate");
    expect(r?.fileId).toBe("f1");
  });

  it("returns null when two videos TIE at the lowest z (ambiguous base)", () => {
    // Both satisfy the predicate, so which one is `[0:v]` is a coin flip. A
    // wrong base is a wrong video — fall back rather than guess.
    const a = baseOverlay({ id: "a", z: 0 });
    const b = baseOverlay({ id: "b", z: 0 });
    expect(resolveExportBase(comp({ overlays: [a, b] }))).toBeNull();
  });

  it("returns null when the only video is an inset (no full-frame base)", () => {
    const pip = baseOverlay({ id: "pip", rect: { x: 100, y: 100, width: 480, height: 270 } });
    expect(resolveExportBase(comp({ overlays: [pip] }))).toBeNull();
  });
});

// A stream that starts after the cut (docs-local/qa/2026-09-25-mediabunny-upgrade-report.md,
// Export lead fix). Rendered with real ffmpeg in export-source-lead.test.ts.
describe("baseCut", () => {
  it("seeks the input as before when the video has started by the cut", () => {
    expect(baseCut(1.37, 0.4)).toEqual({ inputSeek: 1.37, graphTrim: 0, videoLead: 0 });
    expect(baseCut(0, 0)).toEqual({ inputSeek: 0, graphTrim: 0, videoLead: 0 });
    expect(baseCut(2)).toEqual({ inputSeek: 2, graphTrim: 0, videoLead: 0 });
  });
  it("reads from the start and cuts the audio in the graph when the cut is inside the video's lead", () => {
    // A seek would land on the video's first keyframe and drop the audio before it.
    expect(baseCut(0, 0.4)).toEqual({ inputSeek: null, graphTrim: 0, videoLead: 0.4 });
    const c = baseCut(0.2, 0.4);
    expect(c.inputSeek).toBeNull();
    expect(c.graphTrim).toBe(0.2);
    expect(c.videoLead).toBeCloseTo(0.2, 9);
  });
  it("ignores a lead under a millisecond", () => {
    expect(baseCut(0, 0.0005).inputSeek).toBe(0);
  });
});

describe("streamCopyKeepsTimeline", () => {
  it("copies when the video has started by the cut, an audio lead included", () => {
    expect(streamCopyKeepsTimeline(1.37, { videoLead: 0.4, audioLead: 0.4 }, true)).toBe(true);
    expect(streamCopyKeepsTimeline(0, { videoLead: 0, audioLead: 0.4 }, true)).toBe(true);
    expect(streamCopyKeepsTimeline(0.2, {}, true)).toBe(true);
  });
  it("re-encodes a cut past 0 inside the video's lead (the seek drops audio)", () => {
    expect(streamCopyKeepsTimeline(0.2, { videoLead: 0.4, audioLead: 0 }, true)).toBe(false);
  });
  it("at 0, copies a video lead only when the kept audio starts with the file", () => {
    expect(streamCopyKeepsTimeline(0, { videoLead: 0.4, audioLead: 0 }, true)).toBe(true);
    expect(streamCopyKeepsTimeline(0, { videoLead: 0.4, audioLead: 0.4 }, true)).toBe(false);
    expect(streamCopyKeepsTimeline(0, { videoLead: 0.4, audioLead: 0 }, false)).toBe(false);
  });
});
