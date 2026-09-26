// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  isUnfilledSlotFileId,
  unfilledSlotDisplayName,
  unfilledSlotFileId,
  unfilledSlotLabel,
} from "@/lib/templates/unfilled-slot";
import { buildComposition } from "@/lib/composition/build-composition";
import { drawOverlayContent2D, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import { isNonDecodingOverlay, stripHiddenLayers } from "@/lib/overlays/hidden";
import { buildMediaById } from "@/lib/preview/timeline-media";
import { useOverlayImages } from "@/hooks/preview/use-overlay-images";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, ImageOverlay, Overlay, VideoOverlay } from "@/lib/engine/types";

/**
 * An applied template's media slot that nobody filled (`fileId:
 * "unfilled-<key>"`, materialize.ts) is WAITING for media, not broken. The
 * Task-13 walk-through found it painted as the red "⚠ Media file missing"
 * warning and 404-ing `/api/files/by-id/unfilled-hero/content` on every render.
 * These pin the fix end to end through the preview's pure seams: hydrate →
 * paint → decode strip → image cache → timeline paint → export.
 */

const RECT = { x: 0, y: 0, width: 400, height: 300 };

function imageSlot(): Overlay {
  return {
    id: "img-hero",
    kind: "image",
    fileId: unfilledSlotFileId("hero"),
    displayName: unfilledSlotDisplayName("Hero image"),
    startTime: 0,
    duration: 3,
    z: 0,
    opacity: 1,
    rect: RECT,
  } as Overlay;
}

function videoSlot(): Overlay {
  return {
    id: "vid-clip",
    kind: "video",
    fileId: unfilledSlotFileId("clip"),
    displayName: unfilledSlotDisplayName("Product clip"),
    startTime: 0,
    duration: 3,
    z: 1,
    opacity: 1,
    rect: RECT,
  } as Overlay;
}

/** Hydrated the way the editor does once its file queries have settled: the
 *  placeholder ids are, of course, in neither the piece's nor the global files. */
function hydrate(overlays: Overlay[]): Composition {
  return buildComposition(new Map(), overlays, [], { knownFileIds: new Set(["real-1"]), filesResolved: true });
}

function recCtx() {
  const texts: string[] = [];
  const calls: string[] = [];
  let font = "10px sans-serif";
  const ctx = {
    texts,
    calls,
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
    setLineDash() {}, strokeRect() { calls.push("strokeRect"); }, fillRect() { calls.push("fillRect"); },
    drawImage() { calls.push("drawImage"); }, clearRect() {},
    fillText(t: string) { texts.push(t); }, strokeText() {},
    measureText() { return { width: 10 }; },
    globalAlpha: 1, filter: "none", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1,
    textAlign: "left" as CanvasTextAlign, textBaseline: "alphabetic" as CanvasTextBaseline,
    get font() { return font; },
    set font(v: string) { font = v; },
  };
  return ctx as unknown as CanvasRenderingContext2D & { texts: string[]; calls: string[] };
}

function draw(overlay: Overlay, extra: Partial<DrawOverlayContext> = {}) {
  const ctx = recCtx();
  const drawCtx: DrawOverlayContext = {
    ctx, time: 1, frame: 30, totalFrames: 90, fps: 30, width: 1080, height: 1920, assets: {}, ...extra,
  };
  drawOverlayContent2D(overlay, drawCtx, RECT);
  return ctx;
}

describe("unfilled template slot ids", () => {
  it("recognises only the reserved prefix with a key after it", () => {
    expect(isUnfilledSlotFileId("unfilled-hero")).toBe(true);
    expect(isUnfilledSlotFileId("unfilled-")).toBe(false);
    expect(isUnfilledSlotFileId("3f2b9c1e-0000-4000-8000-000000000000")).toBe(false);
    expect(isUnfilledSlotFileId(undefined)).toBe(false);
  });

  it("labels the slot by the layer's name without the (fill me) tail, else by its key", () => {
    expect(unfilledSlotLabel({ fileId: "unfilled-hero", displayName: "Hero image (fill me)" })).toBe("Hero image");
    expect(unfilledSlotLabel({ fileId: "unfilled-hero", displayName: "Big hero" })).toBe("Big hero");
    expect(unfilledSlotLabel({ fileId: "unfilled-hero" })).toBe("hero");
  });
});

describe("the preview", () => {
  it("hydrates an unfilled image or video slot as a placeholder, never as missing", () => {
    const comp = hydrate([imageSlot(), videoSlot()]);
    const [img, vid] = comp.overlays as [ImageOverlay, VideoOverlay];
    expect(img.unfilledSlot).toBe("Hero image");
    expect(img.missing).toBe(false);
    expect(vid.unfilledSlot).toBe("Product clip");
    expect(vid.missing).toBe(false);
    // No decode URL: nothing should try to stream `unfilled-clip`.
    expect(vid.videoUrl).toBeUndefined();
  });

  it("still flags a genuinely deleted file as missing", () => {
    const gone = { ...imageSlot(), fileId: "deleted-file" } as Overlay;
    const [img] = hydrate([gone]).overlays as [ImageOverlay];
    expect(img.missing).toBe(true);
    expect(img.unfilledSlot).toBeUndefined();
  });

  it("paints a neutral 'add media' box naming the slot, not the red missing-file warning", () => {
    const [img, vid] = hydrate([imageSlot(), videoSlot()]).overlays!;
    const imgCtx = draw(img);
    expect(imgCtx.texts).toEqual(["Hero image", "add media"]);
    expect(imgCtx.calls).toContain("strokeRect");
    expect(imgCtx.calls).not.toContain("drawImage");

    const vidCtx = draw(vid);
    expect(vidCtx.texts).toEqual(["Product clip", "add media"]);
    expect(vidCtx.texts.join(" ")).not.toContain("Media file missing");
  });

  it("drops an unfilled video from the decode pipeline, so no decoder is mounted", () => {
    const [img, vid] = hydrate([imageSlot(), videoSlot()]).overlays!;
    expect(isNonDecodingOverlay(vid)).toBe(true);
    // An image mounts no decoder either way; it is kept for the painter.
    expect(isNonDecodingOverlay(img)).toBe(false);
  });

  it("loads no <img> for an unfilled image slot", () => {
    const comp = hydrate([imageSlot()]);
    const { result } = renderHook(() => useOverlayImages(comp));
    expect(result.current.images["img-hero"]).toBeUndefined();
  });

  it("gives the timeline nothing to paint or filmstrip for an unfilled slot", () => {
    expect(buildMediaById(hydrate([imageSlot(), videoSlot()])).size).toBe(0);
  });
});

describe("export", () => {
  it("refuses while a slot is unfilled, and names the slot", () => {
    const shape = classifyExportShape(hydrate([imageSlot()]));
    expect(shape).toEqual({
      tag: "error",
      reason: 'the template slot "Hero image" has no media yet — fill it, or hide or remove that layer, before exporting',
    });
  });

  it("goes ahead once the unfilled layer is hidden (it leaves the export)", () => {
    const text = {
      id: "t1", kind: "text", content: "Now open", font: "48px Inter", color: "#fff", align: "center",
      startTime: 0, duration: 3, z: 2, opacity: 1, rect: RECT,
    } as Overlay;
    const hidden = { ...imageSlot(), hidden: true } as Overlay;
    const shape = classifyExportShape(stripHiddenLayers(hydrate([hidden, text])));
    expect(shape.tag).not.toBe("error");
  });
});
