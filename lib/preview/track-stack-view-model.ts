/**
 * Pure ordered model for the timeline track stack. Rows are returned in
 * TOP→BOTTOM display order: ONE row PER overlay, ordered by stored `z`
 * DESCENDING (top row = highest z = rendered in FRONT), then the Video (base
 * scenes) track, then the Audio track. The overlay's KIND is a label/icon/
 * height ON its row — kind is no longer a grouping lane. Carries the per-row
 * rail icon/label so surfaces never drift. NO React, NO DOM.
 */
import type { Composition, Overlay } from "@/lib/engine/types";
import {
  buildLayersViewModel,
  type LayerRowVM,
  type LayersFlags,
} from "@/lib/overlays/layers-view-model";
import { groupForOverlay } from "@/lib/overlays/lanes";

/** A video overlay's COUPLED audio (`kind:"inline"` + linkedOverlayId → an
 *  existing video overlay), rendered as a slim row DIRECTLY UNDER the video. It
 *  always moves WITH the video (positioned by the video's window, reorders the
 *  video pair). DETACHED audio is NOT a coupled row — it's an independent
 *  `audioTrack` row interleaved among the overlays. Free clips (no link) fall
 *  through to the bottom Audio section. */
export interface CoupledAudioVM {
  clipId: string;
  enabled: boolean;
}

export type TrackRowVM =
  | {
      kind: "overlay";
      /** The overlay's content kind (drives icon/label/height). */
      overlayKind: Overlay["kind"];
      /** The single overlay this row represents. */
      overlayId: string;
      /** Stored z (top row has the highest z). */
      z: number;
      /** Lane group label (kept for the rail label + back-compat sizing). */
      group: string;
      railLabel: string;
      railIcon: string;
      /** A one-overlay LayerRowVM so TimelineOverlayRow renders unchanged. */
      row: LayerRowVM;
    }
  | {
      /** A video overlay's COUPLED (inline) audio — emitted as its OWN slim row
       *  DIRECTLY under the video row. Reads as one combined track and moves with
       *  the video (positioned by the video, vertical drag reorders the pair).
       *  Only inline audio is a coupledAudio row; detached audio is an
       *  independent `audioTrack` row. */
      kind: "coupledAudio";
      clipId: string;
      enabled: boolean;
      /** The video overlay this audio belongs to (for the "audio of video" label). */
      ownerOverlayId: string;
    }
  | {
      /** A DETACHED audio track (`kind:"standalone"` + still carries a resolvable
       *  linkedOverlayId) — a FULLY INDEPENDENT row interleaved among the overlay
       *  rows by `order` (same vertical axis as overlay `z`). Drag-anywhere:
       *  horizontal = time, vertical = reorder ITSELF only (never the video). It
       *  keeps a Re-attach affordance back to `ownerOverlayId`. Render compositing
       *  is unaffected — `order` only drives the timeline's vertical row order. */
      kind: "audioTrack";
      clipId: string;
      enabled: boolean;
      /** The source video overlay (for the "detached audio of video — X" label
       *  + the Re-attach target). */
      ownerOverlayId: string;
      /** Vertical sort key (`clip.timelineOrder ?? sourceVideo.z − 0.5`); higher
       *  = nearer the top. Shared sort space with overlay `z`. */
      order: number;
    }
  | { kind: "audio"; railLabel: string; railIcon: string; clipIds: string[] };

export interface TrackStackViewModel {
  /** Top→bottom display order. */
  rows: TrackRowVM[];
  /** overlayId → derived z (from the overlay lane model). */
  zById: Record<string, number>;
}

const GROUP_ICON: Record<string, string> = {
  captions: "ti-letter-case",
  graphics: "ti-shape",
  stickers: "ti-photo",
  tracked: "ti-target",
};

/** Rail icon for an overlay group label; a neutral stack icon for custom groups. */
export function railIconForGroup(group: string): string {
  return GROUP_ICON[group] ?? "ti-stack";
}

const KIND_ICON: Record<Overlay["kind"], string> = {
  text: "ti-letter-case",
  image: "ti-photo",
  video: "ti-movie",
  code: "ti-shape",
  three: "ti-shape",
  tracked: "ti-target",
};

/** Rail icon for a single overlay row, by content kind. */
export function railIconForKind(kind: Overlay["kind"]): string {
  return KIND_ICON[kind] ?? "ti-stack";
}

// ── Per-kind track heights ───────────────────────────────────────────────
// Media overlays (image/video) paint a filmstrip/thumbnail background and need
// the full bar height. Text/code/three are thin labeled bars. Audio rows match
// the short height (waveform shrinks with it).
/** Tall track height (px) for media rows that show a filmstrip/thumbnail — the
 *  base Video (scene) track AND image/video overlay rows. Fixed (never grows),
 *  so every video track is the SAME height (the base scene track no longer
 *  balloons to fill the panel, and it matches a video-overlay row exactly). A
 *  comfortable filmstrip height. */
