import { describe, it, expect } from "vitest";
import { MediaBunnyFrameSource } from "@/lib/engine/media-bunny-frame-source";
import type { FrameRing } from "@/lib/preview/frame-ring";

/**
 * The seek-landing "extra frames" fix: a discrete user seek/scrub must FLUSH the
 * decode ring + restart the pump from the target, BYPASSING the soft `seek()`'s
 * backward-tolerance — otherwise a WARM source replays the frames its pump
 * decoded ahead of the in-point. The soft `seek()` keeps the tolerance so a
 * non-frame-aligned clip start doesn't thrash-restart during playback.
 *
 * We exercise the real source with a never-resolving URL (init/pump await
 * `this.ready` inside guarded try/catch, so they no-op) and reach into its
 * private ring to assert the flush behavior directly.
 */
function makeSource(): {
  source: MediaBunnyFrameSource;
  ring: FrameRing<unknown>;
} {
  // A bogus URL: init() rejects, swallowed by the constructor's no-op catch and
  // the pump's guarded try/catch. The ring + (hard)seek logic run regardless.
  const source = new MediaBunnyFrameSource("about:blank#no-decode", 1080);
  // Access the private ring to seed/inspect buffered frames deterministically.
  const ring = (source as unknown as { ring: FrameRing<unknown> }).ring;
  return { source, ring };
}

/** Seed a buffered span [from..thru] so the ring is non-empty and covers a
 *  within-tolerance backward target (the warm-source replay condition). */
function seedRing(ring: FrameRing<unknown>, from: number, thru: number, step = 0.1) {
  for (let t = from; t <= thru + 1e-9; t += step) {
    const canvas = { tag: t } as unknown as HTMLCanvasElement;
    ring.push(+t.toFixed(3), canvas);
  }
}

describe("MediaBunnyFrameSource hard-seek vs soft-seek (seek-landing flush)", () => {
  it("soft seek within tolerance does NOT clear the ring (tolerance preserved)", () => {
    const { source, ring } = makeSource();
    // Warm span 6.083..6.467 (pump parked ahead of the in-point). Target 6.0 is
    // a backward gap of 83ms < BACKWARD_RESTART_TOLERANCE_SEC (0.5s).
    seedRing(ring, 6.083, 6.467);
    const before = ring.size();
    expect(before).toBeGreaterThan(0);
    source.seek(6.0);
    // pumpDecision returns "ok"/"wait" — ring is NOT flushed → stale-ahead
    // frames remain (the bug). This is the deliberately-tolerated case.
    expect(ring.size()).toBe(before);
  });

  it("HARD seek within tolerance ALWAYS clears the ring + restarts (the fix)", () => {
    const { source, ring } = makeSource();
    seedRing(ring, 6.083, 6.467);
    expect(ring.size()).toBeGreaterThan(0);
    source.hardSeek(6.0);
    // The discrete user-seek path flushes regardless of tolerance, so getFrame
    // can never serve a stale warm/ahead frame after a jump/scrub.
    expect(ring.size()).toBe(0);
    expect(ring.coversThrough()).toBe(-Infinity);
  });

  it("HARD seek also flushes on a forward target (no tolerance branch survives)", () => {
    const { source, ring } = makeSource();
    seedRing(ring, 2.0, 2.5);
    expect(ring.size()).toBeGreaterThan(0);
    source.hardSeek(2.3); // even an in-window forward target flushes
    expect(ring.size()).toBe(0);
  });
});

/**
 * The paused-seek "jiggle"/scrub-"gif" fix: `playing` (transport) and
 * `decodeAhead` (runway) are decoupled so a warmed-but-paused source doesn't
 * claim it's playing, and a PAUSED hardSeek lands EXACTLY one frame (prime) with
 * NO forward decode-ahead pump — the pump's forward sequence is what the paused
 * settle / scrub walked through as extra frames.
 */
describe("MediaBunnyFrameSource paused-vs-playing hard-seek + flag decoupling", () => {
  function privates(s: MediaBunnyFrameSource) {
    return s as unknown as {
      playing: boolean;
      decodeAhead: boolean;
      pumpFrom: number | null;
    };
  }

  it("warm() builds a runway (decodeAhead) WITHOUT claiming transport playing", () => {
    const { source } = makeSource();
    source.warm(2.0);
    const p = privates(source);
    expect(p.decodeAhead).toBe(true);
    expect(p.playing).toBe(false); // a warmed off-screen source is NOT playing
  });

  it("play() sets both playing AND decodeAhead; pause() clears both", () => {
    const { source } = makeSource();
    source.play();
    expect(privates(source).playing).toBe(true);
    expect(privates(source).decodeAhead).toBe(true);
    source.pause();
    expect(privates(source).playing).toBe(false);
    expect(privates(source).decodeAhead).toBe(false);
  });

  it("PAUSED hardSeek flushes + lands one frame (prime) — does NOT start a pump", () => {
    const { source, ring } = makeSource();
    seedRing(ring, 1.0, 1.5);
    // default transport state is paused (playing=false)
    source.hardSeek(3.0);
    expect(ring.size()).toBe(0); // flushed
    expect(privates(source).pumpFrom).toBeNull(); // no decode-ahead pump started
  });

  it("PLAYING hardSeek flushes AND restarts the decode-ahead pump from the target", () => {
    const { source, ring } = makeSource();
    source.play(); // transport playing
    seedRing(ring, 1.0, 1.5);
    source.hardSeek(3.0);
    expect(ring.size()).toBe(0);
    expect(privates(source).pumpFrom).toBe(3.0); // pump (re)started from target
  });

  it("prime() is single-in-flight: coalesces a scrub BACKLOG to (first, latest) — no gif, no starve", async () => {
    const { source, ring } = makeSource();
    const p = source as unknown as {
      ready: Promise<void>;
      sink: { getCanvas: (t: number) => Promise<{ timestamp: number; canvas: unknown }> };
    };
    // Controllable sink: each getCanvas parks until we resolve it, so we can
    // simulate a fast drag (many prime() calls while ONE decode is in flight).
    const resolvers: Record<number, (v: { timestamp: number; canvas: unknown }) => void> = {};
    const called: number[] = [];
    p.ready = Promise.resolve();
    p.sink = {
      getCanvas: (t: number) => {
        called.push(t);
        return new Promise((res) => {
          resolvers[t] = res;
        });
      },
    };
    const paints: number[] = [];
    source.onFrame(() => paints.push(ring.coversThrough()));

    // A fast drag: prime(1) starts a decode; 2..10 arrive while it's in flight.
    source.prime(1);
    await new Promise((r) => setTimeout(r, 0)); // let the chain reach getCanvas(1)
    for (let t = 2; t <= 10; t++) source.prime(t);

    // Only ONE decode is ever in flight — getCanvas(1) so far, NOT 2..10.
    expect(called).toEqual([1]);

    // Resolve the in-flight decode (pos 1). It paints, then the chain chases the
    // LATEST pending position (10) — the 2..9 in between are coalesced away.
    resolvers[1]({ timestamp: 1, canvas: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toEqual([1, 10]); // chased straight to the newest, skipping 2..9

    resolvers[10]({ timestamp: 10, canvas: {} });
    await new Promise((r) => setTimeout(r, 0));

    // The displayed frames are (start, release) — NOT the whole 1..10 backlog
    // (that backlog replaying is the "gif"); and it never starved waiting.
    expect(paints).toEqual([1, 10]);
    expect(ring.coversThrough()).toBe(10);
  });
});
