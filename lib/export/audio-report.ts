/**
 * Why does a clip sound the way it does over a range? `libi.audio_analyze` report: per clip, the
 * effective gain curve (volume x gainDb x envelope x fades x crossfade x duck) as compact numbers,
 * and the spans where it is nearly silent with the factor that caused them.
 *
 * "Why is the music silent at 74 s?" took the agent 52 calls and a wrong conclusion
 * (docs-local/research/2026-10-03-dreams-session-analysis.md P8). Every term here comes from the
 * law the preview and the export share (`lib/audio/clip-gain.ts`), and the duck is NOT estimated: it
 * is the gain track the export would multiply in, rendered by `prepareAudioMix` from the sidechain
 * clips' actual levels (a duck depends on how loud the narration is, so no formula would do).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { AudioClip } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";
import type { CompositionManifest } from "@/lib/composition/persistence";
import { manifestAsExported } from "@/lib/overlays/hidden";
import { audioGainAt } from "@/lib/effects/audio-envelope";
import { duckSidechainIds } from "@/lib/audio/duck-params";
import { crossfadePlan, dbToGain, envelopeDbAt, hasEnvelope, shapeGainAt, staticGain } from "@/lib/audio/clip-gain";
import { ENVELOPE_SAMPLE_RATE } from "@/lib/export/duck-envelopes";
import { prepareAudioMix } from "@/lib/export/render-audio-mux";
import { SILENCE_DB } from "@/lib/audio/loudness";

/** Most seconds one report covers. */
export const REPORT_MAX_SPAN_SEC = 600;
/** Printed points per clip, at most: the step widens to fit. */
const MAX_POINTS = 120;
/** The grid silent spans are found on (finer than the printed one). */
const SCAN_STEP = 0.1;
/** A clip at or under this (dB, total) is "nearly silent" for the `quiet` spans. */
export const QUIET_DB = -40;
/** A factor at or under this is named as a cause of a quiet span. */
const CAUSE_DB = -20;

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const dbOf = (gain: number): number => (gain > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(gain)) : SILENCE_DB);

export interface QuietSpan {
  from: number;
  to: number;
  /** The lowest effective level inside the span, dB (relative to the file at unity). */
  minDb: number;
  /** The factors that are far down at the lowest point, in words. */
  causes: string[];
}

export interface ClipReport {
  clipId: string;
  label?: string;
  fileId: string;
  /** The clip's window on the timeline, seconds. */
  start: number;
  end: number;
  /** Fixed parts of the level. */
  level: { volume: number; gainDb?: number; staticDb: number; envelopeKeys?: number; crossfadeMs?: number; fadeInMs?: number; fadeOutMs?: number };
  /** Sample times (seconds), and per time: the level before the duck, the duck, and the result, in dB. 0 = the file at unity, -90 = silence. */
  t: number[];
  gainDb: number[];
  duckDb?: number[];
  outDb: number[];
  /** Lowest and highest result over the range. */
  minDb: number;
  maxDb: number;
  /** Spans in the range where the clip is nearly silent (<= QUIET_DB), with why. */
  quiet?: QuietSpan[];
  duck?: { sidechains: string[]; missing?: string[]; status: string };
}

export interface SilentClip {
  clipId: string;
  label?: string;
  start: number;
  end: number;
  because: string;
}

export interface ReportResult {
  from: number;
  to: number;
  step: number;
  clips: ClipReport[];
  /** Clips that would sound in the range but do not, and why. */
  silentClips?: SilentClip[];
  note?: string;
}

/** Duck gain samples (linear) of [from, to) from the WAV `prepareAudioMix` wrote, at ENVELOPE_SAMPLE_RATE. */
async function readDuckSlice(path: string, from: number, to: number): Promise<Float32Array> {
  const frames = Math.max(0, Math.round((to - from) * ENVELOPE_SAMPLE_RATE));
  const out = new Float32Array(frames).fill(1);
  const fd = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(frames * 4);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 44 + Math.round(from * ENVELOPE_SAMPLE_RATE) * 4);
    for (let i = 0; i < Math.floor(bytesRead / 4); i++) out[i] = buf.readFloatLE(i * 4);
  } finally {
    await fd.close();
  }
  return out;
}

