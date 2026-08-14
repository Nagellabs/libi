import { describe, it, expect } from "vitest";
import { needsPumpRestart, pumpDecision } from "@/lib/preview/decode-ahead";
import { FrameRing } from "@/lib/preview/frame-ring";

describe("needsPumpRestart", () => {
  it("restarts on an empty ring", () => {
    expect(needsPumpRestart(1.0, Infinity, -Infinity)).toBe(true);
  });

  it("does NOT restart when t is within the buffered span", () => {
    // earliest 0.8, covered 1.5, playhead 1.0 → frame available
    expect(needsPumpRestart(1.0, 0.8, 1.5)).toBe(false);
  });

  it("does NOT restart when decode-ahead runs far ahead of the playhead", () => {
    // THE bug case: covered (1.5) >> t (1.0). Healthy decode-ahead, not a jump.
    expect(needsPumpRestart(1.0, 0.95, 1.5)).toBe(false);
  });

  it("restarts on a backward jump before the buffer", () => {
    expect(needsPumpRestart(0.2, 0.8, 1.5)).toBe(true);
  });

  it("restarts when the playhead runs past the buffer (underflow / forward jump)", () => {
    expect(needsPumpRestart(3.0, 0.8, 1.5)).toBe(true);
  });

  it("tolerates sub-frame jitter at the span edges (eps)", () => {
    // Just past covered but within eps → still contiguous.
    expect(needsPumpRestart(1.52, 0.8, 1.5)).toBe(false);
    // Just before earliest but within eps → still contiguous.
    expect(needsPumpRestart(0.77, 0.8, 1.5)).toBe(false);
  });

  it("does NOT restart on a sub-tolerance backward gap (the seek-landing thrash)", () => {
    // Captured failure: clip trim.start 6.000s, but the decoder's first frame
    // after seeking lands at 6.083s → ring earliest 6.083, playhead 6.000.
    // The 83ms gap is the seek-landing artifact, NOT a scrub-back: clearing the
    // ring here re-seeds to the same 6.083 → t<earliest again → restart again,
    // ~18×/s. Must be absorbed (no restart).
    expect(needsPumpRestart(6.0, 6.083, 6.467)).toBe(false);
    // Even a 0.4s gap (still < 0.5 tolerance) is absorbed.
    expect(needsPumpRestart(6.0, 6.4, 7.0)).toBe(false);
  });

  it("still restarts on a real scrub-back beyond the tolerance", () => {
    // A genuine backward seek (>0.5s before the window) must clear + restart —
    // a forward-only pump can never fill behind the playhead.
    expect(needsPumpRestart(6.0, 7.0, 8.0)).toBe(true);
  });
});

describe("pumpDecision", () => {
  const LA = 0.6;
  it("ok when a frame at t is already buffered", () => {
    expect(pumpDecision(5.0, 4.8, 5.6, 4.8, LA)).toBe("ok");
  });
  it("restart on an empty ring", () => {
    expect(pumpDecision(2.0, Infinity, -Infinity, null, LA)).toBe("restart");
  });
  it("wait when a live pump is heading forward toward t (just past the window)", () => {
    // t slightly past covered, pump started at/<= t and t within reach → wait.
    expect(pumpDecision(5.8, 5.0, 5.6, 5.0, LA)).toBe("wait");
  });
  it("RESTART on a backward jump — t behind the window — even if a pump origin is <= t (the deadlock bug)", () => {
    // Captured failure: playhead 5.833, ring 6.433..7.2 (ahead), a pump parked
    // ahead. Must restart (a forward-only pump never fills behind the playhead).
    expect(pumpDecision(5.833, 6.433, 7.2, 5.0, LA)).toBe("restart");
  });
  it("restart on a far forward jump beyond what the pump will soon reach", () => {
    expect(pumpDecision(20.0, 4.8, 5.6, 5.0, LA)).toBe("restart");
  });
  it("does NOT restart on the seek-landing gap — stays buffered (ok)", () => {
    // The thrash case: playhead 6.0, ring 6.083..6.467, pump origin 6.0. The
    // 83ms gap is absorbed → no ring-clearing restart.
    expect(pumpDecision(6.0, 6.083, 6.467, 6.0, LA)).toBe("ok");
  });
});

describe("FrameRing.coversFrom", () => {
  it("returns +Infinity when empty", () => {
    expect(new FrameRing<string>(4).coversFrom()).toBe(Infinity);
  });

  it("returns the earliest buffered timestamp", () => {
    const r = new FrameRing<string>(4);
    r.push(2, "c");
    r.push(0, "a");
    r.push(1, "b");
    expect(r.coversFrom()).toBe(0);
  });

  it("advances as the oldest entry is evicted past capacity", () => {
    const r = new FrameRing<string>(2);
    r.push(0, "a");
    r.push(1, "b");
    r.push(2, "c"); // "a" (ts 0) evicted
    expect(r.coversFrom()).toBe(1);
  });
});
