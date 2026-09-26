import type { Composition } from "@/lib/engine/types";
import { readyAhead, type VideoFrameSource } from "@/lib/engine/video-frame-source";
import { computeVideoPriorities } from "@/lib/preview/track-priority";
import { computeReadyState, type ReadyDecision } from "@/lib/preview/ready-state";

/**
 * Decode-readiness probe (backpressure) for the transport's playback gate.
 *
 * The audio-master clock advances on its own; this is how the transport learns
 * whether the video has the pixels yet. Folds every video source ACTIVE at
 * composition-second `t` into one drop-frames decision (`computeReadyState`),
 * or `Infinity` runway when nothing gates (pure canvas comp). A source that
 * can't even serve a live frame at `t` returns a negative runway so the gate
 * trips decisively.
 *
 * A source that has FAILED (`VideoFrameSource.failure`, the clip can't be
 * played) is left out entirely: it will never become ready, so waiting on it
 * held the gate and re-buffered every few seconds, forever — the endless
 * "Buffering…" of docs-local/qa/2026-09-25-video-download-and-playback-plan.md
 * T3. The renderer draws its placeholder and the rest of the piece plays.
 */
export function probeReadyAhead(
  comp: Composition | null,
  sources: Record<string, VideoFrameSource>,
  t: number,
): ReadyDecision {
  if (!comp) return { allCanPaint: true, dominantId: null, dominantRunway: Infinity };
  const compArea = Math.max(1, comp.width * comp.height);

  // One entry per ACTIVE video source at `t`, carrying both its paint/runway
  // state (for the gate/re-buffer decision) and its geometry (for priority).
  interface Active {
    id: string;
    area: number; // on-screen area fraction 0..1
    z: number;
    opacity: number;
    duration: number;
    canPaint: boolean;
    runway: number;
  }
  const actives: Active[] = [];
  const consider = (
    id: string,
    src: VideoFrameSource | undefined,
    localT: number,
    area: number,
    z: number,
    opacity: number,
    duration: number,
  ) => {
    // An ACTIVE video whose source isn't registered yet (the startup race right
    // after a piece loads / a source attaches) must read as BLACK (canPaint
    // false) so the gate HOLDS — otherwise the first getFrame hits an empty ring
    // with no last-good frame → a BLACK flash (the count-0-but-black cold start).
    if (!src) {
      actives.push({ id, area, z, opacity, duration, canPaint: false, runway: -1 });
      return;
    }
    // A clip that can't be played never gates (see the doc comment above).
    if (src.failure?.()) return;
    // No live frame at the playhead = the exact condition that snaps a frame →
    // negative runway. But if the source has a last-good it can still PAINT
    // (hold) without going black — that distinction is what lets a secondary
    // drop frames without re-buffering the comp.
    const live = src.isReadyAt ? src.isReadyAt(localT) : true;
    const runway = live ? readyAhead(src, localT) : -1;
    const canPaint = live || src.lastGoodFrame?.() != null;
    actives.push({ id, area, z, opacity, duration, canPaint, runway });
  };
  // Scenes are canvas-only and decode no video — every gated source is an
  // overlay. Include trim.start for `video` so the gate probes the SAME
  // source-time the renderer draws + warm() decodes — else a trimmed/cut clip
  // reads not-ready at its real in-point and the gate holds (the mid-play buffer
  // at a cut). Tracked-video draws at absolute time (no trim).
  for (const o of comp.overlays ?? []) {
    const area = Math.max(0, Math.min(1, (o.rect.width * o.rect.height) / compArea));
    if (o.kind === "video") {
      if (t < o.startTime || t >= o.startTime + o.duration) continue;
      consider(o.id, sources[o.id], t - o.startTime + (o.trim?.start ?? 0), area, o.z, o.opacity, o.duration);
    } else if (o.kind === "tracked" && o.content.kind === "video") {
      if (t < o.startTime || t >= o.startTime + o.duration) continue;
      consider(o.id, sources[o.id], t - o.startTime, area, o.z, o.opacity, o.duration);
    }
  }

  if (actives.length === 0) {
    return { allCanPaint: true, dominantId: null, dominantRunway: Infinity };
  }
  // Score by visibility (area/z/duration/opacity) so the gate + re-buffer key
  // off the DOMINANT (most-visible) source — the drop-frames model.
  const priorities = computeVideoPriorities(
    actives.map((a) => ({ id: a.id, areaFraction: a.area, z: a.z, opacity: a.opacity, durationSec: a.duration })),
  );
  return computeReadyState(
    actives.map((a) => ({ id: a.id, canPaint: a.canPaint, runway: a.runway, priority: priorities.get(a.id) ?? 0 })),
  );
}
