// Next.js-SERVER-ONLY. Uses ffmpeg + @napi-rs/canvas. NEVER import this from
// any file under mcp/. Strictly READ-ONLY: must not import lib/jobs/* or
// lib/tracking/apply-segment-result.
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { selectVerifyTimes } from "@/lib/tracking/verify-grid";
import type { IdentityCandidate } from "@/lib/tracking/identity-candidates";

/** Stable, high-contrast palette; candidate i → CANDIDATE_PALETTE[i % len]. */
export const CANDIDATE_PALETTE = [
  "lime", "cyan", "magenta", "yellow", "orange", "deeppink",
] as const;

/**
 * Maximum distance (seconds) between a candidate's nearest perFrame entry and
 * the sampled frame time before we consider the candidate absent at that frame.
 * The sidecar emits perFrame at video fps, so a genuinely-present candidate's
 * nearest sample is within ~1/fps ≪ 0.5s.  A value > 0.5s means the tracklet
 * had no detection anywhere near t — drawing its stale position would be a
 * phantom box that misleads identity selection.
 */
export const CANDIDATE_PRESENCE_TOL_SEC = 0.5;

export function candidateColor(index: number): string {
  return CANDIDATE_PALETTE[index % CANDIDATE_PALETTE.length];
}

/**
 * Sampled times across the ambiguous window.
 * Uses the verify-grid's selectVerifyTimes, treating the window as focusRange
 * and capping to n frames. Times are filtered to [range.start, range.end].
 */
export function selectCandidateFrameTimes(
  range: { start: number; end: number },
  n: number,
): number[] {
  const result = selectVerifyTimes({
    clipDurationSec: range.end,
    fps: 30,
    manualAnchorTimes: [],
    issueRanges: [],
    lostRanges: [],
    focusRange: range,
    extraTimes: [],
    cap: n,
  });
  return result.times.filter((t) => t >= range.start && t <= range.end);
}

export interface CandidateFrame { time: number; pngBase64: string; }

export interface CandidateBox {
  candidateId: number;
  bbox: [number, number, number, number];
  color: string;
}

/**
 * Pure: the candidate boxes that should be drawn at sampled time `t`.
 * Returns one entry per candidate that has a perFrame sample within `tol`
 * seconds of `t`. Candidates with no nearby sample (stale tracklets) are
 * excluded — drawing their stale position would be a phantom box.
 */
export function candidateBoxesAt(
  candidates: IdentityCandidate[],
  t: number,
  tol: number = CANDIDATE_PRESENCE_TOL_SEC,
): CandidateBox[] {
  const out: CandidateBox[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.perFrame.length === 0) continue;
    const pf = c.perFrame.reduce(
      (best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best),
      c.perFrame[0],
    );
    if (Math.abs(pf.t - t) > tol) continue;
    out.push({ candidateId: c.candidateId, bbox: pf.bbox, color: candidateColor(i) });
  }
  return out;
}

// Injectable for tests.
export interface RenderCandidateFramesDeps {
  extractFrame?: (srcPath: string, time: number) => Promise<Buffer>;
}

async function ffmpegExtractFrame(srcPath: string, time: number): Promise<Buffer> {
  const tmp = path.join("/tmp", `cand-frame-${randomUUID().slice(0, 8)}.png`);
  await runFfmpeg(["-y", "-ss", String(time), "-i", srcPath, "-frames:v", "1", tmp], {
    op: "verify_extract_frame",
  });
  const buf = await fs.readFile(tmp);
  await fs.unlink(tmp).catch(() => {});
  return buf;
}

/**
 * For each sampled time, draw EVERY candidate's nearest bounding box in its
 * palette color (labelled `#candidateId`) on the source frame. Returns one
 * composited PNG (base64) per sampled time for the agent to eyeball + pick.
 *
 * Frame extraction and canvas compositing mirror verify-render.ts exactly:
 *   1. ffmpegExtractFrame → Buffer
 *   2. loadImage + createCanvas + ctx.drawImage
 *   3. canvas.encode("png").toString("base64")
 */
export async function renderCandidateFrames(
  args: {
    srcPath: string;
    frameW: number;
    frameH: number;
    candidates: IdentityCandidate[];
    range: { start: number; end: number };
    framesPerWindow?: number;
  },
  deps: RenderCandidateFramesDeps = {},
): Promise<CandidateFrame[]> {
  const extract = deps.extractFrame ?? ffmpegExtractFrame;
  const times = selectCandidateFrameTimes(
    args.range,
    args.framesPerWindow ?? 6,
  );

  const frames: CandidateFrame[] = [];
  for (const t of times) {
    let img: Awaited<ReturnType<typeof loadImage>>;
    try {
      img = await loadImage(await extract(args.srcPath, t));
    } catch {
      // Mirror verify-render.ts: one unreadable frame must not abort the batch.
      // Skip this time and continue with the remaining frames.
      continue;
    }

    const canvas = createCanvas(args.frameW, args.frameH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, args.frameW, args.frameH);

    // Draw each candidate's nearest bounding box in its palette color.
    const boxes = candidateBoxesAt(args.candidates, t);
    for (const b of boxes) {
      const [bx, by, bw, bh] = b.bbox;
      // Convert CSS color name to a canvas hex or rgb; use a simple approach:
      // draw the box using the color name directly via ctx.strokeStyle.
      ctx.strokeStyle = b.color;
      ctx.lineWidth = Math.max(2, Math.round(args.frameW / 320));
      ctx.strokeRect(bx, by, bw, bh);

      // Label above the box.
      const label = `#${b.candidateId}`;
      ctx.fillStyle = b.color;
      ctx.font = `${Math.max(12, Math.round(args.frameW / 40))}px sans-serif`;
      ctx.fillText(label, bx + 2, Math.max(12, by - 4));
    }

    const png = await canvas.encode("png");
    frames.push({ time: t, pngBase64: png.toString("base64") });
  }
  return frames;
}
