/**
 * T3 (2026-09-25): a preview clip that can't be played SAYS so — it never sits
 * on "Buffering…" forever.
 *
 *   - a permanent failure (HTTP 4xx, codec, demux) stops the source: no retry
 *     loop, one console line, `failure()` reports it, the owner is told to
 *     repaint (the renderer then draws the placeholder);
 *   - a proxy that fails permanently falls back to the ORIGINAL once;
 *   - a transient failure (5xx / network) retries on a bounded backoff and
 *     recovers when the server comes back — and gives up when it doesn't.
 *
 * mediabunny is mocked: `Input` resolves or rejects per URL from `behaviour`,
 * and a `CanvasSink` that yields one frame lets us prove the source decodes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Behaviour = "ok" | { error: Error } | "no-decode";
/** Per-URL queue of outcomes; the last entry repeats. */
const behaviour = new Map<string, Behaviour[]>();
const constructed: string[] = [];

function httpError(url: string, status: number, text: string): Error {
  return new Error(`Error fetching ${url}: ${status} ${text}`);
}

vi.mock("mediabunny", () => {
  class UrlSource {
    constructor(public url: string) {}
  }
  class Input {
    private url: string;
    constructor(opts: { source: UrlSource }) {
      this.url = opts.source.url;
      constructed.push(this.url);
    }
    async getPrimaryVideoTrack() {
      const q = behaviour.get(this.url) ?? ["ok"];
      const b = q.length > 1 ? q.shift()! : q[0];
      if (b === "ok") return { getDisplayHeight: async () => 720, getCodec: async () => "avc", getDecoderConfig: async () => ({ codec: "avc1.640028" }), canDecode: async () => true };
      if (b === "no-decode") return { getDisplayHeight: async () => 720, getCodec: async () => "hevc", getDecoderConfig: async () => ({ codec: "hvc1.1.6.L93" }), canDecode: async () => false };
      throw b.error;
    }
    dispose() {}
  }
  class CanvasSink {
    async getCanvas(t: number) {
      return { timestamp: t, canvas: { tag: `frame@${t}`, width: 1, height: 1 } };
    }
    async *canvases(from: number) {
      yield { timestamp: from, canvas: { tag: `frame@${from}`, width: 1, height: 1 } };
    }
  }
  return { Input, UrlSource, CanvasSink, ALL_FORMATS: [], Logging: { on: () => () => {} } };
});

import { MediaBunnyFrameSource } from "@/lib/engine/media-bunny-frame-source";
import { TRANSIENT_RETRY_DELAYS_SEC } from "@/lib/engine/media-load-failure";

const PROXY = "/api/files/by-id/f1/proxy";
const ORIGINAL = "/api/files/by-id/f1/content";

