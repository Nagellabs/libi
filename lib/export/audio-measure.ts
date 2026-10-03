/**
 * Measure a piece's mix THROUGH THE EXPORT PATH: `libi.audio_analyze` measure.
 *
 * The agent had nothing that said how loud the mix was. It decoded the files itself and computed
 * RMS in numpy, which measures the SOURCES, not what the piece plays: the duck, the clip's gain,
 * volume envelope, fades and crossfades never entered it, so a "the music is silent at 74 s"
 * question took two dozen calls (docs-local/research/2026-10-03-dreams-session-analysis.md P3/P8).
 *
 * So this renders the same mix an export would: `prepareAudioMix` (the chromium-render mux's own
 * input and graph builder: original files, ducks as pre-rendered gain tracks, envelopes and
 * crossfades as shape tracks), over the covering range only, to raw float stereo, and reads the
 * levels off it. Per clip, the same graph over that ONE clip with every other clip still in place as
 * its duck's sidechain, so a clip's number is what it contributes to the mix, not what its file holds.
 *
 * What it does not do: apply the export dialog's copyrighted-audio exclusion (it measures what the
 * preview plays and what a personal export carries), or encode (a measure is of the mix, before the
 * AAC/Opus stage; the limiter the export applies at full scale IS in the graph).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { AudioClip } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { canonicalHash } from "@/lib/jobs/canonical-hash";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { prepareAudioMix } from "@/lib/export/render-audio-mux";
import { MONO_OR_STEREO_TO_STEREO } from "@/lib/export/audio-mix";
import { analyzeLoudness, LOUDNESS_RATE, SILENCE_DB, type LoudnessResult } from "@/lib/audio/loudness";
import { exportLogger as logger } from "@/lib/logger";

/** Most seconds one call renders (the covering range of every range asked for). */
export const MEASURE_MAX_SPAN_SEC = 600;
/** Most ranges in one call. */
export const MEASURE_MAX_RANGES = 8;
/** Most clips measured one by one in one call; the rest are named, not measured. */
export const MEASURE_MAX_CLIPS = 10;
/** Seconds before a range that warm the K-weighting filters up. */
const PRE_ROLL_SEC = 0.5;

export interface MeasureRange {
  from: number;
  to: number;
}

export interface Levels {
  /** Integrated, gated LUFS; null when the range is under 0.4 s or silent. */
  lufs: number | null;
  /** Loudest 3 s window; null when the range is under 3 s. */
  shortTermMaxLufs: number | null;
  /** RMS of both channels, dBFS; -90 = silence. */
  rmsDb: number;
  /** Sample peak, dBFS; -90 = silence. */
  peakDb: number;
  silent: boolean;
}

export interface RangeMeasure extends MeasureRange, Levels {
  /** Per clip, when asked (`per: "clip"`): each clip's own contribution to the mix in this range. */
  clips?: Array<{ clipId: string; label?: string } & Levels>;
}

