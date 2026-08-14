import type { Track, TrackMethod, TrackSample } from "@/lib/tracking/types";
import { bridgeShortOcclusions } from "@/lib/tracking/bridge-short-occlusion";

export type SegmentStatus = "ok" | "lost" | "skipped";

export interface TrackSegment {
  id: string;
  /** Seconds, inclusive start. */
  startTime: number;
  /** Seconds, inclusive end. */
  endTime: number;
  method: TrackMethod;
  status: SegmentStatus;
  /** Samples within [startTime, endTime]. Empty for skipped/lost. */
  samples: TrackSample[];
  /** Human/agent-facing reason a segment is skipped or lost. */
  reason?: string;
  /** Box semantics: "face" segments emit head boxes, "object" emit body
   *  boxes. Mixing them under one overlay `fit` is the torso-emoji bug. */
  objectKind?: "face" | "object";
  /** Who authored this segment. Drives deriveSamples override precedence:
   *  manual (user re-anchor) > agent (compute_track_segment) > engine
   *  (compute_object_track / shot fan-out / legacy). Absent ⇒ inferred on
   *  read by normalizeTrack (legacy tracks); new writes always set it. */
  provenance?: "manual" | "agent" | "engine";
  /** ms epoch the segment was written. Tiebreak within equal provenance
   *  (newer wins). Absent ⇒ 0 (oldest). */
  createdAt?: number;
}

/** Stitch-precedence rank: manual(2) > agent(1) > engine(0, also the default
 *  for absent provenance). Shared by deriveSamples and the write-time overlap
 *  resolution in segment-store so they can never disagree. */
export function provenanceRank(p?: string): number {
  return p === "manual" ? 2 : p === "agent" ? 1 : 0;
}

/** Ordered union of all segment samples. Gaps remain gaps (honest). */
export function deriveSamples(track: Track): TrackSample[] {
  if (!track.segments || track.segments.length === 0) return track.samples ?? [];
  // Override precedence (highest wins its overlap): provenance
  // manual(2) > agent(1) > engine(0, also the default for absent) — so a
  // user manual re-anchor authoritatively owns its window over an older
  // agent repair or the wide engine seed, and a narrower agent carve-out
  // still overrides the engine seed. Within equal provenance: newer
  // createdAt wins, then NARROWER span wins (preserves the composable
  // "more specific carve-out wins" semantics and is order-independent).
  // Appearance quality is deliberately NOT a stitch input — wrong-subject
  // samples are rejected at the write path (reject-wrong-subject) so a bad
  // segment never carries them here. Apply losers first; the winner is
  // applied LAST and authoritatively owns [startTime,endTime] (empty/
  // skipped segments therefore clear their range). Non-overlapping shot
  // fan-out is unaffected (no overlap ⇒ nothing is filtered out).
  const rank = provenanceRank;
  const ordered = track.segments.slice().sort((a, b) => {
    const ra = rank(a.provenance), rb = rank(b.provenance);
    if (ra !== rb) return ra - rb; // lower precedence applied first (loses overlap)
    const ca = a.createdAt ?? 0, cb = b.createdAt ?? 0;
    if (ca !== cb) return ca - cb; // older applied first (newer wins overlap)
    // At equal precedence AND equal recency, a `lost` segment (all-invisible
    // engine miss) must never own an overlap that an ok/skipped sibling
    // covers with real data or a deliberate decision — otherwise the
    // narrower-wins span tiebreak below resurrects a stale all-lost engine
    // segment over a marginally-WIDER repair (the task-39 sot-recompute bug:
    // lost [0,18.933] beat ok [0,19.021]). Skipped segments keep their
    // documented clear-the-range power (they are deliberate, not a miss).
    const la = a.status === "lost" ? 0 : 1, lb = b.status === "lost" ? 0 : 1;
    if (la !== lb) return la - lb; // lost applied first (non-lost wins overlap)
    const spanA = a.endTime - a.startTime, spanB = b.endTime - b.startTime;
    if (spanB !== spanA) return spanB - spanA; // wider applied first (narrower wins)
    return a.startTime - b.startTime; // stable
  });
  let acc: TrackSample[] = [];
  for (const s of ordered) {
    acc = acc.filter((p) => p.t < s.startTime || p.t > s.endTime);
    acc = acc.concat(s.samples);
  }
  // Bridge brief same-subject occlusions (e.g. a cameraman crossing the
  // subject for a few frames) so the overlay doesn't flicker off for a
  // split second. Strictly gated (≤0.4s, same-subject bracket) so it never
  // hides a real loss or an identity change; bridged samples are honest
  // (confidence:0, targetSim:null).
  return bridgeShortOcclusions(acc.sort((a, b) => a.t - b.t));
}

/** True when a track's OK segments mix face (head-box) and object
 *  (body-box) semantics — one overlay `fit` cannot be correct for both.
 *  Only `status === "ok"` segments define semantics; skipped/lost render
 *  nothing so they don't constrain `fit`. Absent objectKind ⇒ "object"
 *  (legacy tracks were body-box). */
export function mixedBoxSemantics(segments: TrackSegment[]): boolean {
  const kinds = new Set(
    segments
      .filter((s) => s.status === "ok")
      .map((s) => s.objectKind ?? "object"),
  );
  return kinds.size > 1;
}

/** The objectKind shared by a track's OK segments (the box-semantics class
 *  a refine/extension segment should inherit so it never spuriously trips
 *  mixedBoxSemantics). Returns the single OK objectKind, or "object" when
 *  there are none / they already disagree (caller shouldn't refine an
 *  already-mixed track anyway). */
