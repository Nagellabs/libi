import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
// Replace the real Playwright tracker with a fake one that we control.
vi.mock("@/lib/tracking/mediapipe-runner", () => ({
  runFaceTracker: vi.fn(),
  runObjectTracker: vi.fn(),
}));

import { getDb } from "@/lib/db/client";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import { runFaceTracker, type FaceTrackerOpts } from "@/lib/tracking/mediapipe-runner";
import type { TrackSample } from "@/lib/tracking/types";
import { trackingRunner } from "@/lib/jobs/runners/tracking";
import { jobIdOf } from "../../helpers/enqueue";

describe("tracking via JobManager (end-to-end fake runner)", () => {
  let tmp: string;
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-jobs-e2e-"));
    process.env.LIBI_HOME = tmp;
    registerRunner(trackingRunner);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  function fakeTracker(behaviour: {
    failAt?: number;
    cancelAt?: number;
    totalFrames: number;
  }) {
    return async (opts: FaceTrackerOpts) => {
      const samples: TrackSample[] = [...(opts.priorSamples ?? [])];
      const startFrame = opts.startFrame ?? 0;
      for (let i = startFrame; i < behaviour.totalFrames; i++) {
        // Yield to the event loop each frame so cancel signals + scheduled
        // timeouts in the test get a chance to dispatch.
        await new Promise((r) => setImmediate(r));
        if (opts.shouldCancel?.()) break;
        if (behaviour.cancelAt != null && i >= behaviour.cancelAt) break;
        if (behaviour.failAt != null && i === behaviour.failAt) {
          await opts.onCheckpoint?.({ framesDone: i, partialSamples: samples });
          throw new Error("fake runner failure");
        }
        samples.push({
          t: i / 30,
          x: i,
          y: 0,
          w: 10,
          h: 10,
          confidence: 0.9,
          visible: true,
        });
        if (i % 30 === 0) opts.onProgress?.(i + 1, behaviour.totalFrames);
        if (i % 90 === 0 && i > 0) {
          await opts.onCheckpoint?.({ framesDone: i + 1, partialSamples: samples });
        }
      }
      // Final progress emit so listeners see done === total (bypasses the
      // JobManager's 1s debounce since done >= total).
      opts.onProgress?.(samples.length, behaviour.totalFrames);
      return { samples, framerate: 30 };
    };
  }

  it("happy path: emits progress, completes, no resume needed", async () => {
    vi.mocked(runFaceTracker).mockImplementation(fakeTracker({ totalFrames: 300 }));
    const mgr = new JobManager();
    const progress: number[] = [];
    const jobId = jobIdOf(await mgr.enqueue("tracking", {
      fileId: "f", pieceId: "p", fileUrl: "/api/files/by-id/f/content",
      fps: 30, objectKind: "face",
      anchors: [{ fileId: "f", time: 0, bbox: [0, 0, 10, 10] }],
    }));
    const result = await mgr.runToCompletion<{ samples: TrackSample[]; framerate: number }>(
      jobId,
      (p) => progress.push(p.done),
    );
    expect(result.samples.length).toBe(300);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(300);
  });

  it("server restart mid-job: first run fails at frame 150, second run resumes from checkpoint", async () => {
    vi.mocked(runFaceTracker).mockImplementation(fakeTracker({ failAt: 150, totalFrames: 300 }));
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("tracking", {
      fileId: "f", pieceId: "p", fileUrl: "/api/files/by-id/f/content",
      fps: 30, objectKind: "face",
      anchors: [{ fileId: "f", time: 0, bbox: [0, 0, 10, 10] }],
    }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/fake runner/);

    // Re-flip status to queued for retry (simulating the agent re-enqueueing).
    const { jobs } = await import("@/lib/db/schema/sqlite");
    const { eq } = await import("drizzle-orm");
    vi.mocked(getDb)().update(jobs).set({ status: "queued", error: null }).where(eq(jobs.id, jobId)).run();

    // Second run: no failure this time.
    vi.mocked(runFaceTracker).mockImplementation(fakeTracker({ totalFrames: 300 }));
    const result = await mgr.runToCompletion<{ samples: TrackSample[] }>(jobId);
    // The runner resumed from priorSamples (frame 0..149) + continued from 150 to 299.
    // Note: the runner produces frames startFrame..totalFrames-1, so total samples >= 300.
    expect(result.samples.length).toBeGreaterThanOrEqual(300);
    // First sample is from frame 0 (preserved from priorSamples).
    expect(result.samples[0]).toMatchObject({ x: 0 });
  });

  it("cancel mid-job: partial samples persisted; state file remains for resume", async () => {
    // Use a fake that checkpoints every frame so the partial state file is
    // guaranteed to exist before cancel lands — avoids timing flakes.
    vi.mocked(runFaceTracker).mockImplementation(async (opts: FaceTrackerOpts) => {
      const samples: TrackSample[] = [...(opts.priorSamples ?? [])];
      const startFrame = opts.startFrame ?? 0;
      const total = 300;
      for (let i = startFrame; i < total; i++) {
        await new Promise((r) => setImmediate(r));
        if (opts.shouldCancel?.()) break;
        samples.push({ t: i / 30, x: i, y: 0, w: 10, h: 10, confidence: 0.9, visible: true });
        // Checkpoint every frame so cancel always finds a state file.
        await opts.onCheckpoint?.({ framesDone: i + 1, partialSamples: samples });
        opts.onProgress?.(i + 1, total);
      }
      return { samples, framerate: 30 };
    });
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("tracking", {
      fileId: "f", pieceId: "p", fileUrl: "/api/files/by-id/f/content",
      fps: 30, objectKind: "face",
      anchors: [{ fileId: "f", time: 0, bbox: [0, 0, 10, 10] }],
    }));

    // Cancel only AFTER the runner has checkpointed at least once. We
    // subscribe to progress events and fire cancel from inside the handler —
    // by that point the runner's own `await opts.onCheckpoint(...)` for the
    // same frame has already written state.json.
    let cancelled = false;
    const cancelPromise = mgr.runToCompletion(jobId, () => {
      if (!cancelled) {
        cancelled = true;
        void mgr.cancel(jobId).catch(() => {});
      }
    }).catch((e) => e);
    await cancelPromise;

    const snap = await mgr.getStatus(jobId);
    expect(snap.status).toBe("cancelled");

    // Verify the partial state file exists (preserved for future resume).
    const stateFile = path.join(tmp, "jobs", jobId, "state.json");
    expect(fs.existsSync(stateFile)).toBe(true);
  });
});
