import { join } from "node:path";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { resolveOutputDir, makeOutputFileName } from "./output";

export interface PlaceholderOpts {
  /** filename prefix: tts | sfx | music | iso | stt */
  tool: string;
  /** seed text for the filename stem (first 5 chars used) */
  text: string;
  durationSeconds?: number;
  outputDirectory?: string | null;
}

/**
 * Write a deterministic sine-wave WAV placeholder to the resolved output dir and
 * return its absolute path. Mirrors fake-fal's audioPlaceholder but returns a
 * PATH (no storeFile / DB) — the agent imports it via libi.upload_file, matching
 * the real elevenlabs-mcp contract.
 */
export async function writeAudioPlaceholder(opts: PlaceholderOpts): Promise<string> {
  const dir = resolveOutputDir(opts.outputDirectory);
  const filename = makeOutputFileName(opts.tool, opts.text, "wav");
  const fullPath = join(dir, filename);
  const duration = opts.durationSeconds ?? 3;
  await runFfmpeg(
    ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-ar", "44100", fullPath],
    { op: "fake_ai_audio" },
  );
  return fullPath;
}
