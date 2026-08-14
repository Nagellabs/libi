import { dirname, join } from "node:path";
import type { AudioClip } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import { getStorage } from "@/lib/storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import { exportLogger as logger } from "@/lib/logger";

/**
 * Build the ffmpeg args for muxing a mixed audio track onto an already-rendered
 * VIDEO-ONLY file. Pure (no IO) so it's unit-testable.
 *
 *   -i <video>  -i <clip1> ... -i <clipN>
 *   -filter_complex <audio chain producing [aout]>
 *   -map 0:v:0 -map [aout]   ← copy the rendered video, attach the mixed audio
 *   -c:v copy                ← never re-encode the video (fast + lossless)
 *   -c:a aac|libopus -b:a …
 */
export function buildRenderMuxArgs(opts: {
  inputPaths: string[]; // [0] = video-only render; [1..] = audio clip sources
  audioChain: string;
  format: "mp4" | "webm";
  audioBitrate?: number;
  outPath: string;
}): string[] {
  const isWebm = opts.format === "webm";
  const args: string[] = ["-y"];
  for (const p of opts.inputPaths) args.push("-i", p);
  args.push("-filter_complex", opts.audioChain);
  args.push("-map", "0:v:0", "-map", "[aout]");
  args.push("-c:v", "copy");
  args.push("-c:a", isWebm ? "libopus" : "aac");
  args.push("-b:a", String(opts.audioBitrate ?? 192_000));
  if (!isWebm) args.push("-movflags", "+faststart");
  args.push(opts.outPath);
  return args;
}

/**
 * Mux the composition's audio onto a video-only render produced by the
 * chromium-render export path. The render page emits frames only (no audio
 * API in the canvas-source encoder), so this second ffmpeg pass mixes
 * `composition.audioClips[]` — inline scene audio + standalone clips — onto the
 * rendered file, matching the preview's audio policy (per-clip enabled, volume,
 * trim, timeline offset, sidechain ducking) via the shared `buildAudioMixGraph`.
 *
 * Video is stream-copied (`-c:v copy`) so this is fast and lossless. Returns
 * the path to the muxed file (in the SAME temp dir, so the backend's dir
 * cleanup removes both), or the original `videoPath` unchanged when there's no
 * audio to add (no enabled clips, missing source files, or non-local storage).
 */
export async function muxAudioIntoRender(opts: {
  videoPath: string;
  audioClips: AudioClip[];
  files: FileRecord[];
  format: "mp4" | "webm";
  audioBitrate?: number;
  durationSeconds?: number;
}): Promise<string> {
  const enabled = opts.audioClips.filter((c) => c.enabled);
  if (enabled.length === 0) return opts.videoPath;

  const storage = await getStorage();
  if (!(storage instanceof LocalFileStorage)) {
    logger.warn(
      { tag: "export", op: "export_render_audio_mux" },
      "non-local storage — skipping audio mux",
    );
    return opts.videoPath;
  }

  const fileById = new Map(opts.files.map((f) => [f.id, f]));
  // Input 0 is the rendered video; each enabled clip with a resolvable source
  // becomes inputs 1..N. ALWAYS the original file (never the proxy) — exports
  // read originals (the proxy invariant).
  const inputPaths: string[] = [opts.videoPath];
  const inputIndex = new Map<string, number>();
  const usable: AudioClip[] = [];
  for (const c of enabled) {
    const f = fileById.get(c.fileId);
    if (!f) {
      logger.warn(
        { tag: "export", op: "export_render_audio_mux", clipId: c.id, fileId: c.fileId },
        "audio clip source file missing from payload — skipping clip",
      );
      continue;
    }
    inputPaths.push(storage.localPath(f.pieceId, f.filename));
    inputIndex.set(c.id, inputPaths.length - 1);
    usable.push(c);
  }
  if (usable.length === 0) return opts.videoPath;

  // No base audio — the rendered file is video-only. duration=longest covers
  // the latest-ending clip; the output container length stays the video length
  // (clips never extend past the composition).
  const { chain } = buildAudioMixGraph({
    baseAudio: null,
    clips: usable,
    inputIndex,
    mixDuration: "longest",
  });
  if (!chain) return opts.videoPath;

  const ext = opts.format === "webm" ? "webm" : "mp4";
  const outPath = join(dirname(opts.videoPath), `out-audio.${ext}`);
  const args = buildRenderMuxArgs({
    inputPaths,
    audioChain: chain,
    format: opts.format,
    audioBitrate: opts.audioBitrate,
    outPath,
  });

  logger.info(
    { tag: "export", op: "export_render_audio_mux", clipCount: usable.length, format: opts.format },
    "muxing audio into chromium-render output",
  );
  await runFfmpeg(args, {
    op: "export_render_audio_mux",
    context: { clipCount: usable.length, format: opts.format },
    totalDurationSeconds: opts.durationSeconds,
  });
  return outPath;
}
