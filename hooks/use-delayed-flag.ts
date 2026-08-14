"use client";

import { useEffect, useState } from "react";

/**
 * Returns `true` only after `active` has stayed continuously true for
 * `delayMs`; resets to `false` the instant `active` goes false.
 *
 * Use to DEFER a loading skeleton: a fast (<delayMs) load resolves before the
 * timer fires, so the skeleton never flashes — the content appears directly.
 * Only genuinely slow loads cross the threshold and reveal the skeleton.
 */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [flag, setFlag] = useState(false);

  // Reset during render, not in the effect: React re-renders immediately with
  // the new state (before paint), so the flag drops the instant `active` goes
  // false — same timing as before, without a setState-in-effect cascade.
  if (!active && flag) setFlag(false);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setFlag(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);

  return flag;
}
