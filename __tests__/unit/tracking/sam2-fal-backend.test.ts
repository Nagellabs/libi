import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CancelledError } from "@/lib/jobs/types";

// ---------------------------------------------------------------------------
// Module mocks (must be before any imports that pull from those paths)
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn() }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      createReadStream: vi.fn(),
      statSync: vi.fn().mockReturnValue({ size: 1024 }),
    },
    createReadStream: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
  };
});

import { getDb } from "@/lib/db/client";
import { getStorage } from "@/lib/storage";
import { createReadStream, statSync } from "node:fs";
import { createTestDb } from "../../helpers/test-db";
import {
  runSam2FalBackend,
  type FalClient,
  type Sam2BackendParams,
  type Sam2FalBackendDeps,
} from "@/lib/tracking/sam2-fal-backend";
import type { JobContext } from "@/lib/jobs/types";
import { eq } from "drizzle-orm";
import { pieces, files } from "@/lib/db/schema/sqlite";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<Sam2BackendParams> = {}): Sam2BackendParams {
  return {
    fileId: "file-1",
    pieceId: "piece-1",
    fileUrl: "http://127.0.0.1:3000/api/files/by-id/file-1/content",
    fps: 30,
    objectKind: "object",
    anchors: [{ fileId: "file-1", time: 0, bbox: [10, 20, 50, 60] }],
    ...overrides,
  };
}

function makeCtx(overrides: {
  params?: Partial<Sam2BackendParams>;
  shouldCancel?: () => boolean;
  reportProgress?: (done: number, total: number, unit?: string) => void;
} = {}): JobContext<Sam2BackendParams> {
  return {
    jobId: "job-1",
    params: makeParams(overrides.params),
    resumeState: null,
    reportProgress: overrides.reportProgress ?? vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(undefined),
    shouldCancel: overrides.shouldCancel ?? (() => false),
  };
}

function makeFilesDbSeed(db: ReturnType<typeof createTestDb>) {
  db.insert(pieces).values({ id: "piece-1", name: "Test Piece" }).run();
  db.insert(files)
    .values({
      id: "file-1",
      pieceId: "piece-1",
      filename: "video.mp4",
      name: "Video",
      description: "Test video",
      type: "video/mp4",
      storagePath: "piece-1/video.mp4",
      contentType: "video/mp4",
      size: 1000,
    })
    .run();
}

/**
 * Verified 2026-05-14: fal.ai SAM2 result shape.
 * The model returns a mask video URL, NOT per-frame JSON bboxes.
 * GET response_url → { video: { url, content_type, file_name, file_size },
 *                       boundingbox_frames_zip?: { url, ... } | null }
 */
const MOCK_FAL_RESULT = {
  video: {
    url: "https://fal.media/files/test/output.mp4",
    content_type: "application/octet-stream",
    file_name: "output0.mp4",
    file_size: 193509,
  },
  boundingbox_frames_zip: null,
};

/**
 * Stub for the pixel-scanning bbox extractor so tests never hit ffmpeg or the network.
 * Returns two visible frames representing t=0 and t=1/30.
 */
const STUB_EXTRACT_BBOXES: Sam2FalBackendDeps["extractBboxesFromMaskVideo"] = vi
  .fn()
  .mockResolvedValue([
    { frameIndex: 0, t: 0, x: 10, y: 20, w: 50, h: 60 },
    { frameIndex: 1, t: 1 / 30, x: 11, y: 21, w: 50, h: 60 },
  ]);

/**
 * Stub for the ffprobe-based frame-info probe so tests never spawn a real ffprobe
 * subprocess. Under vi.useFakeTimers(), the real probeFrameInfo blocks on execFile
 * (an OS-level async that isn't advanced by fake timers), which prevents sleep() in
 * the poll loop from being scheduled before vi.runAllTimersAsync() runs, causing
 * every test that reaches the poll loop to time out.
 *
 * Returns safe fallback bounds identical to probeFrameInfo's own error fallback.
 */
const STUB_PROBE_FRAME_INFO: Sam2FalBackendDeps["probeFrameInfo"] = vi
  .fn()
  .mockResolvedValue({ w: 1920, h: 1080, totalFrames: 1800, fps: 30 });

