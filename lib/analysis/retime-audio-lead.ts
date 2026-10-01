import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { analysisAudioChunks, analysisSteps, files } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiHome, getLibiStorageDir } from "@/lib/libi-home";
import { probeMediaResult, type ProbeFailure } from "@/lib/ffmpeg/probe";
import { recordRemovedTranscript } from "@/lib/analysis/removed-transcripts";
import { getAudioChunksDir, getAudioPath, getAudioTimelinePath, isAudioExtractCurrent } from "@/lib/analysis/storage";

/**
 * One-time boot migration: transcripts made before `d0e0594c` for a file whose
 * audio starts after the file does are moved onto the file's timeline.
 *
 * The transcription extract (`audio.wav`) used to start at the audio's first
 * sample, so every chunk and word time of such a file was early by the audio's
 * lead: 0.4 s on a recording whose microphone started late, 0.343 s on a
 * Chrome recording. `extractAudio` now pads the lead (review round 3); this
 * re-times what was made before (review round 4, M-f), per file:
 * - a constant lead (`audioLead`): every chunk's start and end, every word of
 *   the chunks and of the aggregated transcript move by it, in one
 *   transaction that also stamps the transcript `audioTimeline: "file"`;
 * - a file ffmpeg read off its timeline in a way no shift repairs (a
 *   FLAC-in-MP4 cut, whose old decode repeated and skipped frames): the
 *   transcript is removed through `analysis_steps` (its chunks go with it),
 *   and is made again when next asked for. The removal is logged at warn with
 *   the file's name, and the editor tells the user once, on the piece's next
 *   open (removed-transcripts.ts; review round 5, M7);
 * - either way the old `audio.wav` and chunk files go: they are re-extracted,
 *   on the file's timeline, when next needed.
 *
 * A transcript already stamped (aggregated since the fix, or re-timed by an
 * earlier run cut short) is left alone, so a re-run never moves it twice. The
 * marker under LIBI_HOME/state stops the sweep once it has run to the end.
 *
 * **v2 (review round 5, M1).** An `audio.wav` is stale unless its timeline
 * sidecar says otherwise (`isAudioExtractCurrent`): every one without it is
 * dropped first, whatever its transcript's stamp, so no later transcription
 * reuses a pre-fix extract. v1 (0.1.16) skipped a stamped transcript before
 * dropping its extract, so a transcription made from a stale `audio.wav`
 * between boot and v1's turn was stamped "file" while early, and its extract
 * stayed. Such a transcript can't be told from a good one by the rows alone,
 * so where v1's marker shows it already ran, v2 drops the stale extracts and
 * leaves every transcript as it is: it never moves a transcript twice.
 *
 * **Next.js process only.** Runs first in Category B's background sweeps: it
 * waits on no job.
 */
export const AUDIO_LEAD_RETIME_MARKER = "analysis-retime-audio-lead-v2";

/** 0.1.16's run of this sweep: its transcripts are re-timed already. */
export const AUDIO_LEAD_RETIME_MARKER_V1 = "analysis-retime-audio-lead-v1";

/** The stamp a transcript on the file's timeline carries in its metadata. */
export const TRANSCRIPT_AUDIO_TIMELINE = "file";

const LEAD_EPS = 0.0005;

/**
 * Files whose probe failed (review round 5, M2), by id: how many boots it
 * failed on, and whether the sweep gave up on it. A failed probe used to read
 * as "no lead", and the marker then stopped the sweep for good; now the file
 * is unresolved and the marker waits for it, until it has failed on
 * `RETIME_PROBE_ATTEMPTS` boots: then it is listed here as given up, so a file
 * that can never be read can't keep the sweep running every boot.
 */
export const RETIME_UNRESOLVED_FILE = "retime-unresolved.json";
const RETIME_PROBE_ATTEMPTS = 3;

/**
 * The steps the FIRST full run found unstamped (review I1), with when it ran:
 * `{ recordedAt: ms, steps: { stepId: fileId } }`. Under this version an
 * unstamped step is not proof of a pre-fix transcript (the fixed code stamps
 * at creation, but a retry across boots must not rest on that alone), so a
 * later boot's retry (M2) only ever looks at these, and leaves any whose row
 * changed since: a step worked on between boots is on the file's timeline.
 * Removed with the marker.
 */
