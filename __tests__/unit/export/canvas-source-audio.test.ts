/**
 * EXP-2 — the in-browser canvas-source export (the LIBI_EXPORT_USE_BROWSER_CANVAS
 * emergency fallback) encodes video only: lib/engine/export.ts has no audio
 * track. A piece with sound exported that way used to come out SILENT with no
 * word said. The classifier now never picks it for an audible composition
 * (chromium-render muxes audio), and the backend itself refuses one outright.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { AudioClip, Composition, Overlay } from "@/lib/engine/types";

const { exportVideo } = vi.hoisted(() => ({
  exportVideo: vi.fn(async () => ({ blob: new Blob(["x"]), duration: 1, format: "mp4" })),
}));
vi.mock("@/lib/engine/export", () => ({ exportVideo }));

import { classifyExportShape, compHasAudibleAudio } from "@/lib/export/classifier";
import { CanvasSourceBackend } from "@/lib/export/backends/canvas-source";

function codeOverlay(): Overlay {
  return {
    id: "code1",
    kind: "code",
    startTime: 0,
    duration: 2,
    z: 1,
    opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    drawFunction: "() => {}",
  } as Overlay;
}

function clip(over: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "a1",
    kind: "standalone",
    fileId: "f-audio",
    startTime: 0,
    duration: 2,
    trimStart: 0,
    volume: 1,
    enabled: true,
    ...over,
  };
}

function comp(audioClips: AudioClip[] = []): Composition {
  return {
    id: "c1",
    width: 1920,
    height: 1080,
    fps: 30,
    overlays: [codeOverlay()],
    audioClips,
  } as Composition;
}

const FLAG = "LIBI_EXPORT_USE_BROWSER_CANVAS";
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
  exportVideo.mockClear();
});

describe("compHasAudibleAudio", () => {
  it("is false with no clips, and for clips that are all muted or at zero volume", () => {
    expect(compHasAudibleAudio(comp())).toBe(false);
    expect(compHasAudibleAudio(comp([clip({ enabled: false }), clip({ id: "a2", volume: 0 })]))).toBe(false);
  });

  it("is true for an enabled standalone clip, and for a video's inline audio", () => {
    expect(compHasAudibleAudio(comp([clip()]))).toBe(true);
    expect(
      compHasAudibleAudio(comp([clip({ kind: "inline", linkedOverlayId: "v1", volume: 0.4 })])),
    ).toBe(true);
  });
});

describe("classifier — canvas-source never picked for a piece with sound", () => {
  it("flag on + silent piece → canvas-source (unchanged)", () => {
    process.env[FLAG] = "1";
    expect(classifyExportShape(comp())).toEqual({ tag: "canvas-source" });
    expect(classifyExportShape(comp([clip({ enabled: false })]))).toEqual({ tag: "canvas-source" });
  });

  it("flag on + an audible clip → chromium-render, which muxes the audio", () => {
    process.env[FLAG] = "1";
    expect(classifyExportShape(comp([clip()]))).toEqual({ tag: "chromium-render" });
  });

  it("flag on + video audio (an inline clip) → chromium-render", () => {
    process.env[FLAG] = "1";
    const c = comp([clip({ kind: "inline", linkedOverlayId: "v1" })]);
    expect(classifyExportShape(c)).toEqual({ tag: "chromium-render" });
  });

  it("flag off → chromium-render either way", () => {
    delete process.env[FLAG];
    expect(classifyExportShape(comp([clip()]))).toEqual({ tag: "chromium-render" });
    expect(classifyExportShape(comp())).toEqual({ tag: "chromium-render" });
  });
});

describe("CanvasSourceBackend — refuses audio instead of dropping it", () => {
  it("refuses an audible composition, naming the flag, without encoding", async () => {
    const backend = new CanvasSourceBackend();
    await expect(
      backend.run({ composition: comp([clip()]), settings: {} as never }),
    ).rejects.toThrow(
      "This export path can't include audio; turn off LIBI_EXPORT_USE_BROWSER_CANVAS or remove the audio.",
    );
    expect(exportVideo).not.toHaveBeenCalled();
  });

  it("exports a silent composition (muted clips included) as before", async () => {
    const backend = new CanvasSourceBackend();
    const res = await backend.run({
      composition: comp([clip({ enabled: false })]),
      settings: {} as never,
    });
    expect(res.duration).toBe(1);
    expect(exportVideo).toHaveBeenCalledTimes(1);
  });
});
