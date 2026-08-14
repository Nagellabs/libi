/** Pure timeline lane model. Maps overlays → groups → packed sub-lanes → a
 *  derived, strictly-increasing z. NO React, NO DOM, NO IO — unit-tested in
 *  isolation. This is the single source of truth for how overlays stack on
 *  the timeline and on the canvas (the two are two views of one z value). */
import type { Overlay } from "@/lib/engine/types";

/** Default lane group label for an overlay kind. */
export function defaultGroupForKind(kind: Overlay["kind"]): string {
  switch (kind) {
    case "text":
      return "captions";
    case "image":
    case "video":
      return "stickers";
    case "code":
    case "three":
      return "graphics";
    case "tracked":
      return "tracked";
  }
}

/** Explicit `overlay.group` if set, else the kind default. */
export function groupForOverlay(o: Overlay): string {
  return o.group && o.group.length > 0 ? o.group : defaultGroupForKind(o.kind);
}

/** Deterministic sort: startTime ascending, ties broken by id ascending. */
function sortBars(overlays: Overlay[]): Overlay[] {
  return overlays.slice().sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Greedy interval partition into sub-lanes. Sort by (startTime, id); place
 * each bar on the FIRST sub-lane whose last bar's end ≤ this bar's start;
 * else open a new sub-lane. Returns a map of overlayId → sub-lane index.
 * 50 sequential non-overlapping bars → exactly 1 sub-lane.
 */
export function packLanes(overlays: Overlay[]): Record<string, number> {
  const sorted = sortBars(overlays);
  const laneEnds: number[] = []; // laneEnds[i] = end time of last bar on sub-lane i
  const out: Record<string, number> = {};
  for (const o of sorted) {
    const start = o.startTime;
    const end = o.startTime + o.duration;
    let placed = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= start) {
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[placed] = end;
    }
    out[o.id] = placed;
  }
  return out;
}

/** One timeline row: a group with its packed sub-lanes. */
export interface LaneRow {
  group: string;
  subLaneCount: number;
  /** sub-lane index per overlay id within this row. */
  subLanes: Record<string, number>;
  /** overlay ids in this row, in (startTime, id) order. */
  overlayIds: string[];
}

/**
 * Partition overlays into ordered rows (one per group), each with packed
 * sub-lanes. Rows are ordered deterministically by group label so a refetch
 * never reshuffles them. Row order is back→front (index 0 = back-most).
 */
export function buildLaneRows(overlays: Overlay[]): LaneRow[] {
  const byGroup = new Map<string, Overlay[]>();
  for (const o of overlays) {
    const g = groupForOverlay(o);
    const arr = byGroup.get(g);
    if (arr) arr.push(o);
    else byGroup.set(g, [o]);
  }
  const groups = Array.from(byGroup.keys()).sort();
  return groups.map((group) => {
    const members = sortBars(byGroup.get(group)!);
    const subLanes = packLanes(members);
    const subLaneCount = Object.values(subLanes).reduce(
      (max, v) => Math.max(max, v + 1),
      0,
    );
    return {
      group,
      subLaneCount,
      subLanes,
      overlayIds: members.map((m) => m.id),
    };
  });
}

/**
 * Assign a strictly-increasing integer z from (rowIndex, subLane, within-row
 * order). Front rows (higher index) get higher z; within a row, lower sub-lane
 * first, then (startTime, id) order. Returns overlayId → z.
 */
export function deriveZ(rows: LaneRow[]): Record<string, number> {
  const z: Record<string, number> = {};
  let next = 0;
  for (const row of rows) {
    // Order this row's ids by (subLane, then overlayIds order which is already
    // (startTime, id)). overlayIds is already (startTime, id)-sorted; sort by
    // sub-lane as the primary key with a stable secondary on that order.
    const order = row.overlayIds
      .map((id, idx) => ({ id, subLane: row.subLanes[id], idx }))
      .sort((a, b) =>
        a.subLane !== b.subLane ? a.subLane - b.subLane : a.idx - b.idx,
      );
    for (const { id } of order) {
      z[id] = next++;
    }
  }
  return z;
}