function makeFalClient(overrides: Partial<FalClient> = {}): FalClient {
  return {
    uploadFile: vi.fn().mockResolvedValue({ url: "https://v3b.fal.media/files/video.mp4" }),
    submitJob: vi.fn().mockResolvedValue({
      request_id: "req-1",
      // Verified 2026-05-14: submit response shape from live API
      status_url: "https://queue.fal.run/fal-ai/sam2/requests/req-1/status",
      response_url: "https://queue.fal.run/fal-ai/sam2/requests/req-1",
      cancel_url: "https://queue.fal.run/fal-ai/sam2/requests/req-1/cancel",
    }),
    // Verified 2026-05-14: status values are IN_QUEUE | IN_PROGRESS | COMPLETED
    pollStatus: vi.fn().mockResolvedValue({ status: "COMPLETED", progress: 100 }),
    // Verified 2026-05-14: result is { video: { url, ... }, boundingbox_frames_zip }
    fetchResult: vi.fn().mockResolvedValue(MOCK_FAL_RESULT),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runSam2FalBackend", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(getStorage).mockResolvedValue({
      localPath: vi.fn().mockReturnValue("/tmp/piece-1/video.mp4"),
      save: vi.fn(),
      read: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      delete: vi.fn(),
      deletePieceDir: vi.fn(),
    });
    vi.mocked(createReadStream).mockReturnValue({ pipe: vi.fn(), on: vi.fn() } as never);
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as never);
    vi.mocked(STUB_EXTRACT_BBOXES as ReturnType<typeof vi.fn>).mockClear();
    makeFilesDbSeed(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws fal_ai_not_configured when loadFalKey rejects", async () => {
    const ctx = makeCtx();
    const fal = makeFalClient();
    await expect(
      runSam2FalBackend(ctx, {
        falClient: fal,
        loadFalKey: async () => {
          throw new Error("fal_ai_not_configured");
        },
        extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
      }),
    ).rejects.toThrow("fal_ai_not_configured");
  });

  it("happy path: uploads, submits, polls, extracts bboxes, and returns samples", async () => {
    const progress: Array<[number, number, string?]> = [];
    const ctx = makeCtx({
      reportProgress: (done, total, unit) => progress.push([done, total, unit]),
    });
    const fal = makeFalClient();

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    const result = await runPromise;

    expect(fal.uploadFile).toHaveBeenCalledOnce();
    expect(fal.submitJob).toHaveBeenCalledOnce();
    expect(fal.pollStatus).toHaveBeenCalled();
    expect(fal.fetchResult).toHaveBeenCalled();
    expect(STUB_EXTRACT_BBOXES).toHaveBeenCalledWith(
      MOCK_FAL_RESULT.video.url,
      expect.objectContaining({ fps: 30 }),
    );

    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.framerate).toBe(30);
    // First sample comes from the stub extractor (frameIndex=0)
    const s0 = result.samples[0];
    expect(s0.visible).toBe(true);
    expect(s0.x).toBe(10);
    expect(s0.y).toBe(20);
    expect(s0.w).toBe(50);
    expect(s0.h).toBe(60);
  });

  it("submits box_prompts with x_min/y_min/x_max/y_max field names (not a flat array)", async () => {
    // Verified 2026-05-14: fal.ai uses box_prompts: [{x_min, y_min, x_max, y_max, frame_index}]
    // NOT the legacy `prompts` array or flat [x1, y1, x2, y2] arrays.
    const ctx = makeCtx({
      params: { anchors: [{ fileId: "file-1", time: 0.5, bbox: [100, 200, 80, 90] }], fps: 10 },
    });
    const fal = makeFalClient();

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      // Use fps: 10 to match ctx.params.fps so frame_index = round(0.5 * 10) = 5.
      // (buildBoxPrompts uses probeFrameInfo's detected fps for frame_index, not params.fps.)
      probeFrameInfo: vi.fn().mockResolvedValue({ w: 1920, h: 1080, totalFrames: 1800, fps: 10 }),
    });
    await vi.runAllTimersAsync();
    await runPromise;

    expect(fal.submitJob).toHaveBeenCalledWith(
      "fal-ai/sam2/video",
      expect.objectContaining({
        box_prompts: [
          {
            x_min: 100,
            y_min: 200,
            x_max: 180, // 100 + 80
            y_max: 290, // 200 + 90
            frame_index: 5, // Math.round(0.5 * 10) with probeFrameInfo fps=10
          },
        ],
      }),
      expect.any(Object),
    );
    // Must NOT include legacy `prompts` or `fps` fields (not in SAM2 schema)
    const callBody = vi.mocked(fal.submitJob).mock.calls[0][1] as Record<string, unknown>;
    expect(callBody).not.toHaveProperty("prompts");
    expect(callBody).not.toHaveProperty("fps");
  });

  it("submits all anchors as separate box_prompts entries for multi-anchor case", async () => {
    // Verified 2026-05-14: multi-anchor — fal.ai accepts multiple box_prompts entries
    const ctx = makeCtx({
      params: {
        anchors: [
          { fileId: "file-1", time: 0, bbox: [10, 20, 50, 60] },
          { fileId: "file-1", time: 1, bbox: [11, 21, 51, 61] },
        ],
        fps: 30,
      },
    });
    const fal = makeFalClient();

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    const result = await runPromise;

    const body = vi.mocked(fal.submitJob).mock.calls[0][1] as { box_prompts: unknown[] };
    expect(body.box_prompts).toHaveLength(2);
    expect(body.box_prompts[0]).toMatchObject({ x_min: 10, y_min: 20, x_max: 60, y_max: 80, frame_index: 0 });
    expect(body.box_prompts[1]).toMatchObject({ x_min: 11, y_min: 21, x_max: 62, y_max: 82, frame_index: 30 });
    expect(result.samples.length).toBeGreaterThan(0);
  });

  it("emits progress ticks when fal returns progress percentage", async () => {
    const progress: Array<[number, number, string?]> = [];
    const ctx = makeCtx({
      reportProgress: (done, total, unit) => progress.push([done, total, unit]),
    });
    let pollCount = 0;
    const fal = makeFalClient({
      pollStatus: vi.fn().mockImplementation(async () => {
        pollCount++;
        if (pollCount === 1) return { status: "IN_PROGRESS", progress: 50 };
        return { status: "COMPLETED" };
      }),
    });

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    await runPromise;

    const progressTicks = progress.filter(([, total, unit]) => total === 100 && unit === "%");
    expect(progressTicks.length).toBeGreaterThan(0);
    expect(progressTicks[0][0]).toBe(50);
  });

  it("cancels fal job and throws CancelledError when shouldCancel returns true after first poll", async () => {
    let pollCalls = 0;
    const fal = makeFalClient({
      pollStatus: vi.fn().mockImplementation(async () => {
        pollCalls++;
        return { status: "IN_PROGRESS", progress: 10 };
      }),
    });

    let cancelled = false;
    const ctx = makeCtx({
      shouldCancel: () => {
        if (pollCalls >= 1) {
          cancelled = true;
          return true;
        }
        return false;
      },
    });

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();

    await expect(runPromise).rejects.toThrow(CancelledError);

    expect(cancelled).toBe(true);
    // Verified 2026-05-14: cancel uses PUT (not DELETE). The mock just records the call.
    expect(fal.cancel).toHaveBeenCalledWith(
      "https://queue.fal.run/fal-ai/sam2/requests/req-1/cancel",
      { key: "fake-key" },
    );
  });

  it("throws when fal result has no video.url", async () => {
    // Verified 2026-05-14: result MUST have video.url — if fal API changes shape
    // the backend should throw a descriptive error.
    const fal = makeFalClient({
      fetchResult: vi.fn().mockResolvedValue({ video: null }),
    });
    const ctx = makeCtx();

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();

    await expect(runPromise).rejects.toThrow(/video\.url/);
  });

  it("produces invisible samples for frames where extractor returns null", async () => {
    // Extractor returns null for a frame = no masked pixel found = invisible
    const extractWithInvisible: Sam2FalBackendDeps["extractBboxesFromMaskVideo"] = vi
      .fn()
      .mockResolvedValue([
        { frameIndex: 0, t: 0, x: 10, y: 20, w: 50, h: 60 },
        null, // frame 1 invisible
        { frameIndex: 2, t: 2 / 30, x: 12, y: 22, w: 50, h: 60 },
      ]);

    const ctx = makeCtx();
    const fal = makeFalClient();

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: extractWithInvisible,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    const result = await runPromise;

    expect(result.samples.length).toBe(3);
    expect(result.samples[0].visible).toBe(true);
    expect(result.samples[1].visible).toBe(false);
    expect(result.samples[1].confidence).toBe(0);
    expect(result.samples[2].visible).toBe(true);
  });

  it("cache hit: skips upload when falUploadedUrl is already set on the file row", async () => {
    const cachedUrl = "https://v3b.fal.media/files/cached-video.mp4";
    db.insert(pieces).values({ id: "piece-2", name: "Piece 2" }).run();
    db.insert(files)
      .values({
        id: "file-cached",
        pieceId: "piece-2",
        filename: "cached.mp4",
        name: "Cached Video",
        description: "Already uploaded",
        type: "video/mp4",
        storagePath: "piece-2/cached.mp4",
        contentType: "video/mp4",
        size: 2000,
        falUploadedUrl: cachedUrl,
      })
      .run();

    const fal = makeFalClient();
    const ctx = makeCtx({ params: { fileId: "file-cached", pieceId: "piece-2" } });

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    await runPromise;

    // uploadFile must NOT be called — URL came from DB
    expect(fal.uploadFile).not.toHaveBeenCalled();
    // The cached URL should be passed to submitJob as video_url
    expect(fal.submitJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ video_url: cachedUrl }),
      expect.any(Object),
    );
  });

  it("persist-after-upload: writes falUploadedUrl to DB after successful upload", async () => {
    const uploadedUrl = "https://v3b.fal.media/files/new-upload.mp4";
    const fal = makeFalClient({
      uploadFile: vi.fn().mockResolvedValue({ url: uploadedUrl }),
    });
    const ctx = makeCtx({ params: { fileId: "file-1", pieceId: "piece-1" } });

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    await runPromise;

    expect(fal.uploadFile).toHaveBeenCalledOnce();

    const rows = db.select().from(files).where(eq(files.id, "file-1")).all();
    expect(rows[0].falUploadedUrl).toBe(uploadedUrl);
  });

  it("upload heartbeat: emits progress with bytes-uploaded values during upload", async () => {
    // Simulate the stream emitting data chunks so ctx.reportProgress is called.
    const progress: Array<[number, number, string?]> = [];
    const ctx = makeCtx({
      reportProgress: (done, total, unit) => progress.push([done, total, unit]),
    });

    // Make createReadStream return a stream whose .pipe() pushes chunks into
    // the destination Transform, mirroring real fs.ReadStream behavior. The
    // production code pipes the file stream through a byte-counting Transform
    // and hands the Transform to fetch, so progress comes from _transform.
    const chunkA = Buffer.alloc(512, 1);
    const chunkB = Buffer.alloc(512, 2);
    const fakeStream = {
      pipe: vi.fn().mockImplementation((dest: NodeJS.WritableStream) => {
        dest.write(chunkA);
        dest.write(chunkB);
        dest.end();
        return dest;
      }),
      on: vi.fn().mockImplementation(() => fakeStream),
    };
    vi.mocked(createReadStream).mockReturnValue(fakeStream as never);
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as never);

    const fal = makeFalClient();
    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    await runPromise;

    // Should have received at least two upload-progress events (one per chunk)
    const uploadTicks = progress.filter(([, , unit]) => unit === "bytes");
    expect(uploadTicks.length).toBeGreaterThanOrEqual(2);
    expect(uploadTicks[0]).toEqual([512, 1024, "bytes"]);
    expect(uploadTicks[1]).toEqual([1024, 1024, "bytes"]);
  });

  it("handles FAILED status from fal by throwing a descriptive error", async () => {
    // FAILED is not in the OpenAPI schema enum (verified 2026-05-14) but we handle
    // it defensively in case fal adds it or returns it in error conditions.
    const fal = makeFalClient({
      pollStatus: vi.fn().mockResolvedValue({
        status: "FAILED",
        logs: [{ message: "out of memory" }],
      }),
    });
    const ctx = makeCtx();

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();

    await expect(runPromise).rejects.toThrow(/SAM2 job failed/);
  });

  it("poll-loop cancel fires within 1s even when backoff has grown (T23)", async () => {
    // Verifies that the poll-wait is chunked into ≤1s slices: shouldCancel
    // becomes true mid-wait, and the loop bails out after at most one slice
    // — NOT after the full pollIntervalMs.
    let pollCount = 0;
    const fal = makeFalClient({
      pollStatus: vi.fn().mockImplementation(async () => {
        pollCount++;
        return { status: "IN_PROGRESS", progress: 10 };
      }),
    });

    // shouldCancel returns true only after the second status poll has
    // happened — i.e. when pollIntervalMs has grown past 2_000ms.
    let cancelTriggered = false;
    const ctx = makeCtx({
      shouldCancel: () => {
        if (pollCount >= 2) {
          cancelTriggered = true;
          return true;
        }
        return false;
      },
    });

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    // Drive enough time to reach the second poll + one sliced cancel check.
    await vi.runAllTimersAsync();

    await expect(runPromise).rejects.toThrow(CancelledError);
    expect(cancelTriggered).toBe(true);
    expect(fal.cancel).toHaveBeenCalled();
  });

  it("upload chunk-level cancel triggers CancelledError mid-upload (T23)", async () => {
    // Build a slow-drip stream that emits chunks one at a time. shouldCancel
    // flips true after the first chunk so the Transform errs out on the next.
    const totalChunks = 4;
    let emitted = 0;

    const fakeStream = {
      pipe: vi.fn().mockImplementation((dest: NodeJS.WritableStream) => {
        // Drive synchronously — Transform's cb runs in-tick.
        const writeNext = () => {
          if (emitted >= totalChunks) {
            dest.end();
            return;
          }
          emitted++;
          const ok = dest.write(Buffer.alloc(256));
          if (ok === false) {
            // Wait for drain — should not happen with our fast consumer.
            (dest as NodeJS.EventEmitter).once?.("drain", writeNext);
          } else {
            queueMicrotask(writeNext);
          }
        };
        writeNext();
        return dest;
      }),
      on: vi.fn().mockImplementation(() => fakeStream),
      destroy: vi.fn(),
    };
    vi.mocked(createReadStream).mockReturnValue(fakeStream as never);
    vi.mocked(statSync).mockReturnValue({ size: 1024 } as never);

    let chunksProcessed = 0;
    const ctx = makeCtx({
      shouldCancel: () => chunksProcessed >= 1,
      reportProgress: () => {
        chunksProcessed++;
      },
    });

    // fal.uploadFile should never resolve on a cancelled upload — make it
    // wait on the underlying source. Reject with the body's error when the
    // Transform destroys.
    const fal = makeFalClient({
      uploadFile: vi.fn().mockImplementation(async (body: NodeJS.ReadableStream) => {
        return await new Promise((_resolve, reject) => {
          body.on("error", reject);
          body.on("end", () => _resolve({ url: "https://example.com/never-reached" }));
          body.resume?.();
        });
      }),
    });

    const runPromise = runSam2FalBackend(ctx, {
      falClient: fal,
      loadFalKey: async () => "fake-key",
      extractBboxesFromMaskVideo: STUB_EXTRACT_BBOXES,
      probeFrameInfo: STUB_PROBE_FRAME_INFO,
    });
    await vi.runAllTimersAsync();
    await expect(runPromise).rejects.toThrow(CancelledError);
  });
});

// ---------------------------------------------------------------------------
// Runner config regression tests
// ---------------------------------------------------------------------------

describe("trackingProviderRunner config", () => {
  it("watchdog timeout is 300_000 ms (5 minutes)", async () => {
    const { trackingProviderRunner } = await import(
      "@/lib/jobs/runners/tracking-provider"
    );
    expect(trackingProviderRunner.noProgressTimeoutMs).toBe(300_000);
  });
});