const overlaps = (c: AudioClip, from: number, to: number): boolean => c.startTime < to && c.startTime + c.duration > from;

export async function reportClipGain(opts: {
  manifest: Pick<CompositionManifest, "overlays" | "audioClips">;
  files: FileRecord[];
  from: number;
  to: number;
  step?: number;
}): Promise<ReportResult> {
  const { from, to } = opts;
  if (!(Number.isFinite(from) && Number.isFinite(to)) || from < 0 || to <= from) throw new Error(`range ${from}–${to} is not valid: from must be at least 0 and less than to.`);
  if (to - from > REPORT_MAX_SPAN_SEC) throw new Error(`at most ${REPORT_MAX_SPAN_SEC} s per report; narrow from/to.`);
  const asked = opts.step ?? Math.min(5, Math.max(0.25, (to - from) / 24));
  const step = Math.max(asked, (to - from) / MAX_POINTS, 0.05);

  const all = (opts.manifest.audioClips ?? []) as AudioClip[];
  const exported = (manifestAsExported(opts.manifest as CompositionManifest).audioClips ?? []) as AudioClip[];
  const exportedIds = new Set(exported.map((c) => c.id));
  const fileById = new Map(opts.files.map((f) => [f.id, f]));
  const silentClips: SilentClip[] = [];
  const meta = (c: AudioClip) => ({ clipId: c.id, ...(c.label ? { label: c.label } : {}), start: r2(c.startTime), end: r2(c.startTime + c.duration) });

  for (const c of all) {
    if (!overlaps(c, from, to)) continue;
    if (!exportedIds.has(c.id)) silentClips.push({ ...meta(c), because: "its video layer is hidden (the eye toggle), so its sound is out of the preview and the export" });
    else if (!c.enabled) silentClips.push({ ...meta(c), because: "the clip is disabled (speaker toggle off)" });
  }

  const live = exported.filter((c) => c.enabled);
  const dir = await fs.mkdtemp(join(os.tmpdir(), "libi-report-"));
  try {
    const mix = await prepareAudioMix({ leadingInputs: [], audioClips: live, files: opts.files, outDir: dir, durationSeconds: to, op: "audio_report_mix" });
    const inMix = new Set(mix?.usable.map((c) => c.id) ?? []);
    const plan = crossfadePlan(live);
    const clips: ClipReport[] = [];

    for (const c of live) {
      if (!overlaps(c, from, to)) continue;
      if (!inMix.has(c.id)) {
        const f = fileById.get(c.fileId);
        silentClips.push({ ...meta(c), because: !f ? "its source file is missing" : "its file has no audio stream" });
        continue;
      }
      const lo = Math.max(from, c.startTime);
      const hi = Math.min(to, c.startTime + c.duration);
      const sc = staticGain(c);
      const trackPath = mix?.duckTracks.get(c.id);
      const duckSlice = trackPath ? await readDuckSlice(trackPath, from, to) : undefined;
      const duckAt = (t: number): number => {
        if (!duckSlice) return 1;
        const i = Math.min(duckSlice.length - 1, Math.max(0, Math.round((t - from) * ENVELOPE_SAMPLE_RATE)));
        return duckSlice[i] ?? 1;
      };
      const parts = (t: number) => {
        const env = hasEnvelope(c) ? dbToGain(envelopeDbAt(c, t - c.startTime)) : 1;
        const shape = shapeGainAt(c, plan, t);
        const fade = audioGainAt(c, t);
        const xfade = env > 0 ? shape / env : 1;
        const total = sc * shape * fade;
        return { env, xfade, fade, total, duck: duckAt(t) };
      };

      // The printed curve: the step grid inside the clip, plus its own edges.
      const times = new Set<number>([r2(lo), r2(hi)]);
      for (let t = Math.ceil(from / step) * step; t < hi; t += step) if (t >= lo) times.add(r2(t));
      const t = [...times].sort((a, b) => a - b);
      const printed = t.map((x) => parts(x));
      const gainDb = printed.map((p) => r1(dbOf(p.total)));
      const hasDuck = duckSlice !== undefined;
      const duckDb = hasDuck ? printed.map((p) => r1(dbOf(p.duck))) : undefined;
      const outDb = printed.map((p) => r1(dbOf(p.total * p.duck)));

      // Quiet spans on the finer grid: runs at or under QUIET_DB, each with the factors that are far down.
      const quiet: QuietSpan[] = [];
      let run: { from: number; to: number; min: number; at: number } | null = null;
      const flush = () => {
        if (!run) return;
        const p = parts(run.at);
        const causes: string[] = [];
        if (dbOf(sc) <= CAUSE_DB) causes.push(c.volume === 0 ? "volume is 0" : `volume x gainDb is ${r1(dbOf(sc))} dB`);
        if (hasEnvelope(c) && dbOf(p.env) <= CAUSE_DB) causes.push(`volume envelope ${r1(dbOf(p.env))} dB`);
        if (dbOf(p.xfade) <= CAUSE_DB) causes.push(`crossfade (silent after its window or before it starts) ${r1(dbOf(p.xfade))} dB`);
        if (dbOf(p.fade) <= CAUSE_DB) causes.push(`audio fade ${r1(dbOf(p.fade))} dB`);
        if (hasDuck && dbOf(p.duck) <= CAUSE_DB) causes.push(`duck ${r1(dbOf(p.duck))} dB`);
        if (causes.length === 0) {
          // No single factor is that low: say the heaviest ones together.
          const stack: Array<[string, number]> = [["volume x gainDb", dbOf(sc)], ["volume envelope", dbOf(p.env)], ["crossfade", dbOf(p.xfade)], ["audio fade", dbOf(p.fade)], ...(hasDuck ? [["duck", dbOf(p.duck)] as [string, number]] : [])];
          for (const [name, db] of stack) if (db <= -3) causes.push(`${name} ${r1(db)} dB`);
        }
        quiet.push({ from: r2(run.from), to: r2(run.to), minDb: r1(run.min), causes });
        run = null;
      };
      for (let x = lo; x <= hi + 1e-9; x += SCAN_STEP) {
        const p = parts(x);
        const out = dbOf(p.total * p.duck);
        if (out <= QUIET_DB) {
          if (!run) run = { from: x, to: x, min: out, at: x };
          run.to = x;
          if (out < run.min) { run.min = out; run.at = x; }
        } else flush();
      }
      flush();

      const d = c.duck;
      const sidechains = d ? duckSidechainIds(d) : [];
      const live2 = new Set(live.map((k) => k.id));
      const missing = sidechains.filter((id) => !inMix.has(id) || !live2.has(id));
      clips.push({
        clipId: c.id,
        ...(c.label ? { label: c.label } : {}),
        fileId: c.fileId,
        start: r2(c.startTime),
        end: r2(c.startTime + c.duration),
        level: {
          volume: c.volume,
          ...(c.gainDb ? { gainDb: c.gainDb } : {}),
          staticDb: r1(dbOf(sc)),
          ...(hasEnvelope(c) ? { envelopeKeys: c.volumeKeyframes!.keyframes.length } : {}),
          ...(c.crossfadeMs ? { crossfadeMs: c.crossfadeMs } : {}),
          ...(c.effects?.in?.effectId === "audio-fade-in" ? { fadeInMs: c.effects.in.durationMs ?? 600 } : {}),
          ...(c.effects?.out?.effectId === "audio-fade-out" ? { fadeOutMs: c.effects.out.durationMs ?? 600 } : {}),
        },
        t,
        gainDb,
        ...(duckDb ? { duckDb } : {}),
        outDb,
        minDb: Math.min(...outDb),
        maxDb: Math.max(...outDb),
        ...(quiet.length ? { quiet } : {}),
        ...(d
          ? {
              duck: {
                sidechains: sidechains.filter((id) => !missing.includes(id)),
                ...(missing.length ? { missing } : {}),
                status: hasDuck
                  ? "duckDb is the duck's gain from the sidechain clips' actual level (it moves with the narration), as the export applies it"
                  : "no sidechain clip is in the mix: plays UNDUCKED",
              },
            }
          : {}),
      });
    }
    return {
      from: r2(from),
      to: r2(to),
      step: r2(step),
      clips,
      ...(silentClips.length ? { silentClips } : {}),
      ...(clips.length === 0 && silentClips.length === 0 ? { note: "No audio clip sounds or is scheduled inside this range." } : {}),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
