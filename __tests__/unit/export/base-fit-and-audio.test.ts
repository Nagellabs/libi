/**
 * Regression tests for three confirmed export-fidelity bugs on the
 * overlay-base fast path.
 *
 *  C1 — a base-shaped video OVERLAY is required to be `fit: "cover"`, and the
 *       canvas renderer honours that by CROPPING overflow (`coverRect`). The
 *       ffmpeg base chain letterboxed instead (`force_original_aspect_ratio=
 *       decrease` + `pad`), so a full-bleed preview exported with black bars.
 *  I2 — `trim` selects a SOURCE range while `duration` is the TIMELINE length;
 *       cutting at `trim.end` alone ships a file longer than the preview after
 *       a split-then-shorten (the right-edge drag rewrites `duration` only).
 *  I3 — muting a base video REMOVES its inline audio clip, so a `-c copy`
 *       export carried the source's audio track straight through.
 */
import { describe, it, expect } from "vitest";
import { buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import {
  baseTimeRange,
  keepsBaseAudio,
  resolveExportBase,
  streamCopyPreservesFraming,
} from "@/lib/export/export-base";
import type { AudioClip, Composition, Overlay } from "@/lib/engine/types";

function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1", width: 480, height: 854, fps: 30,
    overlays: [], audioClips: [],
    ...over,
  } as unknown as Composition;
}

function baseOverlay(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "vid-1", kind: "video", fileId: "f1",
    startTime: 0, duration: 10, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 480, height: 854 }, fit: "cover",
    sourceWidth: 480, sourceHeight: 854,
    ...over,
  } as unknown as Overlay;
}

function inlineClip(over: Record<string, unknown> = {}): AudioClip {
  return {
    id: "a1", kind: "inline", fileId: "f1",
    startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true,
    linkedOverlayId: "vid-1",
    ...over,
  } as unknown as AudioClip;
}

describe("C1 — base fit chain", () => {
  it("an OVERLAY base scales up and CROPS (cover), never letterboxes", () => {
    const chain = buildFilterChain([], new Map(), {
      width: 480, height: 854, baseFit: "cover",
    });
    expect(chain).toContain("[0:v]scale=480:854:force_original_aspect_ratio=increase");
    expect(chain).toContain("crop=480:854");
    expect(chain).not.toContain("pad=");
    expect(chain).not.toContain("force_original_aspect_ratio=decrease");
  });

  it("a legacy SCENE base keeps the contain+pad chain (renderer uses fitRect)", () => {
    const chain = buildFilterChain([], new Map(), { width: 1920, height: 1080 });
    expect(chain).toContain("force_original_aspect_ratio=decrease");
    expect(chain).toContain("pad=1920:1080");
  });

  it("cover crops at the TARGET dims when exporting at a larger quality", () => {
    const chain = buildFilterChain([], new Map(), {
      width: 480, height: 854, targetWidth: 1080, targetHeight: 1920, baseFit: "cover",
    });
    expect(chain).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(chain).toContain("crop=1080:1920");
  });

  it("streamCopyPreservesFraming is false unless BOTH dims are known and equal", () => {
    const c = comp({ overlays: [baseOverlay()] });
    expect(streamCopyPreservesFraming(resolveExportBase(c)!, c)).toBe(true);

    const landscape = comp({
      overlays: [baseOverlay({ sourceWidth: 854, sourceHeight: 428 })],
    });
    expect(streamCopyPreservesFraming(resolveExportBase(landscape)!, landscape)).toBe(false);

    const unknown = comp({
      overlays: [baseOverlay({ sourceWidth: null, sourceHeight: null })],
    });
    expect(streamCopyPreservesFraming(resolveExportBase(unknown)!, unknown)).toBe(false);
  });
});

describe("I2 — base time range", () => {
  it("clamps a trim span that exceeds the layer's timeline duration", () => {
    // Split sets trim 0→10; a later right-edge drag shortens duration to 4 but
    // leaves trim alone. The preview shows 4s, so the export must be 4s.
    const base = resolveExportBase(
      comp({ overlays: [baseOverlay({ duration: 4, trim: { start: 0, end: 10 } })] }),
    )!;
    expect(baseTimeRange(base)).toEqual({ start: 0, end: 4, duration: 4 });
  });

  it("keeps a trim SHORTER than the duration (the trim is the real cut)", () => {
    const base = resolveExportBase(
      comp({ overlays: [baseOverlay({ duration: 10, trim: { start: 2, end: 5 } })] }),
    )!;
    expect(baseTimeRange(base)).toEqual({ start: 2, end: 5, duration: 3 });
  });

  it("falls back to start + duration when there is no trim", () => {
    const base = resolveExportBase(comp({ overlays: [baseOverlay({ duration: 7 })] }))!;
    expect(baseTimeRange(base)).toEqual({ start: 0, end: 7, duration: 7 });
  });
});

describe("I3 — base audio", () => {
  it("no inline clip (the muted shape) means the export must drop source audio", () => {
    const c = comp({ overlays: [baseOverlay()] });
    expect(keepsBaseAudio(c, resolveExportBase(c)!)).toBe(false);
  });

  it("an enabled inline clip on the base keeps its audio (passthrough)", () => {
    const c = comp({ overlays: [baseOverlay()], audioClips: [inlineClip()] });
    expect(keepsBaseAudio(c, resolveExportBase(c)!)).toBe(true);
  });

  it("a disabled inline clip does not keep audio", () => {
    const c = comp({ overlays: [baseOverlay()], audioClips: [inlineClip({ enabled: false })] });
    expect(keepsBaseAudio(c, resolveExportBase(c)!)).toBe(false);
  });

  it("another layer's inline clip is not the base's audio", () => {
    const c = comp({
      overlays: [baseOverlay()],
      audioClips: [inlineClip({ linkedOverlayId: "other" })],
    });
    expect(keepsBaseAudio(c, resolveExportBase(c)!)).toBe(false);
  });

});
