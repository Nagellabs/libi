import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { writeTrack, deleteTrack as deleteTrackFile } from "@/lib/tracking/storage";
import { insertTrackRow, deleteTrackRow, getTrackRow } from "@/lib/tracking/repo";
import { serverLogger as logger } from "@/lib/logger";
import type { Anchor, TrackMethod, TrackSample } from "@/lib/tracking/types";
import { sanitizeSamples } from "@/lib/tracking/honest-output";
import { summarizeTrack, type TrackSummary } from "@/lib/tracking/summary";
import { normalizeTrack } from "@/lib/tracking/segments";

export function newTrackId(): string {
  return `trk-${randomUUID().split("-")[0]}`;
}

export interface SaveTrackSamplesParams {
  trackId: string;
  fileId: string;
  /**
   * External callers go through UpdateTrackResultSchema which enforces .min(1);
   * this internal helper is permissive so programmatic callers (tests, future
   * internal flows) can pass empty arrays without an extra check.
   */
  samples: TrackSample[];
  framerate: number;
  method: TrackMethod;
  subjectId?: string;
  label?: string;
  anchors?: Anchor[];
}

export interface SaveTrackSamplesResult {
  trackId: string;
  sampleCount: number;
  durationSec: number;
  pieceId: string;
  /** True when a prior row with this trackId existed and was replaced. */
  replaced: boolean;
  /** Summary of the written track (computed from sanitized samples). */
  summary: TrackSummary;
}

export async function saveTrackSamples(params: SaveTrackSamplesParams): Promise<SaveTrackSamplesResult> {
  const db = getDb();
  const fileRows = await db.select().from(files).where(eq(files.id, params.fileId)).limit(1);
  const file = fileRows[0];
  if (!file) throw new Error(`file not found: ${params.fileId}`);
  if (!file.pieceId) throw new Error("file must be assigned to a piece");

  const { trackId, fileId, samples, framerate, method, subjectId, label, anchors } = params;

  const frameW = (file as { mediaWidth?: number }).mediaWidth ?? 0;
  const frameH = (file as { mediaHeight?: number }).mediaHeight ?? 0;
  const clipDurationSec = (file as { mediaDuration?: number }).mediaDuration ?? Number.POSITIVE_INFINITY;
  const cleanSamples =
    frameW > 0 && frameH > 0
      ? sanitizeSamples(samples, { frameW, frameH, clipDurationSec })
      : samples;

  const durationSec = cleanSamples.length > 0 ? cleanSamples[cleanSamples.length - 1].t : 0;

  // Replace semantics: if the trackId already exists, delete the prior record
  // before inserting the new one (both the storage JSON and the DB row).
  const existing = await getTrackRow(db, trackId);
  const replaced = existing !== null;
  let replacedFile: string | undefined;

  if (existing) {
    // Cross-piece replace: the existing track's file may live on a different
    // piece than the new fileId. Resolve the old pieceId from the files table
    // so we can clean up the orphaned JSON sidecar before overwriting.
    let existingPieceId: string | null;
    if (existing.fileId !== fileId) {
      const oldFileRows = await db
        .select()
        .from(files)
        .where(eq(files.id, existing.fileId))
        .limit(1);
      existingPieceId = oldFileRows[0]?.pieceId ?? null;
      if (!existingPieceId) {
        logger.warn(
          { tag: "tracking-save", op: "save_track.orphan_warn", trackId, oldFileId: existing.fileId },
          "Could not resolve old pieceId for cross-piece replace; old JSON sidecar may be orphaned",
        );
      }
      replacedFile = existing.fileId;
    } else {
      existingPieceId = file.pieceId;
    }

    await deleteTrackRow(db, trackId);
    if (existingPieceId) {
      await deleteTrackFile(existingPieceId, trackId);
    }
  }

  await writeTrack(file.pieceId, {
    id: trackId,
    fileId,
    subjectId,
    label,
    method,
    framerate,
    durationSec,
    samples: cleanSamples,
    anchors,
  });

  await insertTrackRow(db, {
    id: trackId,
    fileId,
    subjectId,
    label,
    method,
    framerate,
    durationSec,
    sampleCount: cleanSamples.length,
  });

  // Summarize against the original (pre-sanitization) samples so that flags
  // like "full_canvas_while_visible" and "samples_exceed_clip_duration" are
  // faithfully reported back to the caller even though those samples were
  // dropped or corrected before persistence.
  const originalNormalized = normalizeTrack({
    id: trackId,
    fileId,
    subjectId,
    label,
    method,
    framerate,
    durationSec: samples.length > 0 ? samples[samples.length - 1].t : 0,
    samples,
    anchors,
  });
  const summary = summarizeTrack(originalNormalized, {
    frameW: frameW || 1,
    frameH: frameH || 1,
    clipDurationSec,
  });

  logger.info(
    { tag: "tracking-save", op: "save_track.done", trackId, fileId, pieceId: file.pieceId, method, sampleCount: cleanSamples.length, replaced, ...(replacedFile ? { replacedFile } : {}) },
    "Track samples saved",
  );

  return { trackId, sampleCount: cleanSamples.length, durationSec, pieceId: file.pieceId, replaced, summary };
}