/** Let every queued microtask / promise chain settle. */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  behaviour.clear();
  constructed.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The source touches performance.now() for telemetry and document for the
  // blank canvas; neither exists in node by default in every runner.
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0 }),
  });
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MediaBunnyFrameSource — a clip that can't be played", () => {
  it("HTTP 400 with no fallback: marks the source failed, logs ONE line, repaints once, and stops retrying", async () => {
    behaviour.set(ORIGINAL, [{ error: httpError(ORIGINAL, 400, "Bad Request") }]);
    const source = new MediaBunnyFrameSource(ORIGINAL, 1080);
    const repaint = vi.fn();
    source.onFrame(repaint);
    await settle();

    expect(source.failure()).toEqual({ kind: "permanent", message: expect.stringContaining("400") });
    expect(repaint).toHaveBeenCalledTimes(1);

    // The renderer keeps asking every tick — none of it may re-request the URL
    // or print another line (that was hundreds of `decode pump failed` lines).
    for (let i = 0; i < 30; i++) {
      source.play();
      source.seek(i / 10);
      source.warm(i / 10);
      await source.prime(i / 10);
    }
    await settle();
    expect(constructed).toEqual([ORIGINAL]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(source.isReadyAt(0)).toBe(false);
    source.dispose();
  });

  it("proxy 400 + original OK: falls back to the original once and decodes it", async () => {
    behaviour.set(PROXY, [{ error: httpError(PROXY, 400, "Bad Request") }]);
    behaviour.set(ORIGINAL, ["ok"]);
    const source = new MediaBunnyFrameSource(PROXY, 1080, { fallbackUrl: ORIGINAL });
    await source.prime(1.5);
    await settle();

    expect(constructed).toEqual([PROXY, ORIGINAL]);
    expect(source.failure()).toBeNull();
    expect(source.isReadyAt(1.5)).toBe(true);
    source.dispose();
  });

  it("proxy AND original fail permanently: failed after exactly one fallback", async () => {
    behaviour.set(PROXY, [{ error: httpError(PROXY, 404, "Not Found") }]);
    behaviour.set(ORIGINAL, ["no-decode"]);
    const source = new MediaBunnyFrameSource(PROXY, 1080, { fallbackUrl: ORIGINAL });
    await settle();
    expect(constructed).toEqual([PROXY, ORIGINAL]);
    expect(source.failure()?.kind).toBe("permanent");
    expect(source.failure()?.message).toMatch(/decode/i);
    source.dispose();
  });

  it("503 once, then OK: retries after a short backoff and recovers", async () => {
    vi.useFakeTimers();
    behaviour.set(ORIGINAL, [{ error: httpError(ORIGINAL, 503, "Service Unavailable") }, "ok"]);
    const source = new MediaBunnyFrameSource(ORIGINAL, 1080);
    const primed = source.prime(0.5);
    await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAYS_SEC[0] * 1000 + 50);
    await primed;
    expect(constructed).toEqual([ORIGINAL, ORIGINAL]);
    expect(source.failure()).toBeNull();
    expect(source.isReadyAt(0.5)).toBe(true);
    source.dispose();
  });

  it("a server that stays down: bounded retries, then failed (transient) — never an endless loop", async () => {
    vi.useFakeTimers();
    behaviour.set(ORIGINAL, [{ error: httpError(ORIGINAL, 503, "Service Unavailable") }]);
    const source = new MediaBunnyFrameSource(ORIGINAL, 1080);
    const total = TRANSIENT_RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);
    await vi.advanceTimersByTimeAsync(total * 1000 + 500);
    expect(constructed).toHaveLength(1 + TRANSIENT_RETRY_DELAYS_SEC.length);
    expect(source.failure()?.kind).toBe("transient");
    // Nothing further is scheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(constructed).toHaveLength(1 + TRANSIENT_RETRY_DELAYS_SEC.length);
    expect(warn).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it("a user seek gives a transient failure one fresh try", async () => {
    vi.useFakeTimers();
    behaviour.set(ORIGINAL, [{ error: httpError(ORIGINAL, 503, "Service Unavailable") }]);
    const source = new MediaBunnyFrameSource(ORIGINAL, 1080);
    const total = TRANSIENT_RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);
    await vi.advanceTimersByTimeAsync(total * 1000 + 500);
    expect(source.failure()?.kind).toBe("transient");

    behaviour.set(ORIGINAL, ["ok"]);
    source.hardSeek(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(source.failure()).toBeNull();
    expect(source.isReadyAt(2)).toBe(true);
    source.dispose();
  });

  it("a permanent failure is NOT retried by a user seek", async () => {
    behaviour.set(ORIGINAL, [{ error: httpError(ORIGINAL, 400, "Bad Request") }]);
    const source = new MediaBunnyFrameSource(ORIGINAL, 1080);
    await settle();
    source.hardSeek(1);
    await settle();
    expect(constructed).toEqual([ORIGINAL]);
    expect(source.failure()?.kind).toBe("permanent");
    source.dispose();
  });

  it("dispose during a pending retry cancels it", async () => {
    vi.useFakeTimers();
    behaviour.set(ORIGINAL, [{ error: httpError(ORIGINAL, 503, "Service Unavailable") }]);
    const source = new MediaBunnyFrameSource(ORIGINAL, 1080);
    await vi.advanceTimersByTimeAsync(1);
    source.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(constructed).toEqual([ORIGINAL]);
  });
});
