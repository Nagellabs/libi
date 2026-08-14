import { describe, expect, it } from "vitest";
import { classifyExportShape } from "@/lib/export/classifier";
import { stripHiddenLayers } from "@/lib/overlays/hidden";
import type { Composition, Overlay } from "@/lib/engine/types";

/**
 * Regression: hidden layers (`overlay.hidden === true`, the persisted eye
 * toggle) leave the EXPORT composition entirely — the classifier and every
 * backend see the comp with hidden overlays + their coupled inline audio
 * already stripped. Because filtering happens BEFORE classification (the
 * export runner, both server routes, and the client router all run the same
 * field-sourced `stripHiddenLayers`/`stripHiddenLayerArrays`), a hidden layer
 * that changes the export shape re-classifies naturally on both sides — never
 * a 409, never a wrong backend.
 */

function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1", width: 1920, height: 1080, fps: 30,
    scenes: [], sceneOrder: [], overlays: [], audioClips: [],
    ...over,
  } as unknown as Composition;
}

function baseOverlay(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "vid-base", kind: "video", fileId: "f1",
    startTime: 0, duration: 10, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 }, fit: "cover",
    sourceWidth: 1920, sourceHeight: 1080,
    ...over,
  } as unknown as Overlay;
}

function textOverlay(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "txt-1", kind: "text", z: 1, startTime: 0, duration: 3,
    rect: { x: 0, y: 0, width: 100, height: 50 }, text: "hi",
    ...over,
  } as unknown as Overlay;
}

const pipRect = { x: 100, y: 100, width: 480, height: 270 };
const pipAudio = {
  id: "a-pip", kind: "inline", fileId: "f1", startTime: 0, duration: 5,
  trimStart: 0, volume: 1, enabled: true, linkedOverlayId: "pip",
};

describe("hidden layers × export classifier", () => {
  it("hidden overlay + its coupled inline audio are absent from the export comp", () => {
    const c = comp({
      overlays: [baseOverlay(), baseOverlay({ id: "pip", z: 1, rect: pipRect, hidden: true })],
      audioClips: [pipAudio] as unknown as Composition["audioClips"],
    });
    const stripped = stripHiddenLayers(c);
    expect(stripped.overlays?.some((o) => o.id === "pip")).toBe(false);
    expect(stripped.audioClips?.some((a) => a.id === "a-pip")).toBe(false);
    expect(stripped.overlays?.map((o) => o.id)).toEqual(["vid-base"]);
  });

  it("hiding the composited PIP (+ its audio) upgrades ffmpeg-overlay → stream-copy-trim", () => {
    // Visible PIP: composited overlay + a non-base inline clip need the graph.
    const visible = comp({
      overlays: [baseOverlay(), baseOverlay({ id: "pip", z: 1, rect: pipRect })],
      audioClips: [pipAudio] as unknown as Composition["audioClips"],
    });
    expect(classifyExportShape(stripHiddenLayers(visible)).tag).toBe("ffmpeg-overlay");
    // Hidden PIP: lone base-shaped video, no audio to mix → near-instant -c copy.
    const hidden = comp({
      overlays: [baseOverlay(), baseOverlay({ id: "pip", z: 1, rect: pipRect, hidden: true })],
      audioClips: [pipAudio] as unknown as Composition["audioClips"],
    });
    expect(classifyExportShape(stripHiddenLayers(hidden)).tag).toBe("stream-copy-trim");
  });

  it("hiding a text overlay upgrades ffmpeg-overlay → stream-copy-trim", () => {
    const visible = comp({ overlays: [baseOverlay(), textOverlay()] });
    expect(classifyExportShape(stripHiddenLayers(visible)).tag).toBe("ffmpeg-overlay");
    const hidden = comp({ overlays: [baseOverlay(), textOverlay({ hidden: true })] });
    expect(classifyExportShape(stripHiddenLayers(hidden)).tag).toBe("stream-copy-trim");
  });

  it("hiding the BASE overlay re-resolves the base — the shape changes naturally", () => {
    // Base + inset PIP: visible classifies ffmpeg-overlay (base + one
    // composited overlay). Hiding the BASE leaves only the non-base-shaped
    // inset — no resolvable base → the render fallback. This falling out of
    // filter-before-classify is exactly what keeps every export surface
    // agreeing on the shape.
    const visible = comp({
      overlays: [baseOverlay(), baseOverlay({ id: "pip", z: 1, rect: pipRect })],
    });
    expect(classifyExportShape(stripHiddenLayers(visible)).tag).toBe("ffmpeg-overlay");
    const hiddenBase = comp({
      overlays: [baseOverlay({ hidden: true }), baseOverlay({ id: "pip", z: 1, rect: pipRect })],
    });
    const strippedTag = classifyExportShape(stripHiddenLayers(hiddenBase)).tag;
    expect(["chromium-render", "canvas-source"]).toContain(strippedTag);
  });

  it("hiding every layer classifies as nothing-to-export (not a crash)", () => {
    const c = comp({ overlays: [baseOverlay({ hidden: true })] });
    const stripped = stripHiddenLayers(c);
    expect(classifyExportShape(stripped)).toEqual({ tag: "error", reason: "nothing to export" });
  });
});
