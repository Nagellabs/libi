/**
 * T3 fix round 1: a permanent mid-stream error in ONE decode (here the prime)
 * tears the input down and falls back to the original. Another decode still
 * iterating the old sink (the pump) then rejects with mediabunny's
 * InputDisposedError. That rejection is the teardown's echo, not a new failure:
 * it must not print a "decode failed" line, and must not be judged against the
 * replacement source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PROXY = "/api/files/by-id/f1/proxy";
const ORIGINAL = "/api/files/by-id/f1/content";
const constructed: string[] = [];

vi.mock("mediabunny", () => {
  class InputDisposedError extends Error {
    constructor() {
      super("Input has been disposed.");
      this.name = "InputDisposedError";
    }
  }
  class UrlSource {
    constructor(public url: string) {}
  }
  class Input {
    url: string;
    disposed = false;
    onDispose: Array<() => void> = [];
    constructor(opts: { source: UrlSource }) {
      this.url = opts.source.url;
      constructed.push(this.url);
    }
    async getPrimaryVideoTrack() {
      return { getDisplayHeight: async () => 720, getCodec: async () => "avc", getDecoderConfig: async () => ({ codec: "avc1.640028" }), canDecode: async () => true, input: this };
    }
    dispose() {
      this.disposed = true;
      for (const fn of this.onDispose) fn();
    }
  }
  class CanvasSink {
    private input: Input;
    constructor(track: { input: Input }) {
      this.input = track.input;
    }
    async getCanvas(t: number) {
      if (this.input.url === PROXY) {
        const e = new Error("Decoding error.");
        e.name = "EncodingError";
        throw e;
      }
      return { timestamp: t, canvas: { width: 1, height: 1 } };
    }
    async *canvases(from: number) {
      yield { timestamp: from, canvas: { width: 1, height: 1 } };
      if (this.input.url === PROXY) {
        // Park until the input is torn down, then fail the way mediabunny does.
        await new Promise<void>((resolve) => this.input.onDispose.push(resolve));
        throw new InputDisposedError();
      }
    }
  }
  return { Input, UrlSource, CanvasSink, ALL_FORMATS: [], Logging: { on: () => () => {} } };
});

import { MediaBunnyFrameSource } from "@/lib/engine/media-bunny-frame-source";

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

let warn: { mock: { calls: unknown[][] }; mockRestore(): void };
beforeEach(() => {
  constructed.length = 0;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0 }) });
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
});

describe("MediaBunnyFrameSource — teardown race after a mid-stream permanent error", () => {
  it("the pump's InputDisposedError from the torn-down proxy is ignored; the source falls back and plays", async () => {
    const source = new MediaBunnyFrameSource(PROXY, 1080, { fallbackUrl: ORIGINAL });
    source.warm(0); // pump starts on the proxy sink and parks after one frame
    await settle();
    await source.prime(1); // EncodingError on the proxy → fall back to the original
    await settle();

    expect(constructed).toEqual([PROXY, ORIGINAL]);
    expect(source.failure()).toBeNull();
    const lines: string[] = warn.mock.calls.map((c) => c.join(" "));
    expect(lines.some((l) => /decode failed/.test(l))).toBe(false);
    expect(lines.some((l) => /disposed/i.test(l))).toBe(false);
    expect(lines.filter((l) => /trying/.test(l))).toHaveLength(1);
    source.dispose();
  });
});
