/**
 * sourceTimeOrigin: where a file's source time 0 sits on the raw timestamps
 * mediabunny reports. libi's source time 0 is the file's start as ffmpeg
 * defines it (`format.start_time`): the ffmpeg CLI rebases every input by it,
 * so `-ss`, the export mix's `atrim` and every ffmpeg-made proxy count from
 * there (Review M6).
 *
 * mediabunny reports raw timestamps on ffmpeg's packet timeline but skips no
 * encoder delay, so a gapless MP3 (LAME: 0.025 s) or Apple AAC file (iTunSMPB)
 * played that much late in the preview (Electron 36, 2026-09-25). For a file's
 * content URL the server says (`/timing`); otherwise, and when that lookup
 * fails, the file's first timestamp clamped at 0, so AAC priming (-0.161 s on
 * the Dreams original) shifts nothing.
 *
 * audioTimelineShift: a Matroska track's CodecDelay, read from the file's
 * metadata. Never inferred from first packets: on an MP4 stream-copied at a
 * non-keyframe that put the audio 302 ms late (review round 2, C1).
 *
 * The lookup never delays playback (review I1). A failed one is asked again
 * on the next play or seek once its back-off has passed, a bounded number of
 * times per page; a slow answer is taken when it comes (review round 3).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sourceTimeOrigin,
  fallbackOrigin,
  originFromTiming,
  audioTimelineShift,
  timingUrlFor,
  serverTiming,
  clearServerTimingForTest,
  ifSettled,
  retryServerTiming,
  LOOKUP_TIMEOUT_MS,
  LOOKUP_BACKOFF_MS,
  MAX_LOOKUP_ATTEMPTS,
  type ServerTiming,
} from "@/lib/engine/source-time-origin";

const input = (first: number | (() => Promise<number>)) => ({
  getFirstTimestamp: typeof first === "function" ? first : async () => first,
});
const answer = (startTime: number | null, audioCodecDelay = 0): ServerTiming => ({
  startTime, audioCodecDelay, audioPadding: 0, audioStart: null, oggFirstPacket: null, oggFirstPacketDuration: 0, opusTrims: [], preferProxyAudio: false,
});
const timing = (startTime: number | null, audioCodecDelay = 0) => async () => answer(startTime, audioCodecDelay);
const CONTENT = "/api/files/by-id/f1/content";

describe("the fallback origin (a proxy, a test URL, a failed lookup)", () => {
  it("is the file's first timestamp when positive", async () => {
    expect(await fallbackOrigin(input(1.478))).toBe(1.478);
    expect(await sourceTimeOrigin(input(1.478))).toBe(1.478);
  });
  it("ignores AAC priming (a negative first timestamp)", async () => {
    expect(await fallbackOrigin(input(-0.161))).toBe(0);
  });
  it("is 0 when the input can't say (a test double, a read error)", async () => {
    expect(await fallbackOrigin({})).toBe(0);
    expect(await fallbackOrigin(input(async () => { throw new Error("read"); }))).toBe(0);
    expect(await fallbackOrigin(input(Number.NaN))).toBe(0);
  });
  it("is used when the server has no start (WAV) or fails", async () => {
    expect(await sourceTimeOrigin(input(0.5), CONTENT, timing(null))).toBe(0.5);
    expect(await sourceTimeOrigin(input(0.5), CONTENT, async () => null)).toBe(0.5);
  });
});

describe("the server's start time", () => {
  it("a LAME MP3 starts at 0.025 s although mediabunny's first packet is at 0", async () => {
    expect(await sourceTimeOrigin(input(0), CONTENT, timing(0.025057))).toBe(0.025057);
  });
  it("an Apple AAC file (iTunSMPB) starts at 2112 samples", async () => {
    expect(await sourceTimeOrigin(input(0), CONTENT, timing(0.047891))).toBe(0.047891);
  });
  it("AAC priming behind an edit list shifts nothing (the Dreams clip, and a stream-copied cut: ffmpeg says 0)", async () => {
    expect(await sourceTimeOrigin(input(-0.161), CONTENT, timing(0))).toBe(0);
    expect(await sourceTimeOrigin(input(-1.3232), CONTENT, timing(0))).toBe(0);
  });
  it("a negative start is clamped, like the fallback", async () => {
    expect(originFromTiming(answer(-0.0065))).toBe(0);
    expect(originFromTiming(null)).toBeNull();
  });
});

describe("audioTimelineShift: the Matroska CodecDelay, from the file's metadata only", () => {
  it("an MP3 in MKV is shifted by its CodecDelay", () => {
    expect(audioTimelineShift("mp3", answer(0, 0.025057))).toBe(0.025057);
  });
  it("is 0 for every other container (the server sends 0), for Opus, and without an answer", () => {
    expect(audioTimelineShift("aac", answer(0))).toBe(0);
    expect(audioTimelineShift("opus", answer(0, 0.0065))).toBe(0);
    expect(audioTimelineShift("aac", null)).toBe(0);
  });
});

describe("the timing lookup", () => {
  beforeEach(() => {
    clearServerTimingForTest();
    vi.unstubAllGlobals();
  });

  it("only a file's content URL has one", () => {
    expect(timingUrlFor("/api/files/by-id/abc/content")).toBe("/api/files/by-id/abc/timing");
    expect(timingUrlFor("http://127.0.0.1:3456/api/files/by-id/abc/content?x=1")).toBe("http://127.0.0.1:3456/api/files/by-id/abc/timing");
    expect(timingUrlFor("/api/files/by-id/abc/proxy")).toBeNull();
    expect(timingUrlFor("blob:whatever")).toBeNull();
  });

  it("asks once per file", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ startTime: 0.025057, audioCodecDelay: 0, url })));
    vi.stubGlobal("fetch", fetchMock);
    const a = await serverTiming(CONTENT);
    const b = await serverTiming(CONTENT);
    expect(a).toEqual(answer(0.025057));
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/files/by-id/f1/timing");
  });

  it("a failure is shared, not retried by itself: serverTiming asks once", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await serverTiming(CONTENT)).toBeNull();
    expect(await serverTiming(CONTENT)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed lookup is asked again after its back-off, up to MAX_LOOKUP_ATTEMPTS per page (review round 3)", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => (++n < 3 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(answer(0.025057)))));
    vi.stubGlobal("fetch", fetchMock);
    expect(await serverTiming(CONTENT)).toBeNull();
    const t0 = Date.now();
    // Too soon: nothing asked.
    expect(retryServerTiming(CONTENT, t0 + LOOKUP_BACKOFF_MS[0] - 100)).toBeNull();
    expect(await retryServerTiming(CONTENT, t0 + LOOKUP_BACKOFF_MS[0] + 10)).toBeNull(); // 2nd attempt: 503 again
    expect(retryServerTiming(CONTENT, Date.now() + LOOKUP_BACKOFF_MS[1] - 100)).toBeNull();
    expect(await retryServerTiming(CONTENT, Date.now() + LOOKUP_BACKOFF_MS[1] + 10)).toEqual(answer(0.025057)); // 3rd: answered
    // Answered: shared from now on, never asked again.
    expect(retryServerTiming(CONTENT, Date.now() + 1e9)).toBeNull();
    expect(await serverTiming(CONTENT)).toEqual(answer(0.025057));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_LOOKUP_ATTEMPTS);
  });

  it("stops after MAX_LOOKUP_ATTEMPTS failures", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("network"); });
    vi.stubGlobal("fetch", fetchMock);
    await serverTiming(CONTENT);
    for (let i = 0; i < 5; i++) await retryServerTiming(CONTENT, Date.now() + 1e9);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_LOOKUP_ATTEMPTS);
  });

  it("a body that isn't JSON, or whose read fails, may be asked again (review round 4)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not json</html>", { status: 200 })));
    expect(await serverTiming(CONTENT)).toBeNull();
    expect(retryServerTiming(CONTENT, Date.now() + 1e9)).not.toBeNull();
    clearServerTimingForTest();
    const broken = { ok: true, status: 200, json: async () => { throw new DOMException("body timed out", "TimeoutError"); } };
    vi.stubGlobal("fetch", vi.fn(async () => broken as unknown as Response));
    expect(await serverTiming(CONTENT)).toBeNull();
    expect(retryServerTiming(CONTENT, Date.now() + 1e9)).not.toBeNull();
  });

  it("a 4xx is final: never asked again", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await serverTiming(CONTENT)).toBeNull();
    expect(retryServerTiming(CONTENT, Date.now() + 1e9)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a slow answer is taken when it comes: nothing is cut off at the old 1.5 s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(answer(0.6)))), 4000))));
    const pending = serverTiming(CONTENT);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await ifSettled(pending, "pending")).toBe("pending");
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toEqual(answer(0.6));
    vi.useRealTimers();
  });

  it("a server that never answers gives up after its timeout (LOOKUP_TIMEOUT_MS by default), and may be asked again", async () => {
    expect(LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
    })));
    const pending = serverTiming(CONTENT, 150);
    expect(await ifSettled(pending, "pending")).toBe("pending");
    expect(await pending).toBeNull();
    expect(retryServerTiming(CONTENT, Date.now() + 1e9)).not.toBeNull();
  });

  it("a non-number field is null (the CodecDelay 0)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ startTime: "0.1", audioCodecDelay: null, audioStart: 0.343 }))));
    expect(await serverTiming(CONTENT)).toEqual({ ...answer(null), audioStart: 0.343 });
  });

  it("ifSettled tells a settled promise from a pending one", async () => {
    expect(await ifSettled(Promise.resolve(3), "no")).toBe(3);
    expect(await ifSettled(new Promise(() => {}), "no")).toBe("no");
  });
});
