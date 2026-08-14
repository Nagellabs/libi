// @vitest-environment jsdom
/**
 * useTransport — decode backpressure on the AUDIO-MASTER path.
 *
 * The audio-master clock used to advance unconditionally (the tick returned
 * before the gate and play() went straight to `playing`), so a decode underrun
 * snapped frames. These tests assert the fix: the readiness gate + re-buffer now
 * run under audio-master, and audio (am.play/am.pause) is driven by the resolved
 * phase so audio + video hold together (no drift) while buffering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useTransport,
  START_MARGIN,
  REBUFFER_THRESHOLD,
  REBUFFER_GRACE_MS,
  GATE_POLL_MS,
  type AudioMasterControl,
} from "@/hooks/preview/use-transport";
import type { ReadyDecision } from "@/lib/preview/ready-state";

/** Build a probe decision from the dominant runway (all-can-paint by default). */
const decide = (dominantRunway: number, allCanPaint = true): ReadyDecision => ({
  allCanPaint,
  dominantId: "dom",
  dominantRunway,
});

function makeAm() {
  let t = 0;
  const calls = { play: 0, pause: 0, seek: [] as number[] };
  const am: AudioMasterControl = {
    getTime: () => t,
    play: () => { calls.play++; },
    pause: () => { calls.pause++; },
    seek: (s: number) => { calls.seek.push(s); t = s; },
    setSpeed: () => {},
  };
  return { am, calls, setTime: (v: number) => { t = v; } };
}

describe("useTransport audio-master backpressure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("warm probe → play is instant under audio-master, am.play() called", () => {
    const { am, calls } = makeAm();
    const getReadyAhead = () => decide(START_MARGIN + 5);
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, audioMaster: am, getReadyAhead }),
    );
    const playsBefore = calls.play;
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");
    expect(calls.play).toBeGreaterThan(playsBefore);
  });

  it("cold probe → buffering, audio stays paused, then plays once warm", () => {
    let runway = 0; // cold
    const { am, calls } = makeAm();
    const getReadyAhead = () => decide(runway);
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 1000, fps: 30, audioMaster: am, getReadyAhead }),
    );

    const playsBefore = calls.play;
    act(() => result.current.play());
    // Held — NOT playing, audio not started.
    expect(result.current.phase).toBe("buffering");
    expect(result.current.playing).toBe(false);
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");
    expect(calls.play).toBe(playsBefore); // audio never started while buffering

    // Warm up → release → audio plays.
    runway = START_MARGIN + 1;
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS); });
    expect(result.current.phase).toBe("playing");
    expect(calls.play).toBeGreaterThan(playsBefore);
  });

  it("sustained underrun while playing → buffering + am.pause(); recovery → am.play()", () => {
    let runway = START_MARGIN + 5;
    const { am, calls } = makeAm();
    const getReadyAhead = () => decide(runway);
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100000, fps: 30, audioMaster: am, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");

    const pausesBefore = calls.pause;
    // Sustained dip past the grace → re-buffer (audio must pause to stay synced).
    runway = REBUFFER_THRESHOLD - 0.05;
    act(() => { vi.advanceTimersByTime(REBUFFER_GRACE_MS + GATE_POLL_MS * 2); });
    expect(result.current.phase).toBe("buffering");
    expect(calls.pause).toBeGreaterThan(pausesBefore);

    // Runway recovers → release back to playing → audio resumes.
    const playsBefore = calls.play;
    runway = START_MARGIN + 5;
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS); });
    expect(result.current.phase).toBe("playing");
    expect(calls.play).toBeGreaterThan(playsBefore);
  });

  it("a brief dip does NOT re-buffer (no audio flap)", () => {
    let runway = START_MARGIN + 5;
    const { am } = makeAm();
    const getReadyAhead = () => decide(runway);
    const { result } = renderHook(() =>
      useTransport({ totalFrames: 100000, fps: 30, audioMaster: am, getReadyAhead }),
    );
    act(() => result.current.play());
    expect(result.current.phase).toBe("playing");

    runway = REBUFFER_THRESHOLD - 0.05; // dip
    act(() => { vi.advanceTimersByTime(GATE_POLL_MS); });
    runway = START_MARGIN + 5; // recover before grace
    act(() => { vi.advanceTimersByTime(REBUFFER_GRACE_MS); });
    expect(result.current.phase).toBe("playing");
  });
});
