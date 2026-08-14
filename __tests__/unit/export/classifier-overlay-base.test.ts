import { describe, expect, it } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, Overlay } from "@/lib/engine/types";

function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1", width: 1920, height: 1080, fps: 30,
    scenes: [], sceneOrder: [], overlays: [], audioClips: [],
    ...over,
  } as unknown as Composition;
}

function baseOverlay(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "vid-1", kind: "video", fileId: "f1",
    startTime: 0, duration: 10, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 }, fit: "cover",
    // The hydrators (buildComposition / attachOverlaySourceDims) attach the
    // SOURCE dims off files.mediaWidth/mediaHeight. Matching the composition is
    // what makes `-c copy` legal — see the dimension-mismatch tests below.
    sourceWidth: 1920, sourceHeight: 1080,
    ...over,
  } as unknown as Overlay;
}

/** A minimal AudioClip. `trimStart` is required by the real type. */
function inlineClip(over: Record<string, unknown> = {}) {
  return {
    id: "a1", kind: "inline", fileId: "f1",
    startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true,
    linkedOverlayId: "vid-1",
    ...over,
  };
}

describe("classifier — zero-scene overlay base", () => {
  it("a lone base-shaped video overlay stream-copies", () => {
    expect(classifyExportShape(comp({ overlays: [baseOverlay()] })).tag).toBe("stream-copy-trim");
  });

  it("base overlay + a flat text overlay routes to ffmpeg-overlay", () => {
    const text = {
      id: "t1", kind: "text", z: 1, startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 50 }, text: "hi",
    } as unknown as Overlay;
    expect(classifyExportShape(comp({ overlays: [baseOverlay(), text] })).tag).toBe("ffmpeg-overlay");
  });

  it("base overlay + an inset PIP video routes to ffmpeg-overlay (extra -i input)", () => {
    // The background-removal shape: full-frame plate + a cutout composited on
    // top. ffmpeg-overlay handles this; it must NOT fall back to chromium.
    const pip = baseOverlay({
      id: "pip", z: 1, rect: { x: 100, y: 100, width: 480, height: 270 },
    });
    expect(classifyExportShape(comp({ overlays: [baseOverlay(), pip] })).tag).toBe("ffmpeg-overlay");
  });

  it("base overlay + a CODE overlay still falls back", () => {
    const code = {
      id: "c1", kind: "code", z: 1, startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 50 }, drawFunction: "",
    } as unknown as Overlay;
    const tag = classifyExportShape(comp({ overlays: [baseOverlay(), code] })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("a NON-base-shaped lone video (inset rect) falls back rather than mis-exporting", () => {
    const inset = baseOverlay({ rect: { x: 100, y: 100, width: 800, height: 600 } });
    const tag = classifyExportShape(comp({ overlays: [inset] })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("two full-frame videos TIED at the lowest z fall back (ambiguous base)", () => {
    // Revised from the brief's "two stacked videos fall back": stacking at
    // DIFFERENT z now resolves the lower one as base (see the PIP case above).
    // Only a TIE leaves the base genuinely ambiguous, and an ambiguous base
    // would ship a wrong video.
    const a = baseOverlay({ id: "a", z: 0 });
    const b = baseOverlay({ id: "b", z: 0 });
    const tag = classifyExportShape(comp({ overlays: [a, b] })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("a keyframed overlay above the base still falls back", () => {
    // `Keyframed<T>` is `{ keyframes: [...] }` — NOT a bare array.
    const kf = {
      id: "k1", kind: "image", fileId: "f2", z: 1, startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      keyframes: { opacity: { keyframes: [{ t: 0, value: 1 }] } },
    } as unknown as Overlay;
    const tag = classifyExportShape(comp({ overlays: [baseOverlay(), kf] })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("an inline clip linked to the BASE OVERLAY at unity volume still stream-copies", () => {
    const c = comp({ overlays: [baseOverlay()], audioClips: [inlineClip()] } as unknown as Partial<Composition>);
    expect(classifyExportShape(c).tag).toBe("stream-copy-trim");
  });

  it("a muted inline clip on the base overlay needs ffmpeg-overlay", () => {
    const c = comp({
      overlays: [baseOverlay()],
      audioClips: [inlineClip({ enabled: false })],
    } as unknown as Partial<Composition>);
    expect(classifyExportShape(c).tag).toBe("ffmpeg-overlay");
  });

  it("an inline clip at non-unity volume on the base overlay needs ffmpeg-overlay", () => {
    const c = comp({
      overlays: [baseOverlay()],
      audioClips: [inlineClip({ volume: 0.5 })],
    } as unknown as Partial<Composition>);
    expect(classifyExportShape(c).tag).toBe("ffmpeg-overlay");
  });

  it("an inline clip linked to a DIFFERENT overlay is not base passthrough", () => {
    const c = comp({
      overlays: [baseOverlay()],
      audioClips: [inlineClip({ linkedOverlayId: "some-other-overlay" })],
    } as unknown as Partial<Composition>);
    expect(classifyExportShape(c).tag).toBe("ffmpeg-overlay");
  });

  it("an overlay that OUTLIVES the base falls back (ffmpeg -to would truncate it)", () => {
    // getCompositionFrames makes the comp as long as its longest layer, but the
    // ffmpeg backends stop at the base's end — so this caption tail would be
    // silently dropped by the fast path.
    const late = {
      id: "t1", kind: "text", z: 1, startTime: 9, duration: 5,
      rect: { x: 0, y: 0, width: 100, height: 50 }, text: "outro",
    } as unknown as Overlay;
    const tag = classifyExportShape(comp({ overlays: [baseOverlay(), late] })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("an overlay ending exactly at the base end still takes the fast path", () => {
    // One frame of slack: a layer that ends 'at' the base must not trip the
    // truncation guard on float rounding.
    const flush = {
      id: "t1", kind: "text", z: 1, startTime: 7, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 50 }, text: "hi",
    } as unknown as Overlay;
    expect(classifyExportShape(comp({ overlays: [baseOverlay(), flush] })).tag).toBe("ffmpeg-overlay");
  });

  it("an audio clip that outlives the base also falls back", () => {
    const c = comp({
      overlays: [baseOverlay()],
      audioClips: [inlineClip(), { ...inlineClip({ id: "a2", kind: "standalone" }), duration: 30 }],
    } as unknown as Partial<Composition>);
    const tag = classifyExportShape(c).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  // ── C1: `-c copy` cannot scale, so it must not be picked when the source's
  // dimensions differ from the composition's. `add_overlay` gives every new
  // video a full-canvas cover rect regardless of its aspect, so a 16:9 clip in
  // a 9:16 short is base-shaped by construction — and stream-copying it ships
  // a landscape file for a portrait piece.
  describe("C1 — stream-copy requires source dims == composition dims", () => {
    const portrait = (over: Partial<Composition> = {}) =>
      comp({ width: 480, height: 854, ...over });

    it("a LANDSCAPE source in a PORTRAIT composition does NOT stream-copy", () => {
      const base = baseOverlay({
        rect: { x: 0, y: 0, width: 480, height: 854 },
        sourceWidth: 854,
        sourceHeight: 428,
      });
      const tag = classifyExportShape(portrait({ overlays: [base] })).tag;
      expect(tag).not.toBe("stream-copy-trim");
      // ffmpeg-overlay's base chain scales+crops to the composition — correct,
      // and far cheaper than a full chromium re-render.
      expect(tag).toBe("ffmpeg-overlay");
    });

    it("UNKNOWN source dims count as a mismatch, not a match", () => {
      const base = baseOverlay({ sourceWidth: null, sourceHeight: null });
      expect(classifyExportShape(comp({ overlays: [base] })).tag).not.toBe("stream-copy-trim");
    });

    it("dims absent entirely (unhydrated overlay) also refuse stream-copy", () => {
      const base = baseOverlay({ sourceWidth: undefined, sourceHeight: undefined });
      expect(classifyExportShape(comp({ overlays: [base] })).tag).not.toBe("stream-copy-trim");
    });

    it("matching dims still take the near-instant path", () => {
      const base = baseOverlay({
        rect: { x: 0, y: 0, width: 480, height: 854 },
        sourceWidth: 480,
        sourceHeight: 854,
      });
      expect(classifyExportShape(portrait({ overlays: [base] })).tag).toBe("stream-copy-trim");
    });

    it("UNKNOWN source dims fall back to a re-encode rather than stream-copying", () => {
      // A never-probed file row leaves dims null. Stream-copy ships the source
      // bytes verbatim, so unknown framing must be treated as a MISMATCH: a
      // false negative costs one re-encode, a false positive ships the wrong
      // aspect ratio.
      const base = baseOverlay({ sourceWidth: null, sourceHeight: null });
      expect(classifyExportShape(comp({ overlays: [base] })).tag).toBe("ffmpeg-overlay");
    });
  });

  // ── I2: `trim` selects a SOURCE range, `duration` is the TIMELINE length.
  // The renderer shows the shorter of the two, so the truncation guard must
  // measure against the same clamped end the backends cut at.
  it("I2 — an overlay outliving the CLAMPED base end falls back", () => {
    // trim spans 0→10 but the layer was dragged down to 4s on the timeline
    // (split-then-shorten rewrites `duration`, never `trim`), so the export
    // ends at 4s and this 6s caption would be truncated.
    const base = baseOverlay({ duration: 4, trim: { start: 0, end: 10 } });
    const late = {
      id: "t1", kind: "text", z: 1, startTime: 0, duration: 6,
      rect: { x: 0, y: 0, width: 100, height: 50 }, text: "outro",
    } as unknown as Overlay;
    const tag = classifyExportShape(comp({ overlays: [base, late] })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("an empty comp is still an error", () => {
    expect(classifyExportShape(comp()).tag).toBe("error");
  });

  it("audio-only (no overlays, no scenes) still falls back rather than erroring", () => {
    const c = comp({
      audioClips: [{ ...inlineClip({ kind: "standalone" }), linkedOverlayId: undefined }],
    } as unknown as Partial<Composition>);
    const tag = classifyExportShape(c).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  // ── Task 3: a composited (non-base) video overlay's own trim can't be
  // expressed by the overlay filter graph (it would need an input-level -ss
  // on that overlay's own -i, which the backend never applies). Refuse rather
  // than silently export the untrimmed asset.
  describe("trimmed asset overlay refusal", () => {
    it("a composited video overlay with a trim falls back", () => {
      const trimmed = baseOverlay({
        id: "pip", z: 1,
        rect: { x: 100, y: 100, width: 480, height: 270 },
        trim: { start: 2, end: 6 },
      });
      const tag = classifyExportShape(comp({ overlays: [baseOverlay(), trimmed] })).tag;
      expect(["chromium-render", "canvas-source"]).toContain(tag);
    });

    it("the BASE overlay's own trim does NOT trigger the refusal", () => {
      // The base's trim is handled by baseTimeRange()/-ss/-to on input [0:v] —
      // excluded via `o.id !== base?.overlayId` in the classifier guard.
      // `duration` matches the trimmed window (1..5 = 4s) so this doesn't
      // separately trip the unrelated outlivesBase self-reference check.
      const trimmedBase = baseOverlay({ duration: 4, trim: { start: 1, end: 5 } });
      expect(classifyExportShape(comp({ overlays: [trimmedBase] })).tag).toBe("stream-copy-trim");
    });

    it("a composited video overlay with NO trim still takes the ffmpeg-overlay path", () => {
      const pip = baseOverlay({
        id: "pip", z: 1, rect: { x: 100, y: 100, width: 480, height: 270 },
      });
      expect(classifyExportShape(comp({ overlays: [baseOverlay(), pip] })).tag).toBe("ffmpeg-overlay");
    });

    it("an image overlay (no trim field) is unaffected by the guard", () => {
      const img = {
        id: "img1", kind: "image", fileId: "f2", z: 1, startTime: 0, duration: 3,
        rect: { x: 0, y: 0, width: 100, height: 50 },
      } as unknown as Overlay;
      expect(classifyExportShape(comp({ overlays: [baseOverlay(), img] })).tag).toBe("ffmpeg-overlay");
    });
  });
});
