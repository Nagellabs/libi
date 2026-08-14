import { spawn } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { sampleTrack } from "@/lib/tracking/sample";
import { applyFitAndScale } from "@/lib/engine/overlay-renderer";
import { drawTrackBox } from "@/scripts/track-eval/draw";
import type { Track } from "@/lib/tracking/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const SEG_COLORS = ["#ff2d2d", "#2d8cff", "#2dff7a", "#ffd02d", "#d02dff", "#2dffe6"];

async function probe(videoPath: string): Promise<{ w: number; h: number; durationSec: number }> {
  const ffprobe = resolveFfprobePath();
  const { stdout } = await pexec(ffprobe, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-show_entries", "format=duration",
    "-of", "json", videoPath,
  ]);
  const j = JSON.parse(stdout);
  return {
    w: j.streams[0].width, h: j.streams[0].height,
    durationSec: parseFloat(j.format.duration),
  };
}

export interface RenderOpts {
  videoPath: string;
  track: Track;
  outPath: string;
  /** Render fps. Defaults to the track framerate. */
  fps?: number;
  range?: { start: number; end: number };
  /**
   * When true, the per-frame box rect is computed by the REAL product
   * track→rect path — `sampleTrack` (`@/lib/tracking/sample`) +
   * `applyFitAndScale` (`@/lib/engine/overlay-renderer`), the exact two
   * functions the product's "tracked" overlay case uses to turn a sampled
   * track bbox into an on-screen rect. This validates the genuine product
   * math end-to-end. The full `drawOverlay` path is NOT invoked here — it
   * needs a browser `DrawOverlayContext` (image/video/code asset maps,
   * effects sourceCanvas) that can't be stood up cleanly from a standalone
   * node script. Reusing the product's sample+fit functions (not a
   * reimplementation) is the bounded, honest validation: a fit-math
   * regression surfaces in the harness too.
   *
   * When false/absent, behavior is EXACTLY as before — the INDEPENDENT
   * drawer (`drawTrackBox`) remains the default debug oracle so a render
   * bug can't mask a tracking bug.
   */
  viaProductRender?: boolean;
}

export async function renderAnnotatedVideo(opts: RenderOpts): Promise<void> {
  const { videoPath, track, outPath } = opts;
  const fps = opts.fps ?? track.framerate ?? 30;
  const { w, h, durationSec } = await probe(videoPath);
  const start = opts.range?.start ?? 0;
  const end = opts.range?.end ?? durationSec;

  const ffmpeg = resolveFfmpegPath();
  const decoder = spawn(ffmpeg, [
    "-v", "error",
    "-ss", String(start), "-to", String(end),
    "-i", videoPath,
    "-vf", `fps=${fps}`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "-",
  ], { stdio: ["ignore", "pipe", "inherit"] });

  const encoder = spawn(ffmpeg, [
    "-v", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps),
    "-i", "-",
    "-ss", String(start), "-to", String(end), "-i", videoPath,
    "-map", "0:v", "-map", "1:a?",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-c:a", "aac", "-shortest", "-y", outPath,
  ], { stdio: ["pipe", "inherit", "inherit"] });

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const frameBytes = w * h * 4;
  let buf = Buffer.alloc(0);
  let frameIdx = 0;

  const segColor = new Map<string, string>();
  (track.segments ?? []).forEach((s, i) =>
    segColor.set(s.id, SEG_COLORS[i % SEG_COLORS.length]));

  function segAt(t: number) {
    return (track.segments ?? []).find((s) => t >= s.startTime && t <= s.endTime);
  }

  await new Promise<void>((resolve, reject) => {
    decoder.stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameBytes) {
        const frame = buf.subarray(0, frameBytes);
        buf = buf.subarray(frameBytes);
        const t = start + frameIdx / fps;
        const img = ctx.createImageData(w, h);
        img.data.set(frame);
        ctx.putImageData(img, 0, 0);
        const s = sampleTrack(track, t, "linear");
        const seg = segAt(t);
        if (s) {
          if (opts.viaProductRender) {
            // PRODUCT PATH: drive the box rect through the genuine product
            // track→rect math. `sampleTrack` (already used above) is the
            // product sampler; `applyFitAndScale` is the exact private fit
            // helper the "tracked" overlay case in overlay-renderer.ts uses
            // (exported minimally for this harness). We feed it a synthetic
            // tracked overlay with the product's default `"tight"` fit and
            // scale=1 so the resulting rect is the product's interpretation
            // of the sampled bbox — not the harness's own positioning. The
            // stroke itself reuses @napi-rs/canvas, but the RECT is product
            // code. A fit/scale regression breaks this output too.
            if (s.visible) {
              const bbox = applyFitAndScale(
                { x: s.x, y: s.y, w: s.w, h: s.h },
                { x: s.x, y: s.y, width: s.w, height: s.h },
                "tight",
                1,
              );
              const caption =
                `t=${t.toFixed(2)}s conf=${s.confidence.toFixed(2)} ` +
                `vis=${s.visible} [product-render]`;
              ctx.font = "16px sans-serif";
              ctx.fillStyle = "rgba(0,0,0,0.6)";
              ctx.fillRect(0, 0, ctx.measureText(caption).width + 12, 24);
              ctx.fillStyle = "#ffffff";
              ctx.fillText(caption, 6, 17);
              ctx.strokeStyle = "#ff2d2d";
              ctx.lineWidth = 3;
              ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
            }
          } else {
            drawTrackBox(ctx, { ...s, t }, {
              segmentLabel: seg ? String(seg.method) : "—",
              segmentStatus: seg ? seg.status : "—",
              color: seg ? segColor.get(seg.id) : "#ff2d2d",
            });
          }
        }
        if (!encoder.stdin.write(Buffer.from(ctx.getImageData(0, 0, w, h).data))) {
          decoder.stdout.pause();
          encoder.stdin.once("drain", () => decoder.stdout.resume());
        }
        frameIdx++;
      }
    });
    decoder.on("close", () => encoder.stdin.end());
    encoder.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`encoder exited ${code}`)));
    decoder.on("error", reject);
    encoder.on("error", reject);
  });
}