export interface MeasureResult {
  ranges: RangeMeasure[];
  /** Clips that overlap a range but were not measured one by one (over the cap, or not in the mix). */
  clipsNotMeasured?: Array<{ clipId: string; why: string }>;
  /** Plain-words remark: an empty mix, a range past the end of the audio. */
  note?: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const levels = (r: LoudnessResult): Levels => ({
  lufs: r.lufs === null ? null : round1(r.lufs),
  shortTermMaxLufs: r.shortTermMaxLufs === null ? null : round1(r.shortTermMaxLufs),
  rmsDb: round1(r.rmsDb),
  peakDb: round1(r.peakDb),
  silent: r.silent,
});

/**
 * A key for the audio the mix would render: the exported audio clips (a hidden layer's inline sound
 * is out) with every field, and the identity of each file they read. Two manifests with the same key
 * mix identically, which is what lets a repeated measure be answered from the job cache.
 */
export function audioMixHash(
  manifest: Pick<CompositionManifest, "overlays" | "audioClips">,
  files: Array<Pick<FileRecord, "id" | "filename" | "size" | "mediaDuration">>,
): string {
  const clips = (manifestAsExported(manifest as CompositionManifest).audioClips ?? []) as AudioClip[];
  const used = new Set(clips.map((c) => c.fileId));
  return canonicalHash({
    clips: [...clips].sort((a, b) => a.id.localeCompare(b.id)),
    files: files
      .filter((f) => used.has(f.id))
      .map((f) => ({ id: f.id, filename: f.filename, size: f.size, mediaDuration: f.mediaDuration ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/** Validate ranges the same way for the tool and the runner. Returns an error text, or null. */
export function checkRanges(ranges: readonly MeasureRange[]): string | null {
  if (ranges.length === 0) return "ranges is empty: give at least one { from, to } in seconds.";
  if (ranges.length > MEASURE_MAX_RANGES) return `at most ${MEASURE_MAX_RANGES} ranges per call (got ${ranges.length}).`;
  for (const r of ranges) {
    if (!(Number.isFinite(r.from) && Number.isFinite(r.to)) || r.from < 0 || r.to <= r.from) {
      return `range ${r.from}–${r.to} is not valid: from must be at least 0 and less than to.`;
    }
  }
  const from = Math.min(...ranges.map((r) => r.from));
  const to = Math.max(...ranges.map((r) => r.to));
  if (to - from > MEASURE_MAX_SPAN_SEC) {
    return `the ranges span ${Math.round(to - from)} s from the earliest start to the latest end; at most ${MEASURE_MAX_SPAN_SEC} s per call. Measure the far-apart ranges in separate calls.`;
  }
  return null;
}

/** Render `chain` over [from, from+span) to raw 48 kHz stereo float at `outPath`. */
async function renderRaw(opts: {
  inputPaths: string[];
  inputOptions: Map<number, string[]>;
  chain: string;
  from: number;
  span: number;
  outPath: string;
  op: string;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}): Promise<void> {
  const args: string[] = ["-y"];
  opts.inputPaths.forEach((p, i) => args.push(...(opts.inputOptions.get(i) ?? []), "-i", p));
  // Whatever the mix's channel layout, read it as the preview plays it: mono on both sides at unity.
  args.push("-filter_complex", `${opts.chain};[aout]${MONO_OR_STEREO_TO_STEREO}[mout]`);
  args.push("-map", "[mout]", "-ss", String(opts.from), "-t", String(opts.span));
  args.push("-ac", "2", "-ar", String(LOUDNESS_RATE), "-f", "f32le", opts.outPath);
  await runFfmpeg(args, {
    op: opts.op,
    context: { span: opts.span },
    totalDurationSeconds: opts.from + opts.span,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
}

/** Read `frames` stereo frames starting at `startFrame` from a raw f32 stereo file; short reads are padded with silence. */
async function readFrames(fd: fs.FileHandle, startFrame: number, frames: number): Promise<Float32Array> {
  const out = new Float32Array(frames * 2);
  if (frames <= 0) return out;
  const buf = Buffer.alloc(frames * 8);
  const { bytesRead } = await fd.read(buf, 0, buf.length, startFrame * 8);
  const usable = Math.floor(bytesRead / 4);
  for (let i = 0; i < usable; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

async function levelsOfRanges(rawPath: string, coverFrom: number, ranges: readonly MeasureRange[]): Promise<Levels[]> {
  const fd = await fs.open(rawPath, "r");
  try {
    const out: Levels[] = [];
    for (const r of ranges) {
      const startFrame = Math.round((r.from - coverFrom) * LOUDNESS_RATE);
      const frames = Math.round((r.to - r.from) * LOUDNESS_RATE);
      const pre = Math.min(startFrame, Math.round(PRE_ROLL_SEC * LOUDNESS_RATE));
      const samples = await readFrames(fd, startFrame - pre, frames + pre);
      out.push(levels(analyzeLoudness(samples, { preRollSamples: pre * 2 })));
    }
    return out;
  } finally {
    await fd.close();
  }
}

const SILENT_LEVELS: Levels = { lufs: null, shortTermMaxLufs: null, rmsDb: SILENCE_DB, peakDb: SILENCE_DB, silent: true };

export async function measureAudio(opts: {
  audioClips: AudioClip[];
  files: FileRecord[];
  ranges: MeasureRange[];
  per?: "mix" | "clip";
  clipIds?: string[];
  signal?: AbortSignal;
  /** Called with 0..1 across every render of the call. */
  onProgress?: (ratio: number) => void;
}): Promise<MeasureResult> {
  const bad = checkRanges(opts.ranges);
  if (bad) throw new Error(bad);
  const ranges = opts.ranges.map((r) => ({ from: r.from, to: r.to }));
  const coverFrom = Math.min(...ranges.map((r) => r.from));
  const coverTo = Math.max(...ranges.map((r) => r.to));
  const span = coverTo - coverFrom;

  const dir = await fs.mkdtemp(join(os.tmpdir(), "libi-measure-"));
  try {
    const mix = await prepareAudioMix({
      leadingInputs: [],
      audioClips: opts.audioClips,
      files: opts.files,
      outDir: dir,
      durationSeconds: coverTo,
      signal: opts.signal,
      op: "audio_measure_mix",
    });
    if (!mix) {
      return {
        ranges: ranges.map((r) => ({ ...r, ...SILENT_LEVELS })),
        note: "Nothing is in the mix: no enabled audio clip with a readable source and an audio stream.",
      };
    }
    const chain = mix.chainFor();
    if (!chain) {
      return { ranges: ranges.map((r) => ({ ...r, ...SILENT_LEVELS })), note: "Nothing is in the mix." };
    }

    // Which clips are measured one by one: those that sound inside some range.
    const perClip = opts.per === "clip";
    const overlapping = mix.usable.filter((c) => ranges.some((r) => c.startTime < r.to && c.startTime + c.duration > r.from));
    const wanted = opts.clipIds ? overlapping.filter((c) => opts.clipIds!.includes(c.id)) : overlapping;
    const clipsNotMeasured: Array<{ clipId: string; why: string }> = [];
    for (const id of opts.clipIds ?? []) {
      if (wanted.some((c) => c.id === id)) continue;
      clipsNotMeasured.push({
        clipId: id,
        why: mix.usable.some((c) => c.id === id) ? "does not sound inside any of the ranges" : "not in the mix (unknown id, disabled, hidden, or its file has no audio)",
      });
    }
    const measured = perClip ? wanted.slice(0, MEASURE_MAX_CLIPS) : [];
    for (const c of wanted.slice(MEASURE_MAX_CLIPS)) {
      if (perClip) clipsNotMeasured.push({ clipId: c.id, why: `over the ${MEASURE_MAX_CLIPS}-clip cap: pass clipIds for the ones you want` });
    }

    const renders = 1 + measured.length;
    let done = 0;
    const tick = (ratio: number) => opts.onProgress?.((done + ratio) / renders);

    const mixPath = join(dir, "mix.f32");
    await renderRaw({ inputPaths: mix.inputPaths, inputOptions: mix.inputOptions, chain, from: coverFrom, span, outPath: mixPath, op: "audio_measure_mix", signal: opts.signal, onProgress: tick });
    done++;
    const mixLevels = await levelsOfRanges(mixPath, coverFrom, ranges);
    const result: RangeMeasure[] = ranges.map((r, i) => ({ ...r, ...mixLevels[i] }));

    for (const clip of measured) {
      const solo = mix.chainFor([clip]);
      if (!solo) continue;
      const clipPath = join(dir, `clip-${clip.id}.f32`);
      await renderRaw({ inputPaths: mix.inputPaths, inputOptions: mix.inputOptions, chain: solo, from: coverFrom, span, outPath: clipPath, op: "audio_measure_clip", signal: opts.signal, onProgress: tick });
      done++;
      const clipLevels = await levelsOfRanges(clipPath, coverFrom, ranges);
      ranges.forEach((r, i) => {
        // A clip that does not sound inside this range has nothing to report there.
        if (!(clip.startTime < r.to && clip.startTime + clip.duration > r.from)) return;
        (result[i].clips ??= []).push({ clipId: clip.id, ...(clip.label ? { label: clip.label } : {}), ...clipLevels[i] });
      });
      await fs.rm(clipPath, { force: true });
    }
    opts.onProgress?.(1);

    const note = result.every((r) => r.silent) ? "Every range measures silent: nothing in the mix sounds there (check the clips' times, enabled flags, gain and duck)." : undefined;
    logger.info({ tag: "export", op: "audio_measure", ranges: ranges.length, clips: measured.length, spanSec: Math.round(span) }, "measured the mix through the export path");
    return {
      ranges: result,
      ...(clipsNotMeasured.length ? { clipsNotMeasured } : {}),
      ...(note ? { note } : {}),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
