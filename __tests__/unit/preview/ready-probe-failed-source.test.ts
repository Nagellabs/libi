/**
 * T3 (2026-09-25): the playback readiness gate must not wait on a video that
 * can't be played. A FAILED source is left out of the active set, so the rest
 * of the piece plays (the failed clip shows its placeholder) — before, its
 * never-ready source held the gate and re-buffered every few seconds.
 */
import { describe, it, expect } from "vitest";
import { probeReadyAhead } from "@/lib/preview/ready-probe";
import type { VideoFrameSource, VideoFrameSourceFailure } from "@/lib/engine/video-frame-source";
import type { Composition } from "@/lib/engine/types";

function src(opts: { ready: boolean; runway: number; failure?: VideoFrameSourceFailure | null }): VideoFrameSource {
  return {
    getFrame: () => ({}) as CanvasImageSource,
    seek: () => {}, play: () => {}, pause: () => {}, dispose: () => {},
    isReadyAt: () => opts.ready,
    bufferedThrough: (t: number) => t + opts.runway,
    lastGoodFrame: () => null,
    failure: () => opts.failure ?? null,
  };
}

function video(id: string, startTime: number, duration: number, area = 1): unknown {
  return {
    id, kind: "video", fileId: `f-${id}`, startTime, duration, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 1080 * area, height: 1920 },
  };
}

function comp(overlays: unknown[]): Composition {
  return { id: "c", name: "c", width: 1080, height: 1920, fps: 30, overlays } as unknown as Composition;
}

describe("probeReadyAhead", () => {
  it("a lone FAILED clip does not gate: nothing active is left, so playback proceeds", () => {
    const d = probeReadyAhead(comp([video("a", 0, 5)]), {
      a: src({ ready: false, runway: 0, failure: { kind: "permanent", message: "400" } }),
    }, 1);
    expect(d.allCanPaint).toBe(true);
    expect(d.dominantRunway).toBe(Infinity);
  });

  it("a failed clip alongside a healthy one: the gate follows the healthy one", () => {
    const d = probeReadyAhead(
      comp([video("a", 0, 5, 1), video("b", 0, 5, 0.3)]),
      {
        a: src({ ready: false, runway: 0, failure: { kind: "permanent", message: "400" } }),
        b: src({ ready: true, runway: 2 }),
      },
      1,
    );
    expect(d.dominantId).toBe("b");
    expect(d.allCanPaint).toBe(true);
    expect(d.dominantRunway).toBe(2);
  });

  it("a merely-not-ready (loading) clip still gates, as before", () => {
    const d = probeReadyAhead(comp([video("a", 0, 5)]), { a: src({ ready: false, runway: 0 }) }, 1);
    expect(d.allCanPaint).toBe(false);
    expect(d.dominantRunway).toBe(-1);
  });

  it("an unregistered source still reads as black (the startup race)", () => {
    const d = probeReadyAhead(comp([video("a", 0, 5)]), {}, 1);
    expect(d.allCanPaint).toBe(false);
  });

  it("no composition → nothing gates", () => {
    expect(probeReadyAhead(null, {}, 0).dominantRunway).toBe(Infinity);
  });
});
