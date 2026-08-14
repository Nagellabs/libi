import { getTrackRow } from "@/lib/tracking/repo";
import { readTrack } from "@/lib/tracking/storage";
import { upsertSegment, initSegmentedTrack } from "@/lib/tracking/segment-store";
import { summarizeTrack } from "@/lib/tracking/summary";
import type { TrackSample, TrackMethod, Track, Anchor } from "@/lib/tracking/types";

export interface ApplySegmentResultParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  file: {
    id: string;
    pieceId: string;
    mediaWidth?: number | null;
    mediaHeight?: number | null;
    mediaDuration?: number | null;
  };
  trackId: string;
  range: { start: number; end: number };
  method: TrackMethod;
  objectKind: "face" | "object";
  out: { samples: TrackSample[]; framerate: number };
  /** Segment authorship for stitch precedence. Defaults to "engine". */
  provenance?: "manual" | "agent" | "engine";
  subjectId?: string;
  label?: string;
  anchors?: Anchor[];
}

/** The "NEVER MAKE WORSE" gate for an ALL-LOST engine result: decide whether
 *  it should be persisted as an honest `lost` segment (true) or discarded to
 *  protect genuinely-good prior data (false).
 *
 *  Protection keys off whether a prior segment OVERLAPPING `range` has
 *  visible samples INSIDE the disputed range — NOT off track-row existence.
 *  Keying off existence silently dropped every all-lost shot after the first
 *  in the shot fan-out (shot 1 creates the row, shots 2..N then "protect"
 *  nothing and vanish — the portrait "seven empty tracks" bug, round 2).
 *
 *  Overlap is strict (`<`/`>`): fan-out shots are contiguous windows that
 *  share boundary timestamps, and a zero-width touch is not real coverage. */
export function shouldPersistLostSegment(
  priorTrack: Pick<Track, "segments"> | null,
  range: { start: number; end: number },
): boolean {
  if (!priorTrack) return true;
  const protectedByPrior = (priorTrack.segments ?? []).some(
    (s) =>
      s.startTime < range.end &&
      s.endTime > range.start &&
      s.samples.some((p) => p.visible && p.t >= range.start && p.t <= range.end),
  );
  return !protectedByPrior;
}

/** Build + upsert one segment from a finished tracking job's output, then
 *  summarize. NO JobManager import — safe to call from the MCP child AND the
 *  Next.js server. */
export async function applySegmentResult(
  p: ApplySegmentResultParams,
): Promise<{ trackId: string; segmentId: string; summary: ReturnType<typeof summarizeTrack> }> {
  const segmentId = `seg-${Math.round(p.range.start * 1000)}-${Math.round(p.range.end * 1000)}`;
  const segment = {
    id: segmentId,
    startTime: p.range.start,
    endTime: p.range.end,
    method: p.method,
    status: (p.out.samples.some((s) => s.visible) ? "ok" : "lost") as "ok" | "lost",
    samples: p.out.samples,
    objectKind: p.objectKind,
    provenance: p.provenance ?? "engine",
    createdAt: Date.now(),
  };

  // p.trackId is always a resolved id (callers generate one upstream when the
  // caller didn't supply trackId), so a null row simply means "first segment
  // for this track" → init it; a non-null row means upsert in place.
  const existingRow = await getTrackRow(p.db, p.trackId);
  if (!existingRow) {
    await initSegmentedTrack({
      trackId: p.trackId,
      fileId: p.file.id,
      framerate: p.out.framerate,
      method: p.method,
      subjectId: p.subjectId,
      label: p.label,
      anchors: p.anchors,
    });
  }
  await upsertSegment(p.trackId, segment);

  const track = await readTrack(p.file.pieceId, p.trackId);
  const trackForSummary: Track = track ?? {
    id: p.trackId,
    fileId: p.file.id,
    framerate: p.out.framerate,
    method: p.method,
    durationSec: p.out.samples.length ? p.out.samples[p.out.samples.length - 1].t : 0,
    samples: p.out.samples,
  };
  const summary = summarizeTrack(trackForSummary, {
    frameW: p.file.mediaWidth ?? 1,
    frameH: p.file.mediaHeight ?? 1,
    clipDurationSec: p.file.mediaDuration ?? Infinity,
  });
  return { trackId: p.trackId, segmentId, summary };
}
