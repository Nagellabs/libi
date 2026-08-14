import { describe, it, expect } from "vitest";
import { renderAnnotatedVideo } from "@/scripts/track-eval/render";
import { hasFaceFixture, FIXTURE_SKIP_REASON } from "./fixture-guard";

if (!hasFaceFixture) console.info(`[skip] ${FIXTURE_SKIP_REASON}`);

describe.skipIf(!hasFaceFixture)("renderAnnotatedVideo viaProductRender", () => {
  it("accepts viaProductRender and still produces an mp4", async () => {
    const { mkdtemp, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { normalizeTrack } = await import("@/lib/tracking/segments");
    const dir = await mkdtemp(join(tmpdir(), "tpr-"));
    const out = join(dir, "o.mp4");
    await renderAnnotatedVideo({
      videoPath: "__tests__/fixtures/tracking/non-selfie-face-5s.mp4",
      track: normalizeTrack({ id: "t", fileId: "f", method: "manual", framerate: 5, durationSec: 1,
        samples: Array.from({ length: 6 }, (_, i) => ({ t: i / 5, x: 40, y: 40, w: 60, h: 60, confidence: 1, visible: true })) }),
      outPath: out, fps: 5, viaProductRender: true,
    });
    expect((await stat(out)).size).toBeGreaterThan(1000);
  }, 120_000);
});
