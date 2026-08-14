/**
 * Pure view-model for the layers list + timeline. Wraps the Plan-1 lane model
 * (buildLaneRows) and enriches each overlay with editor-only selection /
 * hidden / locked flags and its z. NO React, NO DOM.
 *
 * z authority (Issue 3): `overlay.z` is the AUTHORITATIVE stacking order for
 * BOTH the canvas render (highest z = front) AND the timeline rows. The
 * lane-derived `deriveZ` is used ONLY to SEED a z for overlays that lack a
 * finite one (e.g. a freshly added overlay, or a legacy manifest). Overlays
 * that already carry a finite `z` keep it verbatim — a manual reorder is never
 * recomputed away from the kind-lane grouping.
 */
import type { Overlay } from "@/lib/engine/types";
import { buildLaneRows, deriveZ, type LaneRow } from "@/lib/overlays/lanes";

/**
 * Resolve each overlay's authoritative z. Overlays with a finite `z` keep it.
 * Overlays lacking a finite z are SEEDED above the current max (front), in the
 * deterministic lane order from `deriveZ` so seeding is stable across refetches.
 * When NO overlay has a finite z (legacy / fixture state), every z is seeded
 * from the lane model — preserving the historical "front lane → higher z".
 */
export function resolveZ(overlays: Overlay[], laneRows: LaneRow[]): Record<string, number> {
  const seedOrder = deriveZ(laneRows); // overlayId → lane-derived rank (0 = back)
  const stored = new Map<string, number>();
  for (const o of overlays) {
    if (typeof o.z === "number" && Number.isFinite(o.z)) stored.set(o.id, o.z);
  }
  const out: Record<string, number> = {};
  if (stored.size === overlays.length && overlays.length > 0) {
    // Every overlay has an explicit z — authoritative, nothing to seed.
    for (const o of overlays) out[o.id] = stored.get(o.id)!;
    return out;
  }
  // Seed the overlays that lack z above the current max, in lane order.
  let maxStored = -Infinity;
  for (const v of stored.values()) maxStored = Math.max(maxStored, v);
  const base = Number.isFinite(maxStored) ? maxStored : -1;
  const lacking = overlays
    .filter((o) => !stored.has(o.id))
    .sort((a, b) => (seedOrder[a.id] ?? 0) - (seedOrder[b.id] ?? 0));
  let next = base + 1;
  for (const o of overlays) {
    if (stored.has(o.id)) out[o.id] = stored.get(o.id)!;
  }
  for (const o of lacking) out[o.id] = next++;
  return out;
}

export interface LayerVM {
  id: string;
  kind: Overlay["kind"];
  /** Sub-lane index within the row (from packLanes). */
  subLane: number;
  /** Authoritative stored z (higher = front), seeded only when absent. */
  z: number;
  selected: boolean;
  hidden: boolean;
  locked: boolean;
}

export interface LayerRowVM {
  group: string;
  subLaneCount: number;
  layers: LayerVM[];
}

export interface LayersViewModel {
  /** Rows back→front (index 0 = back-most), matching buildLaneRows. */
  rows: LayerRowVM[];
  /** overlayId → derived z. */
  zById: Record<string, number>;
}

export interface LayersFlags {
  /** Selected overlay ids — membership drives `bar.selected` (multi-select). */
  selectedIds: ReadonlySet<string>;
  /** overlayId → true when editor-hidden. */
  hidden: Record<string, boolean>;
  /** overlayId → true when editor-locked. */
  locked: Record<string, boolean>;
}

export function buildLayersViewModel(overlays: Overlay[], flags: LayersFlags): LayersViewModel {
  const laneRows: LaneRow[] = buildLaneRows(overlays);
  // z is authoritative (stored), with deriveZ only seeding overlays that lack it.
  const zById = resolveZ(overlays, laneRows);
  const kindById = new Map(overlays.map((o) => [o.id, o.kind] as const));
  const rows: LayerRowVM[] = laneRows.map((row) => ({
    group: row.group,
    subLaneCount: row.subLaneCount,
    // Within a row, present layers back→front by authoritative z (ties keep the
    // lane's deterministic (startTime, id) order from buildLaneRows).
    layers: row.overlayIds
      .map((id) => ({
        id,
        kind: kindById.get(id)!,
        subLane: row.subLanes[id],
        z: zById[id],
        selected: flags.selectedIds.has(id),
        hidden: flags.hidden[id] === true,
        locked: flags.locked[id] === true,
      }))
      .sort((a, b) => a.z - b.z),
  }));
  return { rows, zById };
}

/** The group label at a row index, or null when out of range. */
export function groupFromRowHit(vm: LayersViewModel, rowIndex: number): string | null {
  const row = vm.rows[rowIndex];
  return row ? row.group : null;
}
