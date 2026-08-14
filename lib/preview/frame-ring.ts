interface Entry<T> { timestamp: number; value: T; }

/**
 * A small, capacity-bounded ring of decoded frames ordered by timestamp.
 * `latestAtOrBefore(t)` is the getLatestFrame selection that makes a cut a
 * non-event. `onEvict` lets the owner release GPU memory (frame.close()).
 */
export class FrameRing<T> {
  private entries: Entry<T>[] = [];
  constructor(
    private readonly capacity: number,
    private readonly onEvict?: (value: T) => void,
    /** Max allowed span (seconds) between the oldest and newest buffered frame.
     *  When exceeded, frames FAR from the just-pushed timestamp are dropped. This
     *  is the scrub-pollution guard: dragging the timeline primes a frame at every
     *  swept position, and capacity-eviction (lowest-first) lets a far-future
     *  leftover (e.g. a 4.4s frame while playing at 1.0s) squat in the ring,
     *  wasting slots and forcing premature eviction of the playhead-region frames
     *  → out-of-order serving → the scrub-then-play flicker. Undefined = no cap
     *  (legacy/other callers). */
    private readonly maxSpanSec?: number,
  ) {}

  push(timestamp: number, value: T): void {
    const i = this.entries.findIndex((e) => e.timestamp > timestamp);
    if (i === -1) this.entries.push({ timestamp, value });
    else this.entries.splice(i, 0, { timestamp, value });
    while (this.entries.length > this.capacity) {
      const evicted = this.entries.shift()!;
      this.onEvict?.(evicted.value);
    }
    // Scrub-pollution guard. Only allocates when the span is abnormally large
    // (never in normal play, where the ring spans < capacity/fps seconds), so no
    // per-push GC churn on the hot path. Drops frames far from the JUST-PUSHED
    // time (the current decode activity) — self-heals the ring after a scrub.
    if (
      this.maxSpanSec !== undefined &&
      this.entries.length > 1 &&
      this.entries[this.entries.length - 1].timestamp - this.entries[0].timestamp > this.maxSpanSec
    ) {
      this.entries = this.entries.filter((e) => {
        const keep = Math.abs(e.timestamp - timestamp) <= this.maxSpanSec!;
        if (!keep) this.onEvict?.(e.value);
        return keep;
      });
    }
  }

  latestAtOrBefore(t: number): T | null {
    let found: T | null = null;
    for (const e of this.entries) {
      if (e.timestamp <= t) found = e.value;
      else break;
    }
    return found;
  }

  /** The oldest buffered entry (timestamp + value), or null when empty. Used by
   *  the nearest-upcoming fallback: when nothing is at-or-before the requested
   *  time, the earliest buffered frame is the closest available. */
  earliestEntry(): Entry<T> | null {
    return this.entries.length ? this.entries[0] : null;
  }

  /**
   * The frame to display at time `t`: the latest frame at-or-before `t`, or —
   * when none exists — the earliest buffered frame IF it's no more than
   * `toleranceAhead` seconds AFTER `t`. Returns null when nothing suitable is
   * buffered.
   *
   * The nearest-ahead fallback covers the seek-landing case: a clip seeked to
   * its `trim.start` (e.g. 6.000s) whose first decoded frame lands just after
   * it (e.g. 6.083s) has nothing at-or-before 6.000, but the 6.083 frame is the
   * correct thing to show — a few-dozen-ms-early frame, not a stale freeze. The
   * tolerance bounds it so a genuinely-stale ring (far ahead, e.g. mid
   * backward-scrub before the pump re-seeds) doesn't leak a wrong frame.
   */
  frameAtOrNearestAhead(t: number, toleranceAhead: number): T | null {
    return this.selectAtOrNearestAhead(t, toleranceAhead)?.value ?? null;
  }

  /**
   * Same selection as `frameAtOrNearestAhead` but returns the chosen entry's
   * timestamp + which path served it ("before" = latest ≤ t, "ahead" =
   * nearest-upcoming seek-landing fallback). Returns null when nothing
   * suitable is buffered. Used by telemetry to report the served frame's
   * staleness vs the requested time without changing selection behavior.
   */
  selectAtOrNearestAhead(
    t: number,
    toleranceAhead: number,
  ): { value: T; timestamp: number; kind: "before" | "ahead" } | null {
    let foundEntry: Entry<T> | null = null;
    for (const e of this.entries) {
      if (e.timestamp <= t) foundEntry = e;
      else break;
    }
    if (foundEntry) return { value: foundEntry.value, timestamp: foundEntry.timestamp, kind: "before" };
    const first = this.earliestEntry();
    if (first && first.timestamp <= t + toleranceAhead) {
      return { value: first.value, timestamp: first.timestamp, kind: "ahead" };
    }
    return null;
  }

  coversThrough(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].timestamp : -Infinity;
  }

  /** Earliest (oldest) buffered timestamp, or +Infinity when empty. The low
   *  end of the buffered span — paired with `coversThrough()` to test whether a
   *  requested time still has a decoded frame available. */
  coversFrom(): number {
    return this.entries.length ? this.entries[0].timestamp : Infinity;
  }

  clear(): void {
    for (const e of this.entries) this.onEvict?.(e.value);
    this.entries = [];
  }

  /** Current number of buffered entries (telemetry/diagnostics). */
  size(): number {
    return this.entries.length;
  }
}
