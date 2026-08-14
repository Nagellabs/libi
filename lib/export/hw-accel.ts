import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { serverLogger as logger, exportLogger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

let cached: Set<string> | null = null;

export async function detectAvailableEncoders(): Promise<Set<string>> {
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync(resolveFfmpegPath(), ["-encoders"], { timeout: 5000 });
    cached = parseAvailableEncoders(stdout);
    exportLogger.info(
      { event: "encoder_detect", platform: process.platform, available: Array.from(cached) },
      "export.encoder_detect",
    );
    return cached;
  } catch (err) {
    logger.warn({ err }, "encoder detection failed");
    // Do NOT cache failures — let the next call retry (ffmpeg may still be
    // provisioning via DependencyManager, or the first attempt hit a transient
    // issue). Returning the fresh empty set only for THIS call.
    return new Set<string>();
  }
}

export function parseAvailableEncoders(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    // Format: " V....D encoder_name  description"
    // Flag column: 1 type char (V/A/S) + 5 flag chars from the set [\w.-]
    // (covers D, F, X, B, S, L, etc. plus `.`). Banner/separator lines lack
    // the leading type char and are naturally rejected. Name group is
    // [\w-]+ to reject the banner-header " V..... = Video" where the
    // captured token would otherwise be `=`.
    const m = line.match(/^\s*[VAS][\w.-]{5}\s+([\w-]+)\s+/);
    if (m) names.add(m[1]);
  }
  return names;
}

export type VideoCodecTarget = "h264" | "hevc" | "vp9" | "av1";

/**
 * Given an available-encoder set, pick the best encoder for the target codec.
 * Prefers hardware over software per-platform. Returns null if even libx264
 * isn't available (highly unusual — bundled ffmpeg always has it).
 */
export function pickEncoder(
  target: VideoCodecTarget,
  available: Set<string>,
  platform: NodeJS.Platform,
): string | null {
  const preferenceOrder: string[] =
    target === "h264"
      ? platform === "darwin"
        ? ["h264_videotoolbox", "libx264"]
        : ["h264_nvenc", "h264_vaapi", "libx264"]
      : target === "hevc"
      ? platform === "darwin"
        ? ["hevc_videotoolbox", "libx265"]
        : ["hevc_nvenc", "libx265"]
      : target === "vp9"
      ? ["libvpx-vp9"]
      : ["libaom-av1"];

  for (const enc of preferenceOrder) {
    if (available.has(enc)) return enc;
  }
  return null;
}
