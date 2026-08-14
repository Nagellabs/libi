"use client";

import { useState } from "react";
import {
  resolveHeldTiming,
  type ClipTiming,
} from "@/lib/preview/audio-clip-drag";

/**
 * Optimistic-hold for an audio clip's [startTime,duration]. The clip's
 * `propTiming` is the latest value derived from the composition (server/cache).
 * When a drag commits, the component calls `hold(timing)` with the value it just
 * committed; the hook then DISPLAYS that held value until the incoming
 * `propTiming` provably reflects it — at which point the hold releases
 * automatically and display falls back to the prop.
 *
 * This is the same data-gated reconcile the overlay-edit store uses
 * (`useMergedOverlayEdits`), specialized to a single clip's timing: there is
 * never a render where neither the hold nor the prop carries the committed
 * value, so a stale `refresh_query` refetch (or the `onSettled` invalidate) can
 * never flash the bar back to its pre-drag position on release.
 *
 * Returns `display` (what to render) + `hold` (call on drag commit).
 */
export function useAudioClipPosition(propTiming: ClipTiming): {
  display: ClipTiming;
  hold: (timing: ClipTiming) => void;
} {
  const [held, setHeld] = useState<ClipTiming | null>(null);
  const { display, release } = resolveHeldTiming(propTiming, held);
  // Release during render (previous-state pattern): `release` is only true
  // once the prop provably reflects the hold, so display is identical before
  // and after the drop — and clearing `held` falsifies `release`, so the
  // adjustment is self-limiting. No setState-in-effect cascade.
  if (release) setHeld(null);
  return { display, hold: setHeld };
}
