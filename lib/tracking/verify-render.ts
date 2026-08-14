// Next.js-SERVER-ONLY. Uses ffmpeg + @napi-rs/canvas. NEVER import this from
// any file under mcp/. Strictly READ-ONLY: must not import lib/jobs/* or
// lib/tracking/apply-segment-result.
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { sampleTrack } from "@/lib/tracking/sample";
import { resolveTrackedRect } from "@/lib/engine/overlay-renderer";
import { serverLogger as logger } from "@/lib/logger";
import type { Track, TrackedContent, TrackFit, TrackSmoothing } from "@/lib/tracking/types";

export interface VerifyFrame {
  time: number;
  pngBase64?: string;
  error?: string;
  segmentId: string | null;
  method: string | null;
  status: string | null;
  objectKind: string | null;
  isAnchorFrame: boolean;
  sampledRect: { x: number; y: number; w: number; h: number } | null;
  trackBbox: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
}

export interface RenderVerifyInput {
  track: Track;
  srcPath: string;
  frameW: number;
  frameH: number;
  times: number[];
  content: TrackedContent;
  fit: TrackFit;
  scale: number;
  smoothing: TrackSmoothing;
  offset?: { x: number; y: number };
  manualAnchorTimes: number[];
  agentAnchorTimes: number[];
}

export interface RenderVerifyDeps {
  /** Injected in tests; default = real ffmpeg single-frame extract. */
  extractFrame?: (srcPath: string, time: number) => Promise<Buffer>;
}

async function ffmpegExtractFrame(srcPath: string, time: number): Promise<Buffer> {
  const tmp = path.join("/tmp", `verify-${randomUUID().slice(0, 8)}.png`);
  await runFfmpeg(["-y", "-ss", String(time), "-i", srcPath, "-frames:v", "1", tmp], {
    op: "verify_extract_frame",
  });
  const buf = await fs.readFile(tmp);
  await fs.unlink(tmp).catch(() => {});
  return buf;
}

function segmentAt(track: Track, t: number) {
  const segs = track.segments ?? [];
  return segs.find((s) => t >= s.startTime && t <= s.endTime) ?? null;
}

export async function renderVerifyFrames(
  input: RenderVerifyInput,
  deps: RenderVerifyDeps = {},
): Promise<{ frames: VerifyFrame[] }> {
  const extract = deps.extractFrame ?? ffmpegExtractFrame;
  const eps = 0.2;
  const isAnchor = (t: number) =>
    input.manualAnchorTimes.some((a) => Math.abs(a - t) <= eps) ||
    input.agentAnchorTimes.some((a) => Math.abs(a - t) <= eps);

  const frames: VerifyFrame[] = [];
  for (const time of input.times) {
    const seg = segmentAt(input.track, time);
    const sample = sampleTrack(input.track, time, input.smoothing);
    const visible = !!sample && sample.visible;
    const base: VerifyFrame = {
      time,
      segmentId: seg?.id ?? null,
      method: seg ? String(seg.method) : null,
      status: seg?.status ?? null,
      objectKind: seg?.objectKind ?? null,
      isAnchorFrame: isAnchor(time),
      sampledRect: null,
      trackBbox: sample ? { x: sample.x, y: sample.y, w: sample.w, h: sample.h } : null,
      visible,
    };

    let img: Awaited<ReturnType<typeof loadImage>>;
    try {
      img = await loadImage(await extract(input.srcPath, time));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.warn(
        { tag: "tracking-verify", op: "verify.extract.fail", time, err: error },
        "verify frame extract failed",
      );
      frames.push({ ...base, error });
      continue;
    }

    const canvas = createCanvas(input.frameW, input.frameH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, input.frameW, input.frameH);

    if (sample && sample.visible) {
      const r = resolveTrackedRect(
        { x: sample.x, y: sample.y, w: sample.w, h: sample.h },
        {
          rect: { x: 0, y: 0, width: input.frameW, height: input.frameH },
          fit: input.fit,
          scale: input.scale,
          offset: input.offset,
        },
        { width: input.frameW, height: input.frameH },
      );
      base.sampledRect = { x: r.x, y: r.y, w: r.w, h: r.h };
      ctx.strokeStyle = "#ff2d2d";
      ctx.lineWidth = Math.max(2, Math.round(input.frameW / 320));
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      if (input.content.kind === "emoji" || input.content.kind === "text") {
        const text =
          input.content.kind === "emoji" ? input.content.char : input.content.content;
        ctx.font = `${Math.max(12, Math.round(r.h * 0.7))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle =
          input.content.kind === "text" ? input.content.color : "#000";
        ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2);
      } else {
        ctx.fillStyle = "rgba(255,45,45,0.85)";
        ctx.font = `${Math.max(12, Math.round(input.frameW / 40))}px sans-serif`;
        ctx.fillText(input.content.kind, r.x + 4, Math.max(14, r.y - 6));
      }
    }

    const png = await canvas.encode("png");
    frames.push({ ...base, pngBase64: png.toString("base64") });
  }
  return { frames };
}
