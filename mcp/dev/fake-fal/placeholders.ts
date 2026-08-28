import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runFfmpeg, resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { storeFile } from "@/mcp/tools/file-tools";
import type { FileRecord } from "@/lib/db/schema/types";
import type { ModelKind } from "./kb";

// --- copied verbatim from mcp/dev/fake-ai-assets/tools.ts ---

/** Sanitize for ffmpeg `drawtext`: escape backslash, single quote, colon, percent. */
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

/**
 * Some ffmpeg builds (e.g. minimal homebrew installs) ship without
 * `--enable-libfreetype`, which means the `drawtext` filter isn't available.
 * Detect once and skip the prompt overlay when missing — we still produce a
 * valid placeholder file, just without the stamp.
 */
let drawtextAvailableCache: boolean | null = null;
function isDrawtextAvailable(): boolean {
  if (drawtextAvailableCache !== null) return drawtextAvailableCache;
  try {
    const result = spawnSync(resolveFfmpegPath(), ["-hide_banner", "-filters"], {
      windowsHide: true,
      encoding: "utf8",
    });
    drawtextAvailableCache = /\bdrawtext\b/.test(result.stdout || "");
  } catch {
    drawtextAvailableCache = false;
  }
  return drawtextAvailableCache;
}

function safeFilename(prompt: string, ext: string, override?: string): string {
  if (override) return override.replace(/[^a-zA-Z0-9._-]/g, "-");
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  return `${slug || "fake"}-${randomUUID().slice(0, 8)}.${ext}`;
}

// --- end copied helpers ---

export interface PlaceholderOpts {
  prompt: string;
  pieceId?: string | null;
  width?: number;
  height?: number;
  durationSeconds?: number;
  filename?: string;
  endpointId?: string;
}

export async function makePlaceholder(kind: ModelKind, opts: PlaceholderOpts): Promise<FileRecord> {
  if (kind === "image") return imagePlaceholder(opts);
  if (kind === "video") return videoPlaceholder(opts);
  return audioPlaceholder(opts);
}

async function imagePlaceholder(opts: PlaceholderOpts): Promise<FileRecord> {
  const width = opts.width ?? 1024, height = opts.height ?? 1024;
  const filename = safeFilename(opts.prompt, "jpg", opts.filename);
  const tmp = path.join(os.tmpdir(), `fake-fal-${randomUUID()}.jpg`);
  const text = escapeDrawtext(opts.prompt.slice(0, 80));
  const args = ["-y", "-f", "lavfi", "-i", `color=c=#3b82f6:s=${width}x${height}`];
  if (isDrawtextAvailable()) args.push("-vf", `drawtext=text='[FAKE FAL] ${text}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=10`);
  args.push("-frames:v", "1", tmp);
  const startedAt = new Date();
  await runFfmpeg(args, { op: "fake_ai_image" });
  const completedAt = new Date();
  const buf = await fs.readFile(tmp);
  const stored = await storeFile({
    pieceId: opts.pieceId ?? null, filename, buffer: buf, contentType: "image/jpeg",
    name: filename, description: `[FAKE FAL] ${opts.prompt}`, mediaWidth: width, mediaHeight: height,
    aiGeneration: { provider: "fal-ai", model: opts.endpointId ?? "test-mode", prompt: opts.prompt,
      costEstimate: { amount: 0, currency: "USD", tier: "test-mode" },
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime() },
  });
  await fs.unlink(tmp).catch(() => {});
  return stored;
}

async function videoPlaceholder(opts: PlaceholderOpts): Promise<FileRecord> {
  const width = opts.width ?? 720, height = opts.height ?? 1280;
  const duration = opts.durationSeconds ?? 5;
  const filename = safeFilename(opts.prompt, "mp4", opts.filename);
  const tmp = path.join(os.tmpdir(), `fake-fal-${randomUUID()}.mp4`);
  const text = escapeDrawtext(opts.prompt.slice(0, 80));
  const args = [
    "-y",
    "-f", "lavfi", "-i", `color=c=#3b82f6:s=${width}x${height}:d=${duration}`,
    // A sine audio track so the placeholder reads as a REAL clip (hasAudio:true) and
    // libi.extract_audio can pull a @Audio1 voice reference from it. Without an audio
    // stream the Seedance voice-carry / stitch source-voice path can't be exercised in
    // test mode (extract_audio fails "Output file does not contain any stream").
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${duration}`,
  ];
  if (isDrawtextAvailable()) args.push("-vf", `drawtext=text='[FAKE FAL] ${text}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=10`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-shortest", tmp);
  const startedAt = new Date();
  await runFfmpeg(args, { op: "fake_ai_video" });
  const completedAt = new Date();
  const buf = await fs.readFile(tmp);
  const stored = await storeFile({
    pieceId: opts.pieceId ?? null, filename, buffer: buf, contentType: "video/mp4",
    name: filename, description: `[FAKE FAL] ${opts.prompt}`, mediaWidth: width, mediaHeight: height, mediaDuration: duration,
    aiGeneration: { provider: "fal-ai", model: opts.endpointId ?? "test-mode", prompt: opts.prompt,
      costEstimate: { amount: 0, currency: "USD", tier: "test-mode" },
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime() },
  });
  await fs.unlink(tmp).catch(() => {});
  return stored;
}

async function audioPlaceholder(opts: PlaceholderOpts): Promise<FileRecord> {
  const duration = opts.durationSeconds ?? 3;
  const filename = safeFilename(opts.prompt, "wav", opts.filename);
  const tmp = path.join(os.tmpdir(), `fake-fal-${randomUUID()}.wav`);
  const startedAt = new Date();
  await runFfmpeg(["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-ar", "44100", tmp], { op: "fake_ai_audio" });
  const completedAt = new Date();
  const buf = await fs.readFile(tmp);
  const stored = await storeFile({
    pieceId: opts.pieceId ?? null, filename, buffer: buf, contentType: "audio/wav",
    name: filename, description: `[FAKE FAL audio] ${opts.prompt}`, mediaDuration: duration, hasAudio: true,
    aiGeneration: { provider: "fal-ai", model: opts.endpointId ?? "test-mode-audio", prompt: opts.prompt,
      costEstimate: { amount: 0, currency: "USD", tier: "test-mode" },
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime() },
  });
  await fs.unlink(tmp).catch(() => {});
  return stored;
}
