import { describe, it, expect, afterAll } from "vitest";
import { stat, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderAnnotatedVideo } from "@/scripts/track-eval/render";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track } from "@/lib/tracking/types";
import { SYNTHETIC_VIDEO_FIXTURE } from "./fixture-guard";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

// Draws boxes from a hand-built track over arbitrary pixels — no face needed,
// so this uses the committed synthetic clip and runs everywhere.
const fixture = SYNTHETIC_VIDEO_FIXTURE;
let outDir = "";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);

describe.skipIf(!hasFfmpeg())("renderAnnotatedVideo", () => {
  it("produces an annotated mp4 from a hand-built track over the fixture", async () => {
    outDir = await mkdtemp(join(tmpdir(), "track-eval-"));
    const out = join(outDir, "annotated.mp4");
    const track: Track = normalizeTrack({
      id: "trk", fileId: "f", method: "manual", framerate: 5, durationSec: 1,
      samples: Array.from({ length: 6 }, (_, i) => ({
        t: i / 5, x: 50 + i, y: 50, w: 80, h: 80, confidence: 1, visible: true,
      })),
    });
    await renderAnnotatedVideo({ videoPath: fixture, track, outPath: out, fps: 5 });
    const s = await stat(out);
    expect(s.size).toBeGreaterThan(1000);
  }, 60_000);
});

afterAll(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });
