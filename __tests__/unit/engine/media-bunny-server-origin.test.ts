/**
 * Both mediabunny frame sources take the file's start from the server
 * (`/timing`, ffprobe's start_time) rather than mediabunny's first timestamp,
 * and the preview one never waits for it (review round 2, I1 and M1).
 *
 * The fixture shape is the reviewer's sub-early.mkv: the video starts at
 * 1.0 s and a subtitle at 0.6 s, so ffprobe's start_time is 0.6 while
 * mediabunny's first timestamp is 1.0. The ffmpeg-overlay export and the proxy
 * count from 0.6. The canvas export now does too: its video moves 400 ms onto
 * them (measured in Electron: drift -400 ms -> 0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MB_FIRST = 1.0;
const canvasesFrom: number[] = [];
const getCanvasAt: number[] = [];
/** Whether each getFirstTimestamp ran inside an attribution region (review round 3, R3-M1). */
const firstTimestampInRegion: boolean[] = [];
let inRegion = false;

vi.mock("@/lib/engine/sps-diagnostics", () => ({
  attributeMediaLogs: async <T,>(_key: string, fn: () => Promise<T>) => {
    inRegion = true;
    try {
      return await fn();
    } finally {
      inRegion = false;
    }
  },
}));

vi.mock("mediabunny", () => {
  class UrlSource {
    constructor(public url: string) {}
  }
  class Input {
    constructor(public opts: { source: UrlSource }) {}
    async getFirstTimestamp() {
      firstTimestampInRegion.push(inRegion);
      return MB_FIRST;
    }
    async getPrimaryVideoTrack() {
      return { getDisplayHeight: async () => 720, getCodec: async () => "avc", getDecoderConfig: async () => ({ codec: "avc1.640028" }), canDecode: async () => true };
    }
    dispose() {}
  }
  class CanvasSink {
    async getCanvas(t: number) {
      getCanvasAt.push(t);
      return { timestamp: t, canvas: { width: 1, height: 1 } };
    }
    async *canvases(from: number) {
      canvasesFrom.push(from);
      yield { timestamp: from, canvas: { width: 1, height: 1 } };
    }
  }
  return { Input, UrlSource, CanvasSink, ALL_FORMATS: [], Logging: { on: () => () => {} } };
});

import { MediaBunnyExportFrameSource } from "@/lib/engine/media-bunny-export-frame-source";
import { MediaBunnyFrameSource } from "@/lib/engine/media-bunny-frame-source";
import { clearServerTimingForTest } from "@/lib/engine/source-time-origin";

const URL_ = "/api/files/by-id/sub-early/content";
const answer = (startTime: number) => new Response(JSON.stringify({ startTime, audioCodecDelay: 0 }));

beforeEach(() => {
  canvasesFrom.length = 0;
  getCanvasAt.length = 0;
  firstTimestampInRegion.length = 0;
  clearServerTimingForTest();
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0 }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("the canvas export's video origin (M1)", () => {
  it("is ffprobe's start (0.6 s), not mediabunny's first timestamp (1.0 s)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(0.6)));
    const src = new MediaBunnyExportFrameSource(URL_);
    await src.whenReady();
    await src.seekAndDecode(0.5);
    expect(canvasesFrom).toEqual([1.1]); // source 0.5 = raw 0.6 + 0.5
    src.dispose();
  });

  it("falls back to mediabunny's first timestamp when the server can't say", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const src = new MediaBunnyExportFrameSource(URL_);
    await src.whenReady();
    await src.seekAndDecode(0.5);
    expect(canvasesFrom).toEqual([1.5]);
    src.dispose();
  });
});

describe("the preview frame source never waits for the server (I1)", () => {
  it("a lookup that never answers: ready at once, on mediabunny's first timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const src = new MediaBunnyFrameSource(URL_, 1080);
    await src.prime(0.5);
    expect(src.isReadyAt(0.5)).toBe(true);
    expect(getCanvasAt).toEqual([1.5]); // raw 1.0 + 0.5
    src.dispose();
  });

  it("an answer that lands later re-primes on the server's origin", async () => {
    let reply!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { reply = r; })));
    const src = new MediaBunnyFrameSource(URL_, 1080);
    await src.prime(0.5);
    reply(answer(0.6));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(getCanvasAt).toEqual([1.5, 1.1]); // re-primed on raw 0.6 + 0.5
    expect(src.isReadyAt(0.5)).toBe(true);
    src.dispose();
  });
});

describe("an MPEG-TS SPS parse in the first read is attributed (review round 3, R3-M1)", () => {
  // In MPEG-TS, reading the first timestamp lists the tracks, and listing them
  // parses the video's HEVC SPS: it must run inside the attribution region
  // (sps-diagnostics.ts), or mediabunny's bare line reaches the console.
  it("both frame sources read the first timestamp inside the region", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const preview = new MediaBunnyFrameSource(URL_, 1080);
    await preview.prime(0.5);
    const exp = new MediaBunnyExportFrameSource(URL_);
    await exp.whenReady();
    expect(firstTimestampInRegion.length).toBeGreaterThanOrEqual(2);
    expect(firstTimestampInRegion.every(Boolean)).toBe(true);
    preview.dispose();
    exp.dispose();
  });
});

describe("a failed lookup is asked again (review round 3)", () => {
  it("the preview source asks again on a user seek once the back-off has passed, and takes the answer", async () => {
    const { LOOKUP_BACKOFF_MS } = await import("@/lib/engine/source-time-origin");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(answer(0.6));
    vi.stubGlobal("fetch", fetchMock);
    const src = new MediaBunnyFrameSource(URL_, 1080);
    await src.prime(0.5);
    expect(getCanvasAt).toEqual([1.5]); // the fallback: mediabunny's 1.0
    src.hardSeek(0.5); // too soon: not asked again
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + LOOKUP_BACKOFF_MS[0] + 10);
    src.hardSeek(0.5);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCanvasAt.at(-1)).toBeCloseTo(1.1, 9); // re-primed on the server's 0.6
    spy.mockRestore();
    src.dispose();
  });
});
