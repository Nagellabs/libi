/**
 * Integration test: SAM2 fal.ai backend via JobManager using the
 * tracking_provider runner.
 *
 * Stubs out the SAM2 backend entirely; exercises the real runner dispatch
 * logic + JobManager + completion flow end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Module mocks (must be declared before any imports that pull from those paths)
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

// Stub the SAM2 backend to return canned samples without hitting fal.ai.
// The stub also emits one synthetic progress tick (50/100, "%") so that the
// runner-level progress assertion can verify events were forwarded.
vi.mock("@/lib/tracking/sam2-fal-backend", () => ({
  runSam2FalBackend: vi.fn().mockImplementation(async (ctx: { reportProgress: (done: number, total: number, unit: string) => void }) => {
    ctx.reportProgress(50, 100, "%");
    return {
      samples: Array.from({ length: 10 }, (_, i) => ({
        t: i / 30,
        x: 10 + i,
        y: 20 + i,
        w: 50,
        h: 60,
        confidence: 0.95,
        visible: true,
        subjectId: null,
      })),
      framerate: 30,
    };
  }),
}));

// Stub mediapipe runner (not needed for tracking_provider path)
vi.mock("@/lib/tracking/mediapipe-runner", () => ({
  runFaceTracker: vi.fn(),
  runObjectTracker: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getDb } from "@/lib/db/client";
import { createTestDb } from "../../helpers/test-db";
import { __resetRunnerRegistryForTests, registerRunner } from "@/lib/jobs/runners/registry";
import { JobManager } from "@/lib/jobs/manager";
import { jobIdOf } from "../../helpers/enqueue";
import { trackingProviderRunner } from "@/lib/jobs/runners/tracking-provider";
import { runSam2FalBackend } from "@/lib/tracking/sam2-fal-backend";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("SAM2 tracking via JobManager — tracking_provider runner (integration)", () => {
  let tmp: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    __resetRunnerRegistryForTests();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-sam2-integ-"));
    process.env.LIBI_HOME = tmp;

    registerRunner(trackingProviderRunner);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  afterEach(() => {
    delete process.env.LIBI_HOME;
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("enqueue tracking_provider job with provider:sam2-fal → dispatches sam2-fal backend, job completes with 10 samples", async () => {
    const mgr = new JobManager();
    const progress: number[] = [];

    const jobId = jobIdOf(await mgr.enqueue("tracking_provider", {
      fileId: "file-1",
      pieceId: "piece-1",
      fileUrl: "http://127.0.0.1:3000/api/files/by-id/file-1/content",
      fps: 30,
      objectKind: "object",
      anchors: [{ fileId: "file-1", time: 0, bbox: [10, 20, 50, 60] }],
      provider: "sam2-fal",
    }));

    const result = await mgr.runToCompletion<{
      samples: Array<{ t: number; x: number; y: number; w: number; h: number; visible: boolean }>;
      framerate: number;
    }>(jobId, (p) => progress.push(p.done));

    // Verify the sam2-fal backend was invoked
    expect(vi.mocked(runSam2FalBackend)).toHaveBeenCalledOnce();

    // Verify result shape
    expect(result.samples.length).toBe(10);
    expect(result.framerate).toBe(30);

    // Verify the job completed in DB
    const snap = await mgr.getStatus(jobId);
    expect(snap.status).toBe("completed");

    // Verify progress events were emitted (runner must emit at least once)
    expect(progress.length).toBeGreaterThan(0);
  });

  it("job status is completed after successful run", async () => {
    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("tracking_provider", {
      fileId: "file-2",
      pieceId: "piece-2",
      fileUrl: "http://127.0.0.1:3000/api/files/by-id/file-2/content",
      fps: 30,
      objectKind: "object",
      anchors: [{ fileId: "file-2", time: 0, bbox: [0, 0, 10, 10] }],
      provider: "sam2-fal",
    }));

    await mgr.runToCompletion(jobId);

    const snap = await mgr.getStatus(jobId);
    expect(snap.status).toBe("completed");
    expect(snap.error).toBeNull();
  });
});