export const RETIME_CANDIDATES_FILE = "retime-candidates.json";

interface Candidates {
  recordedAt: number;
  steps: Record<string, string>;
}

function readCandidates(file: string): Candidates | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Candidates>;
    if (typeof v?.recordedAt !== "number" || !v.steps || typeof v.steps !== "object") return null;
    return { recordedAt: v.recordedAt, steps: v.steps as Record<string, string> };
  } catch {
    return null;
  }
}

type Unresolved = Record<string, { attempts: number; failure: ProbeFailure; gaveUp?: true }>;

function readUnresolved(file: string): Unresolved {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Unresolved) : {};
  } catch {
    return {};
  }
}

type Word = { start?: unknown; end?: unknown } & Record<string, unknown>;

function shiftWords(words: unknown, by: number): unknown {
  if (!Array.isArray(words)) return words;
  return words.map((w: Word) =>
    w && typeof w === "object"
      ? {
          ...w,
          ...(typeof w.start === "number" ? { start: +(w.start + by).toFixed(6) } : {}),
          ...(typeof w.end === "number" ? { end: +(w.end + by).toFixed(6) } : {}),
        }
      : w,
  );
}

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Remove the file's extracted audio (audio.wav, its sidecar and its chunks): re-made on demand. */
function dropExtractedAudio(pieceId: string | null, fileId: string): void {
  fs.rmSync(getAudioPath(pieceId, fileId), { force: true });
  fs.rmSync(getAudioTimelinePath(pieceId, fileId), { force: true });
  fs.rmSync(getAudioChunksDir(pieceId, fileId), { recursive: true, force: true });
}

/**
 * Drop every `audio.wav` without its timeline sidecar (and the chunk files cut
 * from it). One written since this server started is being written by this
 * version's `extractAudio`, which adds the sidecar when it finishes: left be.
 */
function dropStaleAudioExtracts(db: ReturnType<typeof getDb>): number {
  const startedAt = Date.now() - process.uptime() * 1000;
  let dropped = 0;
  for (const f of db.select({ id: files.id, pieceId: files.pieceId }).from(files).all()) {
    const wav = getAudioPath(f.pieceId, f.id);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(wav).mtimeMs;
    } catch {
      continue; // none
    }
    if (isAudioExtractCurrent(f.pieceId, f.id) || mtimeMs >= startedAt) continue;
    dropExtractedAudio(f.pieceId, f.id);
    dropped++;
  }
  if (dropped > 0) logger.info({ tag: "analysis", op: "stale_audio_extracts_dropped", count: dropped }, "analysis.stale_audio_extracts_dropped");
  return dropped;
}

export interface RetimeSweepResult {
  /** "full": transcripts re-timed; "extracts-only": v1 had re-timed them, only stale extracts went. */
  mode: "full" | "extracts-only" | "done";
  retimed: number;
  removed: number;
  droppedExtracts: number;
  /** Files whose probe failed this run and will be tried again (no marker while any). */
  unresolved: number;
  /** Files given up on after `RETIME_PROBE_ATTEMPTS` failing boots (listed in `RETIME_UNRESOLVED_FILE`). */
  gaveUp: number;
  /** Files left as they are: several audio tracks that start at different times (M3). */
  multitrack: number;
}

