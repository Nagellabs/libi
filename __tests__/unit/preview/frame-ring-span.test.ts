import { describe, it, expect } from "vitest";
import { FrameRing } from "@/lib/preview/frame-ring";

/**
 * Scrub-pollution guard: dragging the timeline primes a frame at every swept
 * position; capacity-eviction (lowest-first) would let a far-future leftover
 * squat in the ring (the trace literally showed ring=[0.90..4.43] while playing
 * at ~1s), forcing playhead-region frames out and serving frames out of order on
 * the next play (the scrub-then-play flicker). The maxSpanSec cap drops frames
 * far from the just-pushed time so the ring self-heals.
 */
describe("FrameRing maxSpanSec (scrub-pollution guard)", () => {
  it("drops a far-future leftover once a near-playhead frame is pushed", () => {
    const evicted: number[] = [];
    const ring = new FrameRing<number>(24, (v) => evicted.push(v), 2.0);
    // Simulate a scrub leftover at 4.4 still in the ring...
    ring.push(4.43, 443);
    // ...then normal forward decode near the playhead (~1.0s).
    ring.push(0.9, 90);
    ring.push(0.93, 93);
    ring.push(0.97, 97); // span 0.9..4.43 = 3.53 > 2.0 → prune far-from-0.97
    // 4.43 is 3.46s from 0.97 → dropped; near frames kept.
    expect(ring.coversThrough()).toBeCloseTo(0.97, 5);
    expect(ring.coversFrom()).toBeCloseTo(0.9, 5);
    expect(evicted).toContain(443);
  });

  it("does NOT prune during normal play (span stays under the cap)", () => {
    const evicted: number[] = [];
    const ring = new FrameRing<number>(24, (v) => evicted.push(v), 2.0);
    // 24 frames at 30fps span 0.766s — well under 2.0; nothing span-pruned.
    for (let i = 0; i < 24; i++) ring.push(i / 30, i);
    expect(ring.size()).toBe(24);
    expect(evicted).toHaveLength(0); // only capacity eviction would evict; 24 == cap
    expect(ring.coversThrough() - ring.coversFrom()).toBeLessThan(2.0);
  });

  it("keeps a contiguous window around the newest push when pruning", () => {
    const ring = new FrameRing<number>(50, undefined, 2.0);
    // Frames spread 0..5s (e.g. a wild scrub), newest push last at 4.5.
    for (let t = 0; t <= 4.0; t += 0.5) ring.push(t, t * 100);
    ring.push(4.5, 450); // newest; prune anything > 2.0 from 4.5 → keep >= 2.5
    expect(ring.coversFrom()).toBeGreaterThanOrEqual(2.5 - 1e-9);
    expect(ring.coversThrough()).toBeCloseTo(4.5, 5);
  });

  it("no cap (undefined) preserves legacy behavior — only capacity eviction", () => {
    const ring = new FrameRing<number>(100); // no maxSpanSec
    ring.push(0.0, 0);
    ring.push(10.0, 1000); // huge span, but no cap → both retained
    expect(ring.size()).toBe(2);
    expect(ring.coversThrough() - ring.coversFrom()).toBeCloseTo(10.0, 5);
  });
});
