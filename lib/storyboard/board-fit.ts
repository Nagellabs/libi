/** Pure helpers behind the Board view's "re-fit when a scene is added" rule
 *  (components/storyboard/board-view.tsx).
 *
 *  React Flow fits the viewport once, on mount. A card the agent adds later
 *  (`libi.add_storyboard_card`) is placed on the auto-grid — usually outside a
 *  viewport that was fitted to the earlier cards — so the user had to zoom out
 *  to find it. The board now marks ids that appear after mount as pending and
 *  fits again once React Flow has MEASURED them: fitting on the same tick the
 *  node mounts centres on a 0×0 box. The measurement arrives as the node's
 *  first `dimensions` change through `onNodesChange`. */

/** Ids in `next` that were not in `prev`, in `next` order. */
export function newNodeIds(prev: ReadonlySet<string>, next: readonly string[]): string[] {
  return next.filter((id) => !prev.has(id));
}

/** True when this batch of node changes carries a `dimensions` change for at
 *  least one pending id — i.e. a new node has been measured and a fit will now
 *  land on its real box. */
export function fitReadyIds(
  changes: ReadonlyArray<{ type: string; id?: string }>,
  pending: ReadonlySet<string>,
): boolean {
  if (pending.size === 0) return false;
  return changes.some((c) => c.type === "dimensions" && c.id !== undefined && pending.has(c.id));
}

/** True when every node carries a measured box. `fitView` silently ignores
 *  unmeasured nodes, so a fit issued while some are still being measured is
 *  computed against a subset — seen once in QA as a zoom-IN onto one card with
 *  the others off-screen. The board syncs fresh node objects from the storyboard
 *  on every change, which drops `measured` until React Flow re-reports it. */
export function allMeasured(
  nodes: ReadonlyArray<{ measured?: { width?: number; height?: number } }>,
): boolean {
  return nodes.every((n) => (n.measured?.width ?? 0) > 0 && (n.measured?.height ?? 0) > 0);
}