export async function sweepRetimeAudioLeadTranscripts(): Promise<RetimeSweepResult> {
  const stateDir = path.join(getLibiHome(), "state");
  const marker = path.join(stateDir, AUDIO_LEAD_RETIME_MARKER);
  if (fs.existsSync(marker)) return { mode: "done", retimed: 0, removed: 0, droppedExtracts: 0, unresolved: 0, gaveUp: 0, multitrack: 0 };
  const db = getDb();

  const droppedExtracts = dropStaleAudioExtracts(db);

  if (fs.existsSync(path.join(stateDir, AUDIO_LEAD_RETIME_MARKER_V1))) {
    fs.writeFileSync(marker, `${new Date().toISOString()} mode=extracts-only droppedExtracts=${droppedExtracts}\n`);
    logger.info({ tag: "analysis", op: "transcript_retime_extracts_only", droppedExtracts }, "analysis.transcript_retime.extracts_only");
    return { mode: "extracts-only", retimed: 0, removed: 0, droppedExtracts, unresolved: 0, gaveUp: 0, multitrack: 0 };
  }

  // The transcripts to look at: on the first full run, every unstamped one,
  // recorded before anything moves; on a later run (a retry, M2), only those
  // recorded ones whose row hasn't changed since (review I1).
  fs.mkdirSync(stateDir, { recursive: true });
  const candidatesPath = path.join(stateDir, RETIME_CANDIDATES_FILE);
  const recorded = readCandidates(candidatesPath);
  const firstRun = recorded === null;
  const candidates: Candidates = recorded ?? { recordedAt: Date.now(), steps: {} };
  if (firstRun) {
    for (const r of db.select().from(analysisSteps).where(eq(analysisSteps.kind, "transcript")).all()) {
      if (parse(r.metadata ?? null)?.audioTimeline !== TRANSCRIPT_AUDIO_TIMELINE) candidates.steps[r.id] = r.fileId;
    }
    const tmpPath = `${candidatesPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(candidates)}\n`);
    fs.renameSync(tmpPath, candidatesPath);
  }
  // A row stored at or after the first run's second changed since (updatedAt keeps whole seconds).
  const touchedFrom = Math.floor(candidates.recordedAt / 1000) * 1000;
  let touched = 0;

  let retimed = 0;
  let removed = 0;
  let unresolved = 0;
  let multitrack = 0;
  const unresolvedPath = path.join(stateDir, RETIME_UNRESOLVED_FILE);
  const failed = readUnresolved(unresolvedPath);
  for (const [stepId, fileId] of Object.entries(candidates.steps)) {
    const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
    if (!file) {
      delete failed[fileId]; // deleted since: its unresolved entry goes with it
      continue;
    }
    const [step] = db
      .select()
      .from(analysisSteps)
      .where(and(eq(analysisSteps.id, stepId), eq(analysisSteps.kind, "transcript")))
      .limit(1)
      .all();
    if (!step) continue; // removed since
    const stepMeta = parse(step.metadata ?? null);
    if (stepMeta?.audioTimeline === TRANSCRIPT_AUDIO_TIMELINE) continue; // made (or re-timed) on the file's timeline
    if (!firstRun && step.updatedAt.getTime() >= touchedFrom) {
      // Worked on between boots (a retry, a re-save): whatever it holds now
      // was made by this version, on the file's timeline. Never shifted.
      delete failed[fileId];
      touched++;
      logger.info({ tag: "analysis", op: "transcript_retime_touched_skipped", fileId }, "analysis.transcript_retime.touched_skipped");
      continue;
    }

    const result = await probeMediaResult(path.join(getLibiStorageDir(), file.pieceId ?? "_global", file.filename));
    if (!result.ok) {
      const attempts = (failed[fileId]?.attempts ?? 0) + 1;
      const gaveUp = attempts >= RETIME_PROBE_ATTEMPTS;
      failed[fileId] = { attempts, failure: result.failure, ...(gaveUp ? { gaveUp: true as const } : {}) };
      if (!gaveUp) unresolved++;
      logger.warn(
        { tag: "analysis", op: "transcript_retime_probe_failed", fileId, failure: result.failure, attempts, gaveUp },
        gaveUp
          ? "analysis.transcript_retime.probe_failed: given up after repeated failures; its transcript is left as it is"
          : "analysis.transcript_retime.probe_failed: tried again on the next boot",
      );
      continue;
    }
    delete failed[fileId];
    const probed = result.media;
    // Several audio tracks that start at different times (review round 5,
    // M3): the old extract read ffmpeg's default pick (most channels), which
    // may not be the primary track the lead is measured on. The right shift
    // is unknown, so the transcript is left as it was, not moved or removed.
    const leads = probed.audioStreamLeads ?? [];
    if (leads.length > 1 && Math.max(...leads) - Math.min(...leads) > LEAD_EPS) {
      multitrack++;
      logger.warn(
        { tag: "analysis", op: "transcript_retime_multitrack_skipped", fileId, leads },
        "analysis.transcript_retime.multitrack_skipped: audio tracks start at different times; transcript left as it is",
      );
      continue;
    }
    const unrepairable = !!probed.audioRead?.inputArgs.length;
    const lead = probed.audioLead ?? 0;
    if (!unrepairable && !(lead > LEAD_EPS)) continue; // this file's extract never changed

    if (unrepairable) {
      // Recorded first: a quit between the two leaves a notice for a
      // transcript still there (the next boot removes it), never a removal
      // nobody is told about (review round 5, M7).
      recordRemovedTranscript(file.pieceId, { fileId, name: file.name || file.filename });
      db.delete(analysisSteps).where(eq(analysisSteps.id, step.id)).run(); // its chunks cascade
      removed++;
      dropExtractedAudio(file.pieceId, fileId);
      logger.warn(
        { tag: "analysis", op: "transcript_retime_removed", fileId, pieceId: file.pieceId, filename: file.filename, name: file.name },
        "analysis.transcript_retime.removed: its old decode was garbled; the user is told on the piece's next open, and it is made again when asked",
      );
      continue;
    }

    // The step is read again inside the transaction (review n5): another
    // studio on the same home (npx beside the desktop app) may have re-timed
    // it while this one probed, and a stamped step is never moved twice.
    const moved = db.transaction((tx) => {
      const [fresh] = tx.select().from(analysisSteps).where(eq(analysisSteps.id, step.id)).limit(1).all();
      if (!fresh) return false;
      const freshMeta = parse(fresh.metadata ?? null);
      if (freshMeta?.audioTimeline === TRANSCRIPT_AUDIO_TIMELINE) return false;
      const chunks = tx.select().from(analysisAudioChunks).where(eq(analysisAudioChunks.fileId, fileId)).all();
      for (const c of chunks) {
        const words = parse(`{"w":${c.words ?? "null"}}`)?.w;
        tx.update(analysisAudioChunks)
          .set({
            startSeconds: +(c.startSeconds + lead).toFixed(6),
            endSeconds: +(c.endSeconds + lead).toFixed(6),
            ...(Array.isArray(words) ? { words: JSON.stringify(shiftWords(words, lead)) } : {}),
          })
          .where(eq(analysisAudioChunks.id, c.id))
          .run();
      }
      const meta = { ...(freshMeta ?? {}), audioTimeline: TRANSCRIPT_AUDIO_TIMELINE };
      if ("words" in meta) meta.words = shiftWords(meta.words, lead);
      tx.update(analysisSteps).set({ metadata: JSON.stringify(meta), updatedAt: new Date() }).where(eq(analysisSteps.id, step.id)).run();
      return true;
    });
    if (!moved) {
      logger.info({ tag: "analysis", op: "transcript_retime_already_stamped", fileId }, "analysis.transcript_retime.already_stamped");
      continue;
    }
    retimed++;
    logger.info({ tag: "analysis", op: "transcript_retimed", fileId, lead }, "analysis.transcript_retimed");
    dropExtractedAudio(file.pieceId, fileId);
  }

  const gaveUp = Object.values(failed).filter((f) => f.gaveUp).length;
  if (Object.keys(failed).length > 0) fs.writeFileSync(unresolvedPath, `${JSON.stringify(failed, null, 2)}\n`);
  else fs.rmSync(unresolvedPath, { force: true });
  if (unresolved > 0) {
    // No marker: the next boot probes these again (and skips what is stamped).
    logger.info({ tag: "analysis", op: "transcript_retime_incomplete", retimed, removed, unresolved }, "analysis.transcript_retime.incomplete");
    return { mode: "full", retimed, removed, droppedExtracts, unresolved, gaveUp, multitrack };
  }
  fs.writeFileSync(marker, `${new Date().toISOString()} mode=full retimed=${retimed} removed=${removed} droppedExtracts=${droppedExtracts} gaveUp=${gaveUp} multitrack=${multitrack} touched=${touched}\n`);
  fs.rmSync(candidatesPath, { force: true });
  return { mode: "full", retimed, removed, droppedExtracts, unresolved, gaveUp, multitrack };
}
