import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetRunnerRegistryForTests,
  registerBuiltinRunners,
  getRunner,
} from "@/lib/jobs/runners/registry";
import { trackingProviderRunner } from "@/lib/jobs/runners/tracking-provider";
import { trackingRunner } from "@/lib/jobs/runners/tracking";
import type { TrackingParams } from "@/lib/jobs/runners/tracking";
import type { JobContext } from "@/lib/jobs/types";
import type { TrackingProviderParams } from "@/lib/jobs/runners/tracking-provider";

vi.mock("@/lib/tracking/not-installed", () => ({
  trackingEngineInstalled: () => true,
  trackingNotInstalledError: () => ({ error: "tracking_engine_not_installed" }),
}));
vi.mock("@/lib/tracking/boxmot-runner", () => ({
  runEngineSegment: vi.fn(),
}));
import { runEngineSegment } from "@/lib/tracking/boxmot-runner";
import type {
  EngineSegmentResult,
  IdentityCandidate,
} from "@/lib/tracking/boxmot-runner";

// The SSRF guard resolves DNS for anything that isn't loopback-on-our-own-
// port. Stub it so the http-fetch-to-tempfile tests below control what's
// "public" vs "private" without touching the real network.
const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

// Real `undici` Agent, mocked only so instances carry a `.close()` (called by
// `fetchFollowingVettedRedirects` after every hop) — otherwise the public-url
// test below would throw the moment the guard's dispatcher gets closed.
// Instances are still real, distinct objects per call — what the I1
// dispatcher-identity test needs to compare against.
interface MockAgentInstance {
  __opts: unknown;
  close: () => Promise<void>;
}
vi.mock("undici", () => ({
  Agent: vi.fn(function MockAgent(this: MockAgentInstance, opts: unknown) {
    this.__opts = opts;
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));
import { Agent } from "undici";

describe("trackingRunner registration", () => {
  beforeEach(() => __resetRunnerRegistryForTests());

  it("registers under kind=\"tracking\" with maxConcurrent=1", () => {
    registerBuiltinRunners();
    const r = getRunner("tracking");
    expect(r).toBeTruthy();
    expect(r!.kind).toBe("tracking");
    expect(r!.maxConcurrent).toBe(1);
    expect(r!.resumable).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    registerBuiltinRunners();
    expect(() => registerBuiltinRunners()).not.toThrow();
    expect(getRunner("tracking")).toBeTruthy();
  });
});

describe("trackingRunner paramsSchema — anchors", () => {
  beforeEach(() => __resetRunnerRegistryForTests());

  const base = {
    fileId: "f1",
    pieceId: "p1",
    fileUrl: "http://x/v.mp4",
    fps: 30,
    objectKind: "object" as const,
  };

  it("accepts an EMPTY anchors array (seedless pure-engine recompute — apply-deletes revert)", () => {
    registerBuiltinRunners();
    const schema = getRunner("tracking")!.paramsSchema;
    const r = schema.safeParse({ ...base, anchors: [] });
    expect(r.success).toBe(true);
  });

  it("still accepts a normal seeded anchor and rejects > 100", () => {
    registerBuiltinRunners();
    const schema = getRunner("tracking")!.paramsSchema;
    const one = { fileId: "f1", time: 1, bbox: [1, 2, 3, 4] };
    expect(schema.safeParse({ ...base, anchors: [one] }).success).toBe(true);
    expect(
      schema.safeParse({ ...base, anchors: Array.from({ length: 101 }, () => one) }).success,
    ).toBe(false);
  });
});

describe("trackingRunner — method:\"candidates\" engine passthrough (E1)", () => {
  afterEach(() => {
    vi.mocked(runEngineSegment).mockReset();
  });

  it("routes method:\"candidates\" to the engine and threads candidateTracklets through the result", async () => {
    const candidateTracklets: IdentityCandidate[] = [
      { candidateId: 3, perFrame: [{ t: 22, bbox: [120, 80, 90, 220] }], meanTargetSim: 0.88, frameCount: 1 },
      { candidateId: 7, perFrame: [{ t: 22, bbox: [900, 100, 80, 200] }], meanTargetSim: 0.41, frameCount: 1 },
    ];
    vi.mocked(runEngineSegment).mockResolvedValue({
      samples: [],
      framerate: 30,
      candidateTracklets,
    } satisfies EngineSegmentResult);

    const params: TrackingParams = {
      fileId: "f1",
      pieceId: "p1",
      fileUrl: "/tmp/local.mp4",
      fps: 30,
      objectKind: "object",
      method: "candidates",
      range: { start: 20, end: 25 },
      classes: ["person"],
      anchors: [],
    };

    const ctx = {
      jobId: "job-cand",
      params,
      resumeState: undefined,
      reportProgress: vi.fn(),
      checkpoint: vi.fn(),
      shouldCancel: vi.fn().mockReturnValue(false),
    } satisfies JobContext<TrackingParams>;

    const out = await trackingRunner.run(ctx);

    // Engine path was taken (not MediaPipe), and candidateTracklets survived.
    expect(vi.mocked(runEngineSegment)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runEngineSegment).mock.calls[0][0]).toMatchObject({
      method: "candidates",
    });
    expect(out.samples).toEqual([]);
    expect(out.candidateTracklets).toEqual(candidateTracklets);
  });
});

describe("trackingRunner — http(s) fileUrl SSRF guard (engine http-to-tempfile path)", () => {
  afterEach(() => {
    vi.mocked(runEngineSegment).mockReset();
    vi.unstubAllGlobals();
    lookupMock.mockReset();
    vi.mocked(Agent).mockClear();
    delete process.env.LIBI_PORT;
  });

  function makeCtx(fileUrl: string, jobId: string): JobContext<TrackingParams> {
    const params: TrackingParams = {
      fileId: "f1",
      pieceId: "p1",
      fileUrl,
      fps: 30,
      objectKind: "object",
      method: "candidates", // any ENGINE_METHODS entry takes the http-fetch path
      range: { start: 0, end: 1 },
      classes: ["person"],
      anchors: [],
    };
    return {
      jobId,
      params,
      resumeState: undefined,
      reportProgress: vi.fn(),
      checkpoint: vi.fn(),
      shouldCancel: vi.fn().mockReturnValue(false),
    } satisfies JobContext<TrackingParams>;
  }

  it("refuses a public-looking fileUrl whose DNS answer is a private address, before any fetch happens", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx("http://sneaky-metadata.example/video.mp4", "job-private-fetch");

    await expect(trackingRunner.run(ctx)).rejects.toThrow(/blocked private address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(runEngineSegment)).not.toHaveBeenCalled();
  });

  it("still succeeds with a loopback fileUrl on the app's own port — the legitimate internal caller's shape (regression guard)", async () => {
    // Mirrors lib/tracking/recompute-segment.ts's
    // `http://127.0.0.1:${getCurrentPort()}/api/files/by-id/${fileId}/content`.
    // No LIBI_PORT set → getCurrentPort() falls back to the documented
    // default (3456) — same fallback the fileUrl below targets.
    const videoBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi.fn(async () =>
      new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // The runner unlinks the tmp file in its own `finally` right after
    // runEngineSegment resolves, so read it back from INSIDE the mock (before
    // that cleanup runs) to prove the streamed-to-disk content is real —
    // not just that a path string was passed through.
    let capturedBytes: Buffer | null = null;
    vi.mocked(runEngineSegment).mockImplementation(async (opts) => {
      capturedBytes = fs.readFileSync(opts.videoPath);
      return { samples: [], framerate: 30 } satisfies EngineSegmentResult;
    });

    const ctx = makeCtx(
      "http://127.0.0.1:3456/api/files/by-id/f1/content",
      "job-loopback-fetch",
    );

    const out = await trackingRunner.run(ctx);

    expect(out.samples).toEqual([]);
    // The loopback shape never touches DNS — it's a literal-IP + own-port match.
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runEngineSegment)).toHaveBeenCalledTimes(1);
    // The engine received a LOCAL temp path, not the http(s) url.
    const videoPath = vi.mocked(runEngineSegment).mock.calls[0][0].videoPath;
    expect(videoPath).toBe(path.join(os.tmpdir(), "libitrack-job-loopback-fetch.mp4"));
    // And that temp file held the actual fetched bytes — streamed to disk,
    // not buffered whole via arrayBuffer().
    expect(capturedBytes).toEqual(Buffer.from(videoBytes));
  });

  it("rejects a loopback fileUrl on the WRONG port (not our own app's port)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx(
      "http://127.0.0.1:9999/api/files/by-id/f1/content",
      "job-wrong-port-fetch",
    );

    await expect(trackingRunner.run(ctx)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(runEngineSegment)).not.toHaveBeenCalled();
  });

  it("passes the guard's exact pinned dispatcher into fetch for a genuinely public fileUrl (I1 — proves the DNS-rebinding protection actually reaches the network call)", async () => {
    // Unlike the loopback-own-port case above (which skips DNS/dispatcher
    // entirely), a public fileUrl goes through assertLoopbackOrPublicHttpUrl
    // -> assertPublicHttpUrl, which resolves DNS and mints a pinned Agent.
    lookupMock.mockResolvedValueOnce([{ address: "203.0.113.10", family: 4 }]);
    const videoBytes = new Uint8Array([9, 8, 7]);
    const fetchMock = vi.fn(async () =>
      new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(runEngineSegment).mockImplementation(async () => {
      return { samples: [], framerate: 30 } satisfies EngineSegmentResult;
    });

    const ctx = makeCtx("https://public.example.com/video.mp4", "job-public-fetch");

    const out = await trackingRunner.run(ctx);

    expect(out.samples).toEqual([]);
    const AgentMock = vi.mocked(Agent);
    expect(AgentMock).toHaveBeenCalledTimes(1);
    const pinnedDispatcher = AgentMock.mock.instances[0];

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const dispatcherArg = (
      fetchMock.mock.calls[0][1] as { dispatcher?: unknown } | undefined
    )?.dispatcher;
    // Not just "a dispatcher was present" — the SAME object instance the
    // guard's DNS-pinned Agent constructor produced. A mutation that dropped
    // `dispatcher` from the fetch() call entirely (I1's proof case) makes
    // this `undefined` and fails here.
    expect(dispatcherArg).toBe(pinnedDispatcher);
  });
});

