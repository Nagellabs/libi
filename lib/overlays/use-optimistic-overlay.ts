"use client";

import { useCallback, useState } from "react";

/**
 * Optimistic overlay editing — instant local display while the real commit
 * (PATCH → manifest → SSE → refetch) completes in the background.
 *
 * The caption inspector's enable toggles (Background/Stroke/Shadow) felt laggy:
 * the Switch only flipped once the round-trip refetch landed, and the detail
 * fields mounted into existence on the way. This helper splits display from
 * commit — `patch(p)` immediately merges `p` into a locally-held `view` (so the
 * Switch flips and the dimmed fields enable at once) AND fires the real commit;
 * a render-time release clears the pending state once the incoming `overlay`
 * prop has caught up.
 *
 * Pure `mergeOptimistic` is exported separately for unit testing.
 */

/** Apply `patch` onto `base`, returning a new object. A `null` patch value
 *  DELETES that key (the caption "clear" sentinel); any other value overwrites
 *  (nested objects replace wholesale — callers spread to merge). Never mutates
 *  `base`. */
export function mergeOptimistic<T extends object>(
  base: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

/** Shallow structural equality over the keys the patch could have touched —
 *  used to detect "the incoming prop already reflects my pending patch" so the
 *  optimistic overlay can be released. Exported so the merged-composition
 *  reconciler (`useMergedOverlayEdits`) can drop a committed override on the SAME
 *  data gate: only once the rendered composition's overlay already carries the
 *  patch, so there is never a frame where neither the override nor the
 *  composition holds the value (the residual drag origin-flash). */
export function reflectsPatch(
  overlay: Record<string, unknown>,
  applied: Record<string, unknown> | null,
): boolean {
  if (!applied) return true;
  for (const [key, value] of Object.entries(applied)) {
    // A `null`-clear is "landed" once the incoming overlay no longer has the key.
    if (value === null) {
      if (overlay[key] !== undefined) return false;
      continue;
    }
    if (!shallowEqual(overlay[key], value)) return false;
  }
  return true;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    shallowEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function useOptimisticOverlay<T extends { id: string }>(
  overlay: T,
  onPatch: (p: Record<string, unknown>) => void,
): { view: T; patch: (p: Record<string, unknown>) => void } {
  // `pending` is the FULL optimistic overlay (a clone of `overlay` with patches
  // applied), not a delta — so a `null`-clear shows the field deleted at once.
  // `applied` tracks just the patched keys so we can detect the refetch landing.
  const [state, setState] = useState<{
    view: T;
    applied: Record<string, unknown>;
  } | null>(null);

  // Release the optimistic state once the incoming prop reflects every patched
  // key (the refetch landed) — or whenever the selected overlay changes.
  // NOTE: correct reconciliation here depends on the PATCH route echoing the
  // patch shape verbatim. If the server normalises or reorders a nested value
  // (e.g. sorts keys), `reflectsPatch` will see a mismatch and the optimistic
  // view will stay pinned until the user selects a different overlay.
  // Released during render (previous-state pattern): once the prop reflects
  // every patched key the optimistic view and the prop agree on those keys, so
  // dropping the hold is invisible — and clearing `state` falsifies the guard,
  // so the adjustment is self-limiting. Pre-paint, no setState-in-effect
  // cascade (and unpatched keys that changed server-side show one render
  // EARLIER than the old post-commit effect release).
  if (state && reflectsPatch(overlay as Record<string, unknown>, state.applied)) {
    setState(null);
  }

  const patch = useCallback(
    (p: Record<string, unknown>) => {
      setState((prev) => {
        const base = (prev?.view ?? overlay) as object;
        return {
          view: mergeOptimistic(base, p) as T,
          applied: { ...(prev?.applied ?? {}), ...p },
        };
      });
      onPatch(p);
    },
    [overlay, onPatch],
  );

  return { view: state?.view ?? overlay, patch };
}
