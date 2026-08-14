import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getTrackRow, insertTrackRow, deleteTrackRow } from "@/lib/tracking/repo";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import {
  deriveSamples,
  resolveSegmentOverlaps,
  type TrackSegment,
} from "@/lib/tracking/segments";

/**
 * Creates an empty segmented track (DB row + JSON sidecar) so subsequent
 * `upsertSegment` calls have a parent to append into. Idempotent: a no-op when
 * the track already exists. Used by the shot fan-out to seed a track before
 * computing one segment per shot.
 */
export async function initSegmentedTrack(params: {
  trackId: string;
  fileId: string;
  framerate: number;
  method: import("@/lib/tracking/types").TrackMethod;
  subjectId?: string;
  label?: string;
  anchors?: import("@/lib/tracking/types").Anchor[];
}): Promise<void> {
  const db = getDb();
  const existing = await getTrackRow(db, params.trackId);
  if (existing) return;

  const fileRows = await db
    .select()
    .from(files)
    .where(eq(files.id, params.fileId))
    .limit(1);
  const pieceId = fileRows[0]?.pieceId;
  if (!pieceId) throw new Error("file must be assigned to a piece");

  await writeTrack(pieceId, {
    id: params.trackId,
    fileId: params.fileId,
    subjectId: params.subjectId,
    label: params.label,
    method: params.method,
    framerate: params.framerate,
    durationSec: 0,
    samples: [],
    segments: [],
    anchors: params.anchors,
  });
  await insertTrackRow(db, {
    id: params.trackId,
    fileId: params.fileId,
    subjectId: params.subjectId,
    label: params.label,
    method: params.method,
    framerate: params.framerate,
    durationSec: 0,
    sampleCount: 0,
  });
}

/**
 * Atomically upserts a single segment into a track's segmented JSON sidecar.
 *
 * - If a segment with the same `id` already exists it is replaced in-place.
 * - Sibling segments are left untouched.
 * - After mutating segments, `deriveSamples` restitches the aggregate
 *   `samples` array and the DB row's `sampleCount` / `durationSec` are
 *   updated to stay consistent.
 */
export async function upsertSegment(
  trackId: string,
  seg: TrackSegment,
): Promise<void> {
  const db = getDb();

  const row = await getTrackRow(db, trackId);
  if (!row) throw new Error(`track not found: ${trackId}`);

  const fileRows = await db
    .select()
    .from(files)
    .where(eq(files.id, row.fileId))
    .limit(1);
  const pieceId = fileRows[0]?.pieceId;
  if (!pieceId) throw new Error("track file has no piece");

  const track = await readTrack(pieceId, trackId);
  if (!track) throw new Error(`track sidecar missing: ${trackId}`);

  // Replace-or-append: drop any existing segment with this id, then resolve
  // range overlaps — a recompute whose range is not byte-identical mints a
  // DIFFERENT id (`seg-<startMs>-<endMs>`), so id-replacement alone left the
  // superseded segment in the table (task-39: sot [0,19.021] appended next
  // to the failed engine [0,18.933] instead of replacing it). Equal-or-
  // lower-precedence siblings lose the window `seg` covers (drop or trim);
  // higher-precedence and containing siblings are untouched.
  const siblings = resolveSegmentOverlaps(
    (track.segments ?? []).filter((s) => s.id !== seg.id),
    seg,
  );
  const segments = [...siblings, seg].sort((a, b) => a.startTime - b.startTime);

  const derived = deriveSamples({ ...track, segments });
  // Keep the sidecar's durationSec consistent with the derived samples.
  // (Previously only the DB row was updated, so the sidecar stayed at the
  // 0 that initSegmentedTrack writes — corrupting reanchorWindow's
  // degenerate fallback, panel times, and timeline markers.)
  const durationSec = derived.length > 0 ? derived[derived.length - 1].t : 0;
  const next = { ...track, segments, samples: derived, durationSec };

  await writeTrack(pieceId, next);

  // Refresh the DB row's aggregate counts — delete + re-insert is simplest
  // (avoids an UPDATE path while the schema has no update helper).
  await deleteTrackRow(db, trackId);
  await insertTrackRow(db, {
    id: trackId,
    fileId: row.fileId,
    subjectId: row.subjectId ?? undefined,
    label: row.label ?? undefined,
    method: row.method,
    framerate: row.framerate,
    durationSec,
    sampleCount: derived.length,
  });
}
