import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { falVideoUnderstandingProvider } from "@/lib/analysis/script-providers/fal-video-understanding";

const SAMPLE_OUTPUT = JSON.stringify({
  schema_version: "script_v1",
  duration: 5,
  overall_style: "cinematic",
  shots: [{ index: 0, start: 0, end: 5, description: "shot" }],
  music: { present: false },
});

vi.mock("@/lib/analysis/script-providers/fal-api-key", () => ({
  readFalApiKey: vi.fn(async () => "key-abc"),
}));

vi.mock("@fal-ai/client", () => ({
  fal: {
    config: vi.fn(),
    // fal.storage.upload is no longer called by the provider; the two-step
    // initiate+PUT pattern is used instead so the filename is preserved.
  },
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: vi.fn(async () => Buffer.from("fake-mp4-bytes")) },
}));

vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(async () => ({ stdout: "", stderr: "", durationMs: 1 })),
}));

const STORAGE_INITIATE_URL =
  "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const STORAGE_PUT_URL = "https://v3b.fal.media/upload/test.mp4";
const CDN_FINAL_URL = "https://v3b.fal.media/files/abc/test.mp4";

/** Build a fetch mock that handles the full flow: initiate → PUT → submit → poll → result. */
function buildHappyFetch(): typeof fetch {
  let pollCount = 0;
  return (vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.toString()
          : (url as Request).url;

    if (u === STORAGE_INITIATE_URL && init?.method === "POST") {
      return new Response(
        JSON.stringify({ upload_url: STORAGE_PUT_URL, file_url: CDN_FINAL_URL }),
        { status: 200 },
      );
    }
    if (u === STORAGE_PUT_URL && init?.method === "PUT") {
      return new Response("", { status: 200 });
    }
    if (u.endsWith("/fal-ai/video-understanding") && init?.method === "POST") {
      return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
    }
    if (u.includes("/requests/req-1/status")) {
      pollCount += 1;
      const status = pollCount >= 2 ? "COMPLETED" : "IN_PROGRESS";
      return new Response(JSON.stringify({ status }), { status: 200 });
    }
    if (u.endsWith("/requests/req-1")) {
      return new Response(JSON.stringify({ output: SAMPLE_OUTPUT }), { status: 200 });
    }
    if (u.startsWith("https://api.fal.ai/v1/models/billing-events")) {
      // Default happy-path: billing endpoint returns a real cost on the
      // first call so the provider doesn't have to poll.
      return new Response(
        JSON.stringify({
          billing_events: [{ cost_estimate_nano_usd: 83_200_000 }],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown) as typeof fetch;
}

describe("falVideoUnderstandingProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = buildHappyFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("isConfigured is true when readFalApiKey returns a key", async () => {
    expect(await falVideoUnderstandingProvider.isConfigured()).toBe(true);
  });

  it("uploads via two-step CDN, submits, polls until COMPLETED, then returns the result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const progress: string[] = [];

    const promise = falVideoUnderstandingProvider.generate({
      localPath: "/tmp/fake.mp4",
      durationSeconds: 5,
      promptInstructions: "do the thing",
      onProgress: (n) => progress.push(n),
    });

    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;

    expect(result.providerName).toBe("fal-video-understanding");
    expect(result.modelId).toBe("gemini-2.5-pro");
    expect(result.text).toBe(SAMPLE_OUTPUT);
    // generate() no longer fetches cost (deferred to the user-initiated
    // refresh-cost endpoint). It DOES return the requestId so we can look
    // it up later.
    expect(result.requestId).toBe("req-1");
    expect(progress.some((n) => n.toLowerCase().includes("upload"))).toBe(true);
    expect(
      progress.some(
        (n) =>
          n.toLowerCase().includes("submit") ||
          n.toLowerCase().includes("queued") ||
          n.toLowerCase().includes("in_progress"),
      ),
    ).toBe(true);
  });

  it("fetchRealCostUsd resolves the dollar amount when fal billing publishes a non-zero cost", async () => {
    globalThis.fetch = (vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      if (u.startsWith("https://api.fal.ai/v1/models/billing-events")) {
        return new Response(
          JSON.stringify({ billing_events: [{ cost_estimate_nano_usd: 83_200_000 }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown) as typeof fetch;
    const outcome = await falVideoUnderstandingProvider.fetchRealCostUsd?.({ requestId: "req-1" });
    expect(outcome).toEqual({ kind: "resolved", amountUsd: 0.0832 });
  });

  it("fetchRealCostUsd passes an explicit start window derived from generatedAt (fal defaults start to 24h ago)", async () => {
    let requestedUrl = "";
    globalThis.fetch = (vi.fn(async (url: string | URL | Request) => {
      requestedUrl = typeof url === "string" ? url : (url as Request).url;
      return new Response(JSON.stringify({ billing_events: [] }), { status: 200 });
    }) as unknown) as typeof fetch;
    await falVideoUnderstandingProvider.fetchRealCostUsd?.({
      requestId: "req-1",
      generatedAt: "2026-06-11T12:00:00.000Z",
    });
    const start = new URL(requestedUrl).searchParams.get("start");
    // generatedAt minus the 7-day skew margin.
    expect(start).toBe("2026-06-04T12:00:00.000Z");
  });

  it("fetchRealCostUsd is pending when billing_events is empty (not yet published)", async () => {
    globalThis.fetch = (vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      if (u.startsWith("https://api.fal.ai/v1/models/billing-events")) {
        return new Response(JSON.stringify({ billing_events: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown) as typeof fetch;
    const outcome = await falVideoUnderstandingProvider.fetchRealCostUsd?.({ requestId: "req-1" });
    expect(outcome).toEqual({ kind: "pending" });
  });

  it("fetchRealCostUsd is pending when cost_estimate_nano_usd === 0 (treated as not-yet-populated)", async () => {
    globalThis.fetch = (vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      if (u.startsWith("https://api.fal.ai/v1/models/billing-events")) {
        return new Response(
          JSON.stringify({ billing_events: [{ cost_estimate_nano_usd: 0 }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown) as typeof fetch;
    const outcome = await falVideoUnderstandingProvider.fetchRealCostUsd?.({ requestId: "req-1" });
    expect(outcome).toEqual({ kind: "pending" });
  });

  it("fetchRealCostUsd is forbidden on HTTP 403 (API-scoped key; billing needs ADMIN scope)", async () => {
    globalThis.fetch = (vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { type: "authorization_error", message: "This API key is not permitted to perform this action." } }),
        { status: 403 },
      )) as unknown) as typeof fetch;
    const outcome = await falVideoUnderstandingProvider.fetchRealCostUsd?.({ requestId: "req-1" });
    expect(outcome?.kind).toBe("forbidden");
    expect((outcome as { message: string }).message).toMatch(/ADMIN-scoped/);
  });

  it("estimateCostUsd returns duration × $0.002/s", () => {
    expect(falVideoUnderstandingProvider.estimateCostUsd?.({ durationSeconds: 30 })).toBeCloseTo(0.06, 6);
    expect(falVideoUnderstandingProvider.estimateCostUsd?.({ durationSeconds: 5 })).toBeCloseTo(0.01, 6);
    expect(falVideoUnderstandingProvider.estimateCostUsd?.({ durationSeconds: 0 })).toBe(0);
  });

  it("remuxes unsupported video extensions (.mkv) to .mp4 before upload", async () => {
    const { runFfmpeg } = await import("@/lib/ffmpeg/exec");
    (runFfmpeg as ReturnType<typeof vi.fn>).mockClear();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const progress: string[] = [];

    const promise = falVideoUnderstandingProvider.generate({
      localPath: "/tmp/video.mkv",
      durationSeconds: 5,
      promptInstructions: "do the thing",
      onProgress: (n) => progress.push(n),
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await promise;

    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    const callArgs = (runFfmpeg as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toContain("-i");
    expect(callArgs[0]).toContain("/tmp/video.mkv");
    expect(callArgs[0]).toContain("-c");
    expect(callArgs[0]).toContain("copy");
    expect(callArgs[1].op).toBe("script_analysis_remux");
    expect(progress.some((n) => n.toLowerCase().includes("remux"))).toBe(true);
  });

  it("does NOT remux when the source extension is already supported (.mp4)", async () => {
    const { runFfmpeg } = await import("@/lib/ffmpeg/exec");
    (runFfmpeg as ReturnType<typeof vi.fn>).mockClear();

    vi.useFakeTimers({ shouldAdvanceTime: true });

    const promise = falVideoUnderstandingProvider.generate({
      localPath: "/tmp/video.mp4",
      durationSeconds: 5,
      promptInstructions: "do the thing",
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await promise;

    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("throws on FAILED status", async () => {
    globalThis.fetch = (vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as Request).url;
      if (u === STORAGE_INITIATE_URL && init?.method === "POST") {
        return new Response(
          JSON.stringify({ upload_url: STORAGE_PUT_URL, file_url: CDN_FINAL_URL }),
          { status: 200 },
        );
      }
      if (u === STORAGE_PUT_URL && init?.method === "PUT") {
        return new Response("", { status: 200 });
      }
      if (u.endsWith("/fal-ai/video-understanding") && init?.method === "POST") {
        return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
      }
      if (u.includes("/status")) {
        return new Response(
          JSON.stringify({ status: "FAILED", error: "bad input" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown) as typeof fetch;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const promise = falVideoUnderstandingProvider.generate({
      localPath: "/tmp/fake.mp4",
      durationSeconds: 5,
      promptInstructions: "do the thing",
    });
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(promise).rejects.toThrow(/fal job failed/i);
  });
});
