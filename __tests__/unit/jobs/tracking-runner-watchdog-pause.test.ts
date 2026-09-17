/**
 * The tracking runner maps the tracker's dependency-phase
 * signal onto `ctx.pauseWatchdog()`.
 *
 * `noProgressTimeoutMs: 60_000` is right for the frames phase and wrong for
 * what can run in front of it on a first tracker start: a 33 MB mediapipe
 * model fetch that reports nothing, then a 173 MB Chromium download whose
 * installer emits one progress line per 10 %. On a slow link the watchdog
 * fired mid-download and the user was told tracking had failed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runObjectTracker = vi.hoisted(() => vi.fn());
const runFaceTracker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tracking/mediapipe-runner", () => ({ runObjectTracker, runFaceTracker }));

import { trackingRunner } from "@/lib/jobs/runners/tracking";
import type { TrackingParams } from "@/lib/jobs/runners/tracking";
import type { JobContext } from "@/lib/jobs/types";

interface TrackerOpts {
  onDependencyPhase?: (active: boolean) => void;
  onDownloadProgress?: (p: { doneMb: number; totalMb: number }) => void;
}

/** The mediapipe path — NOT one of the ENGINE_METHODS, which never launch a browser. */
function makeCtx(pauseWatchdog?: () => () => void): JobContext<TrackingParams> {
  return {
    jobId: "job-1",
    params: {
      fileId: "f1",
      pieceId: "p1",
      fileUrl: "/local/clip.mp4",
      fps: 30,
      objectKind: "object",
      method: "mediapipe-object",
      anchors: [],
    } as TrackingParams,
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(),
    shouldCancel: () => false,
    ...(pauseWatchdog ? { pauseWatchdog } : {}),
  };
}

describe("tracking runner — dependency phase pauses the watchdog", () => {
  beforeEach(() => {
    runObjectTracker.mockReset();
    runFaceTracker.mockReset();
  });

  it("holds the pause for the phase and releases it when the phase ends", async () => {
    const release = vi.fn();
    const pauseWatchdog = vi.fn(() => release);
    let opts: TrackerOpts | null = null;
    runObjectTracker.mockImplementation(async (o: TrackerOpts) => {
      opts = o;
      o.onDependencyPhase?.(true);
      o.onDependencyPhase?.(false);
      return { samples: [], framerate: 30 };
    });

    await trackingRunner.run(makeCtx(pauseWatchdog));

    expect(opts).not.toBeNull();
    expect(pauseWatchdog).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("takes ONE pause even if the phase is announced twice", async () => {
    const release = vi.fn();
    const pauseWatchdog = vi.fn(() => release);
    runObjectTracker.mockImplementation(async (o: TrackerOpts) => {
      o.onDependencyPhase?.(true);
      o.onDependencyPhase?.(true);
      o.onDependencyPhase?.(false);
      return { samples: [], framerate: 30 };
    });

    await trackingRunner.run(makeCtx(pauseWatchdog));

    // A second pause with only one release would leave the watchdog suspended
    // for the whole frames phase — the thing it is there to police.
    expect(pauseWatchdog).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("works against a context that has no pauseWatchdog (hand-built test ctxs)", async () => {
    runObjectTracker.mockImplementation(async (o: TrackerOpts) => {
      o.onDependencyPhase?.(true);
      o.onDependencyPhase?.(false);
      return { samples: [], framerate: 30 };
    });

    await expect(trackingRunner.run(makeCtx())).resolves.toMatchObject({ framerate: 30 });
  });

  it("declares the 60 s watchdog it is compensating for", () => {
    expect(trackingRunner.noProgressTimeoutMs).toBe(60_000);
  });
});