export const TRACK_H_TALL = 58;
/** Short track height (px) for text/code/three overlays + audio clip rows. */
export const TRACK_H_SHORT = 22;

/**
 * The fixed row height (px) for an overlay of `kind`. Media (image/video) →
 * TALL (filmstrip/thumbnail); everything else (text/code/three/tracked) →
 * SHORT (thin labeled bar). Audio rows use TRACK_H_SHORT directly.
 */
export function rowHeightForKind(kind: Overlay["kind"]): number {
  return kind === "image" || kind === "video" ? TRACK_H_TALL : TRACK_H_SHORT;
}

/**
 * Pure z-rewrite for a vertical (cross-row) overlay drag. Given the current
 * `zById` map and the dragged overlay `id`, move it by `deltaRows` positions
 * in the flattened FRONT→BACK order (+deltaRows = toward front), then re-assign
 * a dense z = index over the BACK→FRONT order (back-most = 0). Mirrors
 * `reorderOverlaysInManifest` exactly: pass the resulting `overlayIdsInZOrder`
 * (back→front) and the FIRST id gets z = 0.
 *
 * Returns `{ overlayIdsInZOrder, zById }` where `zById` is the new dense map,
 * or null when the move is a no-op (id missing, <2 overlays, or clamped end).
 */
export function reorderZByDrag(
  zById: Record<string, number>,
  id: string,
  deltaRows: number,
): { overlayIdsInZOrder: string[]; zById: Record<string, number> } | null {
  const ids = Object.keys(zById);
  if (ids.length < 2 || !(id in zById)) return null;
  // Front→back: descending z, ties broken by id for determinism.
  const frontToBack = ids.slice().sort((a, b) => {
    const za = zById[a];
    const zb = zById[b];
    if (za !== zb) return zb - za;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const curPos = frontToBack.indexOf(id);
  const targetPos = Math.max(0, Math.min(frontToBack.length - 1, curPos - deltaRows));
  if (targetPos === curPos) return null;
  const reordered = frontToBack.slice();
  reordered.splice(curPos, 1);
  reordered.splice(targetPos, 0, id);
  const backToFront = reordered.slice().reverse();
  const next: Record<string, number> = {};
  backToFront.forEach((oid, z) => {
    next[oid] = z;
  });
  return { overlayIdsInZOrder: backToFront, zById: next };
}

/**
 * Map a vertical drag's pointer Y to a cross-row `deltaRows` against the REAL
 * rendered rows. Overlay rows are variable height (image/video TALL vs
 * text/code/three SHORT), so the old `round(dyPixels / fixedHeight)` mis-counted
 * the rows actually crossed — the "reorder isn't what I dragged" bug. Given the
 * ordered overlay rows (top→bottom = front→back, matching the z-desc stack) with
 * their client-space vertical spans, the target row is the first whose bottom is
 * at/under the pointer (clamped to the last row when below all). `deltaRows` is
 * `curIdx - targetIdx` (+ = toward front/top), which `reorderZByDrag` consumes
 * directly. Pure → unit-testable without the DOM.
 */
export function crossRowDeltaFromY(
  orderedRows: { id: string; top: number; bottom: number }[],
  draggedId: string,
  clientY: number,
): number {
  const curIdx = orderedRows.findIndex((r) => r.id === draggedId);
  if (curIdx === -1 || orderedRows.length < 2) return 0;
  let targetIdx = orderedRows.length - 1; // below all rows → last
  for (let i = 0; i < orderedRows.length; i++) {
    if (clientY <= orderedRows[i].bottom) {
      targetIdx = i;
      break;
    }
  }
  return curIdx - targetIdx;
}

export function buildTrackStackViewModel(
  composition: Composition | null,
  flags: LayersFlags,
): TrackStackViewModel {
  const overlays = composition?.overlays ?? [];
  const lvm = buildLayersViewModel(overlays, flags);
  const overlayById = new Map(overlays.map((o) => [o.id, o] as const));

  // Partition a video overlay's linked audio into COUPLED vs DETACHED:
  //  - COUPLED (`kind:"inline"` + linkedOverlayId → existing video): a slim
  //    coupledAudio row riding directly under the video (moves with it).
  //  - DETACHED (`kind:"standalone"` + linkedOverlayId → existing video): a
  //    FULLY INDEPENDENT `audioTrack` row interleaved among the overlays by its
  //    `timelineOrder` (same vertical axis as overlay `z`).
  // Only clips with NO live overlay link (free, or an orphaned link to a removed
  // overlay) fall through to the bottom Audio section.
  const allClips = composition?.audioClips ?? [];
  const coupledByOverlay = new Map<string, CoupledAudioVM>();
  // Detached tracks: independent rows interleaved by `order`.
  type DetachedTrack = {
    clipId: string;
    enabled: boolean;
    ownerOverlayId: string;
    order: number;
  };
  const detachedTracks: DetachedTrack[] = [];
  const linkedClipIds = new Set<string>();
  for (const c of allClips) {
    if (!c.linkedOverlayId) continue;
    const owner = overlayById.get(c.linkedOverlayId);
    if (!owner) continue; // orphaned link → falls to the bottom Audio section
    linkedClipIds.add(c.id);
    if (c.kind === "inline") {
      coupledByOverlay.set(c.linkedOverlayId, { clipId: c.id, enabled: c.enabled });
    } else {
      // Detached: order from the persisted key, falling back to "just below the
      // source video" (z − 0.5) so a freshly-detached clip with no stored order
      // still materializes under its video.
      const order = c.timelineOrder ?? owner.z - 0.5;
      detachedTracks.push({
        clipId: c.id,
        enabled: c.enabled,
        ownerOverlayId: c.linkedOverlayId,
        order,
      });
    }
  }

  // ONE row PER overlay (Issue 3 refinement). Stored z is authoritative: the
  // stack shows the front-most overlay on top → order rows by z DESCENDING.
  // Ties broken by id for a stable order across refetches. Each row carries a
  // one-overlay LayerRowVM (subLane forced to 0) so TimelineOverlayRow renders
  // a single bar at the row's own height. The kind drives icon/label/height;
  // the lane group is kept only as the rail label.
  const flatLayers = lvm.rows.flatMap((r) =>
    r.layers.map((l) => ({ l, group: r.group })),
  );

  // Combined interleaved stack: overlay rows (sort key = overlay z) + detached
  // `audioTrack` rows (sort key = order), sorted by key DESCENDING (higher =
  // top). Coupled audio rides immediately after its OWN video row regardless of
  // the detached-track sort. Render compositing is UNCHANGED — `order` never
  // affects render; only this vertical row order.
  type StackEntry =
    | { kind: "overlay"; key: number; tieId: string; l: (typeof flatLayers)[number]["l"]; group: string }
    | { kind: "detached"; key: number; tieId: string; track: DetachedTrack };
  const entries: StackEntry[] = [
    ...flatLayers.map((f) => ({
      kind: "overlay" as const,
      key: f.l.z,
      tieId: f.l.id,
      l: f.l,
      group: f.group,
    })),
    ...detachedTracks.map((t) => ({
      kind: "detached" as const,
      key: t.order,
      tieId: t.clipId,
      track: t,
    })),
  ];
  entries.sort((a, b) => {
    if (a.key !== b.key) return b.key - a.key; // higher key → nearer the top
    return a.tieId < b.tieId ? -1 : a.tieId > b.tieId ? 1 : 0;
  });

  const overlayRows: TrackRowVM[] = entries.flatMap((entry): TrackRowVM[] => {
    if (entry.kind === "detached") {
      const t = entry.track;
      return [
        {
          kind: "audioTrack" as const,
          clipId: t.clipId,
          enabled: t.enabled,
          ownerOverlayId: t.ownerOverlayId,
          order: t.order,
        },
      ];
    }
    const { l, group } = entry;
    const ov = overlayById.get(l.id);
    const kind = ov?.kind ?? l.kind;
    const rail = ov ? groupForOverlay(ov) : group;
    const overlayRow: TrackRowVM = {
      kind: "overlay" as const,
      overlayKind: kind,
      overlayId: l.id,
      z: l.z,
      group: rail,
      railLabel: rail,
      railIcon: railIconForKind(kind),
      row: {
        group: rail,
        subLaneCount: 1,
        layers: [{ ...l, subLane: 0 }],
      },
    };
    // A video overlay's COUPLED (inline) audio rides directly under it as a slim
    // strip. Detached audio is NOT here — it's an independent audioTrack row.
    const coupled = kind === "video" ? coupledByOverlay.get(l.id) : undefined;
    if (!coupled) return [overlayRow];
    return [
      overlayRow,
      {
        kind: "coupledAudio" as const,
        clipId: coupled.clipId,
        enabled: coupled.enabled,
        ownerOverlayId: l.id,
      },
    ];
  });

  const rows: TrackRowVM[] = [...overlayRows];

  // The bottom Audio section shows only clips with NO live overlay link: free
  // standalone clips (and any clip whose remembered overlay was removed). Coupled
  // clips ride under their video above; detached clips are independent
  // `audioTrack` rows interleaved among the overlays above.
  const clipIds = allClips.filter((c) => !linkedClipIds.has(c.id)).map((c) => c.id);
  if (clipIds.length > 0) {
    rows.push({ kind: "audio", railLabel: "Audio", railIcon: "ti-volume", clipIds });
  }

  return { rows, zById: lvm.zById };
}
