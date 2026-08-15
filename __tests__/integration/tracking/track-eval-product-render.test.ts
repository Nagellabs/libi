import { describe, it, expect } from "vitest";
import { renderAnnotatedVideo } from "@/scripts/track-eval/render";
import { SYNTHETIC_VIDEO_FIXTURE } from "./fixture-guard";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

// Renders a hand-built track through the product path — needs pixels, not a
// face, so it uses the committed synthetic clip and runs everywhere.
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);

describe.skipIf(!hasFfmpeg())("renderAnnotatedVideo viaProductRender", () => {
  it("accepts viaProductRender and still produces an mp4", async () => {
    const { mkdtemp, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { normalizeTrack } = await import("@/lib/tracking/segments");
    const dir = await mkdtemp(join(tmpdir(), "tpr-"));
    const out = join(dir, "o.mp4");
    await renderAnnotatedVideo({
      videoPath: SYNTHETIC_VIDEO_FIXTURE,
      track: normalizeTrack({ id: "t", fileId: "f", method: "manual", framerate: 5, durationSec: 1,
        samples: Array.from({ length: 6 }, (_, i) => ({ t: i / 5, x: 40, y: 40, w: 60, h: 60, confidence: 1, visible: true })) }),
      outPath: out, fps: 5, viaProductRender: true,
    });
    expect((await stat(out)).size).toBeGreaterThan(1000);
  }, 120_000);
});