export function dominantObjectKind(segments: TrackSegment[]): "face" | "object" {
  const kinds = new Set(
    segments.filter((s) => s.status === "ok").map((s) => s.objectKind ?? "object"),
  );
  return kinds.size === 1 ? ([...kinds][0] as "face" | "object") : "object";
}

/** Infer a legacy (untagged) segment's provenance from track context.
 *  Explicit provenance is never overwritten. A full-range segment (covers
 *  the whole sampled span) is the engine seed; a segment whose
 *  [startTime,endTime] contains a manual-anchor time is the user's manual
 *  re-anchor; anything else is an agent carve-out. */
export function inferSegmentProvenance(
  track: Track,
): TrackSegment[] {
  const segs = track.segments ?? [];
  const manualTimes = (track.manualAnchors ?? []).map((a) => a.time);
  const allT = segs.flatMap((g) => g.samples.map((p) => p.t));
  const lo = allT.length ? Math.min(...allT) : 0;
  const hi = allT.length ? Math.max(...allT) : 0;
  const EPS = 1e-3;
  return segs.map((g) => {
    if (g.provenance) return g;
    // A `lost` segment is by definition ENGINE output (the engine bound the
    // subject in 0 frames) — an agent/manual repair is either ok data or an
    // explicit skip. Without this, a stale near-full-range lost segment
    // sitting next to a marginally-wider repair got inferred as the "agent"
    // carve-out (the repair, being widest, read as the engine seed) — an
    // INVERTED ranking that made deriveSamples resurrect the all-invisible
    // engine samples over the repair (task-39 Bug 2, legacy sidecars).
    if (g.status === "lost") return { ...g, provenance: "engine" as const };
    const isFullRange =
      g.startTime <= lo + EPS && g.endTime >= hi - EPS;
    const hasManual = manualTimes.some(
      (t) => t >= g.startTime && t <= g.endTime,
    );
    const provenance: "manual" | "agent" | "engine" = isFullRange
      ? "engine"
      : hasManual
        ? "manual"
        : "agent";
    return { ...g, provenance };
  });
}

/**
 * Write-time overlap resolution for `upsertSegment`: a newly-written segment
 * REPLACES the window it covers in every equal-or-lower-precedence sibling.
 *
 * upsertSegment's replace key is the segment `id`, and ids encode the range
 * (`seg-<startMs>-<endMs>`) — so a recompute over a not-byte-identical range
 * (task-39: sot [0,19.021] repairing the failed engine [0,18.933]) minted a
 * NEW id and appended, leaving both overlapping segments in the table
 * forever (stale rows in list_track_segments/perSegment, and — on legacy
 * sidecars — stitch-resurrection of the superseded samples).
 *
 * Rules (per sibling, vs the incoming `seg`):
 *  - higher provenance rank than `seg`      → untouched (an engine re-run can
 *    never wipe an agent/manual repair; deriveSamples gives the sibling its
 *    window anyway);
 *  - no strict overlap (touching is fine)   → untouched (contiguous fan-out);
 *  - fully covered by `seg`                 → dropped (superseded);
 *  - sibling CONTAINS `seg` on both sides   → untouched (the composable
 *    narrow carve-out: the wide seed keeps owning everything outside `seg`,
 *    deriveSamples resolves the inner window);
 *  - partial edge overlap                   → trimmed: range clamped to the
 *    non-disputed side and samples inside `seg`'s window removed.
 */
export function resolveSegmentOverlaps(
  siblings: TrackSegment[],
  seg: TrackSegment,
): TrackSegment[] {
  const segRank = provenanceRank(seg.provenance);
  const out: TrackSegment[] = [];
  for (const s of siblings) {
    if (provenanceRank(s.provenance) > segRank) {
      out.push(s);
      continue;
    }
    const overlaps = s.startTime < seg.endTime && s.endTime > seg.startTime;
    if (!overlaps) {
      out.push(s);
      continue;
    }
    const coveredLeft = s.startTime >= seg.startTime;
    const coveredRight = s.endTime <= seg.endTime;
    if (coveredLeft && coveredRight) continue; // fully superseded → drop
    if (!coveredLeft && !coveredRight) {
      out.push(s); // sibling contains seg → carve-out, stitch handles it
      continue;
    }
    if (coveredLeft) {
      // Sibling overhangs seg's END → keep only the part after seg.
      out.push({
        ...s,
        startTime: seg.endTime,
        samples: s.samples.filter((p) => p.t > seg.endTime),
      });
    } else {
      // Sibling overhangs seg's START → keep only the part before seg.
      out.push({
        ...s,
        endTime: seg.startTime,
        samples: s.samples.filter((p) => p.t < seg.startTime),
      });
    }
  }
  return out;
}

/**
 * Guarantees `track.segments` exists and `track.samples` is the derived
 * stitch. Legacy (segments field ABSENT) → one full-range segment. An
 * explicitly-present-but-empty `segments: []` means "segmented track, no
 * segments yet" (e.g. a shot fan-out seed) and is left untouched — NOT
 * synthesized into a phantom `seg-legacy`. Idempotent.
 */
export function normalizeTrack(track: Track): Track {
  if (track.segments && track.segments.length > 0) {
    const segments = inferSegmentProvenance(track);
    return { ...track, segments, samples: deriveSamples({ ...track, segments }) };
  }
  // Explicit empty array: a segmented track that simply has no segments yet.
  if (track.segments && track.segments.length === 0) {
    return { ...track, samples: [] };
  }
  const samples = track.samples ?? [];
  const segment: TrackSegment = {
    id: "seg-legacy",
    startTime: samples.length > 0 ? samples[0].t : 0,
    endTime: samples.length > 0 ? samples[samples.length - 1].t : 0,
    method: track.method as TrackMethod,
    status: "ok",
    samples,
  };
  return { ...track, segments: [segment], samples };
}
