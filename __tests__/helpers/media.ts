import { execFile, execSync } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

export interface MediaProbe {
  duration: number | null;
  format: string | null;
  videoStream: { codec: string; width: number; height: number; fps: number } | null;
  audioStream: { codec: string; sampleRate: number; channels: number } | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: FfprobeStream[];
}

export async function probe(filePath: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeout: 10_000 },
  );
  const j = JSON.parse(stdout) as FfprobeOutput;
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  return {
    duration: j.format?.duration ? parseFloat(j.format.duration) : null,
    format: j.format?.format_name ?? null,
    videoStream:
      v && v.width != null && v.height != null
        ? {
            codec: v.codec_name,
            width: v.width,
            height: v.height,
            fps: evalRate(v.avg_frame_rate ?? "0/1"),
          }
        : null,
    audioStream:
      a && a.sample_rate != null && a.channels != null
        ? {
            codec: a.codec_name,
            sampleRate: parseInt(a.sample_rate, 10),
            channels: a.channels,
          }
        : null,
  };
}

function evalRate(s: string): number {
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : n;
}

/**
 * Extract a single RGBA frame at the given time. Returns { rgba, width, height }.
 * Caller samples pixels by offset into the rgba buffer.
 * Throws if the file has no video stream or ffprobe fails.
 */
export async function extractFrameRgba(
  videoPath: string,
  timeSeconds: number,
): Promise<{ rgba: Buffer; width: number; height: number }> {
  const info = await probe(videoPath);
  if (!info.videoStream) throw new Error(`No video stream in ${videoPath}`);
  const { width, height } = info.videoStream;
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v", "error",
      "-ss", String(timeSeconds),
      "-i", videoPath,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-",
    ],
    { timeout: 15_000, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return { rgba: stdout as unknown as Buffer, width, height };
}

export function samplePixel(
  frame: { rgba: Buffer; width: number; height: number },
  x: number,
  y: number,
): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new Error(`samplePixel out of bounds: (${x},${y}) in ${frame.width}x${frame.height}`);
  }
  const i = (y * frame.width + x) * 4;
  return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2], frame.rgba[i + 3]];
}

/** Mean RGB across a rect — useful for "is this region close to red?" style asserts. */
export function sampleRegionMean(
  frame: { rgba: Buffer; width: number; height: number },
  rect: { x: number; y: number; w: number; h: number },
): [number, number, number] {
  if (
    rect.x < 0 || rect.y < 0 ||
    rect.w <= 0 || rect.h <= 0 ||
    rect.x + rect.w > frame.width ||
    rect.y + rect.h > frame.height
  ) {
    throw new Error(`sampleRegionMean out of bounds: ${JSON.stringify(rect)} in ${frame.width}x${frame.height}`);
  }
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
    for (let xx = rect.x; xx < rect.x + rect.w; xx++) {
      const i = (yy * frame.width + xx) * 4;
      r += frame.rgba[i]; g += frame.rgba[i + 1]; b += frame.rgba[i + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** Parses the `mean_volume` (dBFS) from ffmpeg's volumedetect filter. */
export async function audioMeanVolumeDb(filePath: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", filePath, "-filter:a", "volumedetect", "-f", "null", "-"],
      { timeout: 20_000 },
    );
    const m = /mean_volume: *(-?\d+(?:\.\d+)?) dB/.exec(stderr);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

export async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const buf = await fs.promises.readFile(filePath);
  hash.update(buf);
  return hash.digest("hex");
}

export async function listTmpExportDirs(): Promise<string[]> {
  const entries = await fs.promises.readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("libi-export-")).map((e) => path.join(os.tmpdir(), e));
}

/** Cheap on-demand guard — matches the existing skip pattern in integration tests. */
export function hasFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

export function hasDrawtext(): boolean {
  try {
    const out = execSync("ffmpeg -hide_banner -filters", { timeout: 3000 }).toString();
    return /\bdrawtext\b/.test(out);
  } catch {
    return false;
  }
}
