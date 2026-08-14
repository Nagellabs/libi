// @vitest-environment jsdom
/**
 * useTransport — Phase-2 playback readiness gate (idle → armed → buffering →
 * playing).
 *
 * Covers:
 *  - press-play when NOT ready → enters `buffering` (playhead stays frozen,
 *    `playing` false so downstream consumers don't advance)
 *  - → `playing` once the probe reports the START_MARGIN runway
 *  - → `playing` on the MAX_GATE_MS cap even if the probe NEVER reports ready
 *    (the no-hang guarantee)
 *  - pass-through: already-warm play → `playing` immediately, never buffering
 *  - no probe wired → play is instant (legacy behavior)
 *  - re-buffer only after a SUSTAINED underrun (a brief dip stays playing)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useTransport,
  START_MARGIN,
  START_MARGIN_DROP,
  MAX_GATE_MS,
  REBUFFER_THRESHOLD,
  REBUFFER_GRACE_MS,
  GATE_POLL_MS,
} from "@/hooks/preview/use-transport";
import type { ReadyDecision } from "@/lib/preview/ready-state";

/** Build a probe decision from the dominant runway (all-can-paint by default). */
const decide = (dominantRunway: number, allCanPaint = true): ReadyDecision => ({
  allCanPaint,
  dominantId: "dom",
  dominantRunway,
});

describe("useTransport readiness gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("no probe → play is instant (never buffers)", () => {
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100, fps: 30 }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");
    expect(result.current.playing).toBe(true);
    expect(result.current.buffering).toBe(false);
  });

  it("already-warm probe → play is instant, never enters buffering", () => {
    const getReadyAhead = vi.fn(() => decide(START_MARGIN + 5));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");
    expect(result.current.buffering).toBe(false);
  });

  it("not-ready probe → buffering, playhead frozen, then playing once margin met", () => {
    let runway = 0; // cold
    const getReadyAhead = vi.fn(() => decide(runway));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, getReadyAhead }),
    );

    act(() => result.current.play());
    // Cold → buffering. `playing` is false so downstream stays frozen.
    expect(result.current.phase).toBe("buffering");
    expect(result.current.playing).toBe(false);

    // Advance time a couple of poll intervals — still cold, still buffering,
    // and the frame must NOT have advanced (playhead frozen during the gate).
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");
    expect(result.current.getFrame()).toBe(0);

    // The window warms up; next poll releases to playing.
    runway = START_MARGIN + 1;
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS); });
    expect(result.current.phase).toBe("playing");
    expect(result.current.playing).toBe(true);

    // Now that it's playing, the rAF tick advances the frame.
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current.getFrame()).toBeGreaterThan(0);
  });

  it("releases to playing on the MAX_GATE_MS cap even if never ready (no-hang)", () => {
    const getReadyAhead = vi.fn(() => decide(0)); // ALWAYS cold
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("buffering");

    // Just before the cap, still buffering.
    act(() => { vi.advanceTimersByTime(MAX_GATE_MS - GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");

    // Past the cap → forced to playing (play possibly-soft, never hang).
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS * 3); });
    expect(result.current.phase).toBe("playing");
    expect(result.current.playing).toBe(true);
  });

  it("pause from buffering returns to idle and frees the gate", () => {
    const getReadyAhead = vi.fn(() => decide(0));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("buffering");
    act(() => result.current.pause());
    expect(result.current.phase).toBe("idle");
    // Advancing time must not flip it back to playing after a pause.
    act(() => { vi.advanceTimersByTime(MAX_GATE_MS * 2); });
    expect(result.current.phase).toBe("idle");
  });

  it("re-buffers only after a SUSTAINED underrun (a brief dip stays playing)", () => {
    let runway = START_MARGIN + 5;
    const getReadyAhead = vi.fn(() => decide(runway));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");

    // A brief dip below threshold, then recover BEFORE the grace elapses.
    runway = REBUFFER_THRESHOLD - 0.05;
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS); });
    runway = START_MARGIN + 5; // recovered
    act(() => { vi.advanceTimersByTime(REBUFFER_GRACE_MS); });
    expect(result.current.phase).toBe("playing"); // never flapped

    // A SUSTAINED dip past the grace → re-buffer.
    runway = REBUFFER_THRESHOLD - 0.05;
    act(() => { vi.advanceTimersByTime(REBUFFER_GRACE_MS + GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");
  });

  // ── Drop-frames model ─────────────────────────────────────────────────────
  it("releases at the small START_MARGIN_DROP margin (below the old START_MARGIN)", () => {
    // A dominant runway between START_MARGIN_DROP and START_MARGIN used to HOLD
    // the gate; now it releases (the faster jump-then-play start).
    expect(START_MARGIN_DROP).toBeLessThan(START_MARGIN);
    const runway = (START_MARGIN_DROP + START_MARGIN) / 2;
    const getReadyAhead = vi.fn(() => decide(runway));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");
  });

  it("gate HOLDS while any source would paint black, even with a healthy dominant", () => {
    // Dominant has plenty of runway, but a secondary can't paint yet (cold) →
    // releasing would flash black, so the gate must hold until all-can-paint.
    let ok = false;
    const getReadyAhead = vi.fn(() => decide(START_MARGIN + 5, ok));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("buffering");
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");
    // The cold secondary paints its first frame → all-can-paint → release.
    ok = true;
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS); });
    expect(result.current.phase).toBe("playing");
  });

  it("a black/dropping SECONDARY does NOT re-buffer while the dominant stays healthy", () => {
    // allCanPaint flips false (a small PIP is dropping frames / briefly black) but
    // the DOMINANT runway stays healthy → the whole comp must keep playing.
    let allCanPaint = true;
    const getReadyAhead = vi.fn(() => decide(START_MARGIN + 5, allCanPaint));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");

    allCanPaint = false; // secondary drops frames
    act(() => { vi.advanceTimersByTime(REBUFFER_GRACE_MS + GATE_POLL_MS * 3); });
    expect(result.current.phase).toBe("playing"); // never re-buffered on a secondary
  });

  it("re-buffers when the DOMINANT itself starves (runway -1) regardless of secondaries", () => {
    let runway = START_MARGIN + 5;
    const getReadyAhead = vi.fn(() => decide(runway, true));
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100000, fps: 30, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");

    runway = -1; // dominant can't paint a live frame
    act(() => { vi.advanceTimersByTime(REBUFFER_GRACE_MS + GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");
  });
});
