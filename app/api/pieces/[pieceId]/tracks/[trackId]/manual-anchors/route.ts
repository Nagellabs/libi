import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import {
  manualAnchorId,
  upsertManualAnchor,
  reanchorWindow,
  REANCHOR_WINDOW_SEC,
} from "@/lib/tracking/manual-anchors";
import { recomputeTrackSegmentServerSide } from "@/lib/tracking/recompute-segment";
import { navigationEmitter } from "@/lib/navigation-events";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { serverLogger as logger } from "@/lib/logger";

type Ctx = { params: Promise<{ pieceId: string; trackId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { pieceId, trackId } = await params;
  const track = await readTrack(pieceId, trackId);
  if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });
  return NextResponse.json({ anchors: track.manualAnchors ?? [] });
}

export async function POST(req: Request, { params }: Ctx) {
  const { pieceId, trackId } = await params;
  let parsed: { time?: unknown; bbox?: unknown; retrack?: unknown };
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // ── retrack branch — fire background re-track for every distinct segment ──
  if (parsed.retrack === true && parsed.time === undefined) {
    const track = await readTrack(pieceId, trackId);
    if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });
    const anchors = track.manualAnchors ?? [];
    if (anchors.length === 0) {
      return NextResponse.json({ ok: true, retracking: 0 });
    }
    const db = getDb();
    const fileId = track.fileId;
    const manualAnchors = anchors;
    // Deduplicate by the SAME bounded window recomputeTrackSegmentServerSide
    // re-tracks (reanchorWindow), so two pins in one OK segment that land in
    // DIFFERENT ±W windows each get re-tracked (keying on the whole segment
    // would collapse them and silently drop the later pin's correction).
    // Concurrency bound is JobManager's per-kind queue (tracking
    // maxConcurrent:1), NOT a per-request cap. Do not remove the dedupe.
    const seenRangeKeys = new Set<string>();
    let distinctCount = 0;
    for (const anchor of anchors) {
      const range = reanchorWindow(track, anchor.time, REANCHOR_WINDOW_SEC);
      const key = `${range.start}-${range.end}`;
      if (seenRangeKeys.has(key)) continue;
      seenRangeKeys.add(key);
      distinctCount++;
      void recomputeTrackSegmentServerSide({ db, fileId, trackId, time: anchor.time, manualAnchors })
        .then(() => {
          navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });
        })
        .catch((err) => {
          logger.error(
            { tag: "tracking-reanchor", op: "retrack.recompute.error", trackId, err },
            "retrack-all segment failed",
          );
        });
    }
    return NextResponse.json({ ok: true, retracking: distinctCount });
  }
  // ── end retrack branch ──────────────────────────────────────────────────

  const time = parsed.time as number;
  const bbox = parsed.bbox as [number, number, number, number];
  if (
    !Number.isFinite(time) || time < 0 ||
    !Array.isArray(bbox) || bbox.length !== 4 ||
    !bbox.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return NextResponse.json({ error: "time:number and bbox:[x,y,w,h] required" }, { status: 400 });
  }

  const track = await readTrack(pieceId, trackId);
  if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });
  if (track.durationSec <= 0 && (track.segments ?? []).length === 0) {
    return NextResponse.json({ error: "track has no duration to re-track" }, { status: 409 });
  }

  // createdAt drives render-stamp consumption: once the seeded re-track below
  // lands (manual segment with a newer createdAt), the raw pin stops being
  // point-stamped at render (see isManualAnchorConsumed).
  const anchor = { id: manualAnchorId(time), time, bbox, createdAt: Date.now() };
  const manualAnchors = upsertManualAnchor(track.manualAnchors ?? [], anchor);
  await writeTrack(pieceId, { ...track, manualAnchors });

  const db = getDb();
  const fileId = track.fileId;

  const mm = Math.floor(time / 60);
  const ss = String(Math.floor(time % 60)).padStart(2, "0");

  // Deterministic, system-authored transparency note. Best-effort and
  // exactly worded — NOT routed through the agent (no generation, no
  // empty placeholder, no flaky "generating" view). No-ops when there's
  // no active session (bring-your-own-CLI) so the "Adjust tracking"
  // button progress is the sole feedback there.
  try {
    getSessionManager().postManualEditNote(
      `[manual edit] Re-anchored the tracked overlay at ${mm}:${ss}. ` +
        `Re-tracking that segment with your correction — will update once it finishes.`,
    );
  } catch {
    /* best-effort */
  }

  // Background: seeded re-track + track refresh. NOT awaited — the optimistic
  // snap renders client-side from the persisted anchor immediately. Terminal
  // .catch so a sidecar failure in any environment never rejects unhandled.
  void recomputeTrackSegmentServerSide({ db, fileId, trackId, time, manualAnchors })
    .then(() => {
      navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });
      try {
        getSessionManager().postManualEditNote(
          `[manual edit] Re-track at ${mm}:${ss} finished.`,
        );
      } catch {
        /* best-effort */
      }
    })
    .catch((err) => {
      logger.error(
        { tag: "tracking-reanchor", op: "reanchor.recompute.error", trackId, err },
        "seeded re-track failed",
      );
    });

  return NextResponse.json({ anchor });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { pieceId, trackId } = await params;
  const track = await readTrack(pieceId, trackId);
  if (!track) return NextResponse.json({ error: "track not found" }, { status: 404 });
  await writeTrack(pieceId, { ...track, manualAnchors: [] });
  navigationEmitter.emit("refresh_query", { queryKey: "track", trackId });
  return NextResponse.json({ ok: true });
}
