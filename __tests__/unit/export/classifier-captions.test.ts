import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { classifyExportShape } from "@/lib/export/classifier";
import { buildCaptionCues } from "@/lib/captions/cues";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import type { Composition, Overlay } from "@/lib/engine/types";
import type { SttWord } from "@/lib/analysis/types";

// Task 4 (2026-09-19 QA candidates): a caption track whose hold-out overruns
// the transcribed video's own end used to force the whole export off the
// ffmpeg fast path (`outlivesBase` in classifier.ts, via getCompositionFrames
// in renderer.ts) — the export took longer AND the base's `-to` cutoff still
// would have silently truncated the tail on the fast path if it had been
// taken. `generateCaptions` (mcp/tools/caption-tools.ts) now clamps every
// cue's held end to the transcribed video overlay's own TIMELINE end, so a
// normal captioned clip no longer trips this fallback.

function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1", width: 1920, height: 1080, fps: 30,
    overlays: [], audioClips: [],
    ...over,
  } as unknown as Composition;
}

function baseVideo(over: Record<string, unknown> = {}): Overlay {
  return {
    id: "vid-1", kind: "video", fileId: "f1",
    startTime: 0, duration: 5, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 1920, height: 1080 }, fit: "cover",
    sourceWidth: 1920, sourceHeight: 1080,
    ...over,
  } as unknown as Overlay;
}

const w = (text: string, start: number, end: number): SttWord => ({ text, start, end, type: "word" });

describe("classifier — a maxEnd-clamped caption track stays off the outlivesBase fallback", () => {
  afterEach(() => cleanupTempDir());

  it("without a maxEnd clamp, a caption hold-out past the base video falls back (regression baseline)", () => {
    // This exercises the pre-fix shape directly (buildCaptionCues with no
    // maxEnd) — `generateCaptions` itself always computes and passes maxEnd
    // now, so there's no way to reach this shape through the real tool. Kept
    // as the "what the bug looked like" baseline the positive case below is
    // contrasted against.
    const words = [w("Hello", 0, 0.4), w("world", 4.4, 4.8)];
    // No maxEnd: the default 0.4s hold pushes the (one, budget-merged) cue's
    // end to 5.2s — 0.2s past the 5s base video's end.
    const cues = buildCaptionCues(words, {});
    const overlays: Overlay[] = [
      baseVideo(),
      ...cues.map((c, i) => ({
        id: `cue-${i}`, kind: "text", startTime: c.start,
        duration: Math.max(0.2, c.end - c.start),
        rect: { x: 0, y: 900, width: 1920, height: 150 }, z: 50, opacity: 1,
        content: c.text, font: "48px Inter", color: "#ffffff", align: "center",
      })) as unknown as Overlay[],
    ];
    const tag = classifyExportShape(comp({ overlays })).tag;
    expect(["chromium-render", "canvas-source"]).toContain(tag);
  });

  it("with real generateCaptions output, the same transcript stays on ffmpeg-overlay", async () => {
    vi.resetModules();
    createTempStorageDir();
    const { generateCaptions } = await import("@/mcp/tools/caption-tools");
    const { loadManifest, saveManifest } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir } = await import("@/lib/libi-home");

    const pieceId = "pclassifier";
    fs.mkdirSync(path.join(getLibiStorageDir(), pieceId), { recursive: true });
    const videoOverlay = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await saveManifest(pieceId, { width: 1920, height: 1080, fps: 30, overlays: [videoOverlay] });

    const words = [w("Hello", 0, 0.4), w("world", 4.4, 4.8)];
    // "clean" style: no reveal, so the classifier's textNeedsBrowserRender
    // guard doesn't route this off the ffmpeg fast path for an unrelated
    // reason — isolates the assertion to the outlivesBase clamp.
    const result = await generateCaptions(
      { pieceId, fileId: "f1", style: "clean" },
      { readWords: async () => words },
    );
    expect(result.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const overlays = (manifest.overlays ?? []) as unknown as Overlay[];
    expect(classifyExportShape(comp({ overlays })).tag).toBe("ffmpeg-overlay");
  });
});
