import { join } from "node:path";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { resolveOutputDir } from "./output";

/**
 * Write a deterministic sine-wave MP3 placeholder named `<stem>.mp3` to the
 * output dir and return its absolute path. ElevenLabs' hosted server hands back
 * mp3 (audio/mpeg, 128 kbps, 44.1 kHz, mono — the 2026-09-25 live run), so the
 * placeholder is the same. The fake serves it at an output URL
 * (`./output.ts#outputUrl`); the agent downloads that and imports it with
 * libi.upload_file, as it does with ElevenLabs' real output URL.
 */
export async function writeAudioPlaceholder(opts: { stem: string; durationSeconds?: number; frequency?: number }): Promise<string> {
  const fullPath = join(resolveOutputDir(), `${opts.stem}.mp3`);
  const duration = opts.durationSeconds ?? 3;
  await runFfmpeg(
    [
      "-y", "-f", "lavfi", "-i", `sine=frequency=${opts.frequency ?? 440}:duration=${duration}`,
      "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", fullPath,
    ],
    { op: "fake_ai_audio" },
  );
  return fullPath;
}
