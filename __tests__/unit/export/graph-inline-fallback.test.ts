/**
 * An ffmpeg too old for `-/filter_complex <file>` (< 7.0) takes the graph on
 * the command line. A caption-heavy graph (~100k chars for 120 shadowed
 * two-line cues) is past Windows' 32,767-char limit, so such an export goes
 * to the chromium renderer instead of failing to spawn.
 */
import { describe, it, expect, vi } from "vitest";
import { overlayGraphNeedsBrowser } from "@/lib/export/backends/ffmpeg-overlay";
import type { Composition } from "@/lib/engine/types";

function comp(cues: number): Composition {
  return {
    id: "c", width: 1080, height: 1920, fps: 30, durationInFrames: 1800, scenes: [], audioClips: [],
    overlays: [
      { id: "bg", kind: "video", fileId: "f", startTime: 0, duration: 60, z: 0, opacity: 1,
        rect: { x: 0, y: 0, width: 1080, height: 1920 }, fit: "cover", sourceWidth: 1080, sourceHeight: 1920 },
      ...Array.from({ length: cues }, (_, i) => ({
        id: `c${i}`, kind: "text", startTime: i * 0.5, duration: 0.5, z: i + 1, opacity: 1,
        rect: { x: 54, y: 1400, width: 972, height: 200 }, anchor: "mid-center", maxWidthPct: 0.9,
        content: `Caption ${i}: this is a longer spoken line that wraps twice`, font: "700 64px Inter",
        fontSize: 64, fontWeight: 700, color: "#ffffff", align: "center",
        shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dy: 2 },
      })),
    ],
  } as unknown as Composition;
}
const size = { width: 1080, height: 1920 };

describe("overlayGraphNeedsBrowser", () => {
  it("a long graph + an ffmpeg that can't read it from a file → the browser", async () => {
    expect(await overlayGraphNeedsBrowser(comp(120), size, async () => false)).toBe(true);
  });

  it("the same graph on an ffmpeg that reads files stays on ffmpeg", async () => {
    expect(await overlayGraphNeedsBrowser(comp(120), size, async () => true)).toBe(false);
  });

  it("a short graph never asks, and stays on ffmpeg", async () => {
    const probe = vi.fn(async () => false);
    expect(await overlayGraphNeedsBrowser(comp(3), size, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
