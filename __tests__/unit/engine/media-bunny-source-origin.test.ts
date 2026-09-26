/**
 * MediaBunnyFrameSource reads a file whose timestamps don't start at 0 from its
 * own start (Review M6). mediabunny reports raw timestamps. A clip cut from a
 * stream can start at 1.5 s, while its ffmpeg-made proxy and the export
 * (`ffmpeg -ss`) both count from the file's start. Without the origin, falling
 * back from the proxy to such an original jumps the picture 1.5 s, and the
 * original's audio (web-audio-engine) would disagree with its own video.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGIN = 1.5;
const canvasesFrom: number[] = [];
const getCanvasAt: number[] = [];

vi.mock("mediabunny", () => {
  class UrlSource {
    constructor(public url: string) {}
  }
  class Input {
    constructor(public opts: { source: UrlSource }) {}
    async getFirstTimestamp() {
      return ORIGIN;
    }
    async getPrimaryVideoTrack() {
      return { getDisplayHeight: async () => 720, getCodec: async () => "avc", getDecoderConfig: async () => ({ codec: "avc1.640028" }), canDecode: async () => true };
    }
    dispose() {}
  }
  class CanvasSink {
    async getCanvas(t: number) {
      getCanvasAt.push(t);
      return { timestamp: Math.max(t, ORIGIN), canvas: { width: 1, height: 1 } };
    }
    async *canvases(from: number) {
      canvasesFrom.push(from);
      yield { timestamp: Math.max(from, ORIGIN), canvas: { width: 1, height: 1 } };
    }
  }
  return { Input, UrlSource, CanvasSink, ALL_FORMATS: [], Logging: { on: () => () => {} } };
});

import { MediaBunnyFrameSource } from "@/lib/engine/media-bunny-frame-source";

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

beforeEach(() => {
  canvasesFrom.length = 0;
  getCanvasAt.length = 0;
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0 }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MediaBunnyFrameSource on a file that starts at 1.5 s", () => {
  it("a seek to source time 2 decodes raw 3.5, and the frame is served at 2", async () => {
    const source = new MediaBunnyFrameSource("/api/files/by-id/f/content", 1080);
    await source.prime(2);
    await settle();
    expect(getCanvasAt).toEqual([2 + ORIGIN]);
    expect(source.isReadyAt(2)).toBe(true);
    source.dispose();
  });

  it("the pump decodes from raw origin + from", async () => {
    const source = new MediaBunnyFrameSource("/api/files/by-id/f/content", 1080);
    source.warm(0);
    await settle();
    expect(canvasesFrom).toEqual([ORIGIN]);
    expect(source.isReadyAt(0)).toBe(true);
    source.dispose();
  });
});
