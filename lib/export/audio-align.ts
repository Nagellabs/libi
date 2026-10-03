/**
 * `libi.audio_analyze` align, the file side: decode the reference excerpt and the recording to mono
 * 8 kHz float with ffmpeg and hand them to `lib/audio/align.ts`.
 *
 * Both are decoded FROM THE START of their file and cut by sample, never by an input seek: a seek is
 * only as exact as the container, and the offset is wanted to the millisecond. A file whose audio
 * starts late (a lead the container hides) is read as ffmpeg decodes it, which is how the clips
 * themselves play from it except for the Ogg / MPEG-TS corner `ProbedMedia.audioRead` handles.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { ALIGN_MAX_REFERENCE_SEC, ALIGN_RATE, alignOffset, type AlignResult } from "@/lib/audio/align";

/** Longest recording (seconds of it, from its start to the end of the window) a call decodes. */
export const ALIGN_MAX_TARGET_SEC = 2400;

async function decodeMono(path: string, seconds: number, scratch: string, name: string, signal?: AbortSignal): Promise<Float32Array> {
  const raw = join(scratch, `${name}.f32`);
  await runFfmpeg(
    ["-y", "-i", path, "-vn", "-t", String(seconds), "-ac", "1", "-ar", String(ALIGN_RATE), "-f", "f32le", raw],
    { op: "audio_align_decode", context: { name }, signal },
  );
  const buf = await fs.readFile(raw);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export interface AlignInFileResult extends AlignResult {
  /** Seconds of the reference that were matched (capped). */
  referenceSec: number;
  /** Where the excerpt ENDS in the recording: the continuation point. */
  endsAtSec: number;
}

export type AlignFailure = "reference_too_short" | "reference_longer_than_window" | "reference_silent";

export async function alignInFile(opts: {
  /** The excerpt: a source file, from `trimStart` for `duration` seconds (what a clip plays). */
  reference: { path: string; trimStart: number; duration: number };
  target: { path: string };
  /** Seconds of the target to search. */
  window?: { from?: number; to?: number };
  signal?: AbortSignal;
}): Promise<{ ok: true; result: AlignInFileResult } | { ok: false; reason: AlignFailure }> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "libi-align-"));
  try {
    const refSec = Math.min(opts.reference.duration, ALIGN_MAX_REFERENCE_SEC);
    const refAll = await decodeMono(opts.reference.path, opts.reference.trimStart + refSec, dir, "ref", opts.signal);
    const refFrom = Math.round(opts.reference.trimStart * ALIGN_RATE);
    const ref = refAll.slice(refFrom, refFrom + Math.round(refSec * ALIGN_RATE));
    if (ref.length < ALIGN_RATE * 0.5) return { ok: false, reason: "reference_too_short" };
    if (!ref.some((v) => Math.abs(v) > 1e-4)) return { ok: false, reason: "reference_silent" };

    const windowTo = Math.min(opts.window?.to ?? ALIGN_MAX_TARGET_SEC, ALIGN_MAX_TARGET_SEC);
    const target = await decodeMono(opts.target.path, windowTo, dir, "target", opts.signal);
    const found = alignOffset(ref, target, ALIGN_RATE, { windowFrom: opts.window?.from, windowTo });
    if (!found) return { ok: false, reason: "reference_longer_than_window" };
    const referenceSec = ref.length / ALIGN_RATE;
    return { ok: true, result: { ...found, referenceSec, endsAtSec: found.offsetSec + referenceSec } };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
