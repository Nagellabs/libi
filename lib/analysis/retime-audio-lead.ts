import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { analysisAudioChunks, analysisSteps, files } from "@/lib/db/schema/sqlite";
import { serverLogger as logger } from "@/lib/logger";
import { getLibiHome, getLibiStorageDir } from "@/lib/libi-home";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { getAudioChunksDir, getAudioPath } from "@/lib/analysis/storage";

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
 *   and is made again when next asked for;
 * - either way the old `audio.wav` and chunk files go: they are re-extracted,
 *   on the file's timeline, when next needed.
 *
 * A transcript already stamped (aggregated since the fix, or re-timed by an
 * earlier run cut short) is left alone, so a re-run never moves it twice. The
 * marker under LIBI_HOME/state stops the sweep once it has run to the end.
 *
 * **Next.js process only.**
 */
export const AUDIO_LEAD_RETIME_MARKER = "analysis-retime-audio-lead-v1";

/** The stamp a transcript on the file's timeline carries in its metadata. */
export const TRANSCRIPT_AUDIO_TIMELINE = "file";

const LEAD_EPS = 0.0005;

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

/** Remove the file's extracted audio (audio.wav and its chunks): re-made on demand. */
function dropExtractedAudio(pieceId: string | null, fileId: string): void {
  fs.rmSync(getAudioPath(pieceId, fileId), { force: true });
  fs.rmSync(getAudioChunksDir(pieceId, fileId), { recursive: true, force: true });
}

export async function sweepRetimeAudioLeadTranscripts(): Promise<{ retimed: number; removed: number }> {
  const marker = path.join(getLibiHome(), "state", AUDIO_LEAD_RETIME_MARKER);
  if (fs.existsSync(marker)) return { retimed: 0, removed: 0 };
  const db = getDb();

  // Every file with a transcript (or its chunks), and every file with an
  // extracted audio.wav.
  const ids = new Set<string>();
  for (const r of db.select({ fileId: analysisSteps.fileId }).from(analysisSteps).where(eq(analysisSteps.kind, "transcript")).all()) ids.add(r.fileId);
  for (const r of db.select({ fileId: analysisAudioChunks.fileId }).from(analysisAudioChunks).all()) ids.add(r.fileId);
  for (const r of db.select({ fileId: analysisSteps.fileId }).from(analysisSteps).all()) ids.add(r.fileId);

  let retimed = 0;
  let removed = 0;
  for (const fileId of ids) {
    const [file] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
    if (!file) continue;
    const [step] = db
      .select()
      .from(analysisSteps)
      .where(and(eq(analysisSteps.fileId, fileId), eq(analysisSteps.kind, "transcript")))
      .limit(1)
      .all();
    const stepMeta = parse(step?.metadata ?? null);
    if (stepMeta?.audioTimeline === TRANSCRIPT_AUDIO_TIMELINE) continue; // made (or re-timed) on the file's timeline
    const hasAudioWav = fs.existsSync(getAudioPath(file.pieceId, fileId));
    if (!step && !hasAudioWav) continue;

    const probed = await probeMedia(path.join(getLibiStorageDir(), file.pieceId ?? "_global", file.filename));
    const unrepairable = !!probed.audioRead?.inputArgs.length;
    const lead = probed.audioLead ?? 0;
    if (!unrepairable && !(lead > LEAD_EPS)) continue; // this file's extract never changed

    if (unrepairable) {
      if (step) {
        db.delete(analysisSteps).where(eq(analysisSteps.id, step.id)).run(); // its chunks cascade
        removed++;
      }
      dropExtractedAudio(file.pieceId, fileId);
      logger.info({ tag: "analysis", op: "transcript_retime_removed", fileId }, "analysis.transcript_retime.removed");
      continue;
    }

    if (step) {
      const chunks = db.select().from(analysisAudioChunks).where(eq(analysisAudioChunks.fileId, fileId)).all();
      db.transaction((tx) => {
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
        const meta = { ...(stepMeta ?? {}), audioTimeline: TRANSCRIPT_AUDIO_TIMELINE };
        if ("words" in meta) meta.words = shiftWords(meta.words, lead);
        tx.update(analysisSteps).set({ metadata: JSON.stringify(meta), updatedAt: new Date() }).where(eq(analysisSteps.id, step.id)).run();
      });
      retimed++;
      logger.info({ tag: "analysis", op: "transcript_retimed", fileId, lead }, "analysis.transcript_retimed");
    }
    dropExtractedAudio(file.pieceId, fileId);
  }

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()} retimed=${retimed} removed=${removed}\n`);
  return { retimed, removed };
}