describe("trackingProviderRunner registration", () => {
  beforeEach(() => __resetRunnerRegistryForTests());

  it("registers under kind=\"tracking_provider\" with maxConcurrent=2", () => {
    registerBuiltinRunners();
    const r = getRunner("tracking_provider");
    expect(r).toBeTruthy();
    expect(r!.kind).toBe("tracking_provider");
    expect(r!.maxConcurrent).toBe(2);
    expect(r!.resumable).toBe(true);
  });

  it("tracking and tracking_provider are independently registered", () => {
    registerBuiltinRunners();
    expect(getRunner("tracking")).toBeTruthy();
    expect(getRunner("tracking_provider")).toBeTruthy();
    expect(getRunner("tracking")!.kind).not.toBe(getRunner("tracking_provider")!.kind);
  });
});

describe("trackingProviderRunner — test-mode gate (Fix A)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws providers_disabled_in_test_mode when LIBI_TEST_MODE=1", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");

    const ctx = {
      jobId: "test-job",
      params: {} as TrackingProviderParams,
      resumeState: undefined,
      reportProgress: vi.fn(),
      checkpoint: vi.fn(),
      shouldCancel: vi.fn().mockReturnValue(false),
    } satisfies JobContext<TrackingProviderParams>;

    await expect(trackingProviderRunner.run(ctx)).rejects.toThrow(
      "providers_disabled_in_test_mode",
    );
  });

  it("does not throw the test-mode error when LIBI_TEST_MODE is unset", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "");

    const ctx = {
      jobId: "test-job",
      params: {} as TrackingProviderParams,
      resumeState: undefined,
      reportProgress: vi.fn(),
      checkpoint: vi.fn(),
      shouldCancel: vi.fn().mockReturnValue(false),
    } satisfies JobContext<TrackingProviderParams>;

    // Will fail further down (unknown provider / backend error) — that's fine.
    // We're only asserting the test-mode gate is not triggered.
    await expect(trackingProviderRunner.run(ctx)).rejects.not.toThrow(
      "providers_disabled_in_test_mode",
    );
  });
});
