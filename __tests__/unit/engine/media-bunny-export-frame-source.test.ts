import { describe, it, expect } from "vitest";
import { MediaBunnyExportFrameSource } from "@/lib/engine/media-bunny-export-frame-source";

/** A WrappedCanvas-shaped frame whose `canvas` carries an identifying tag. */
function frame(id: number, timestamp: number, duration = 1 / 30) {
  return { canvas: { __id: id } as unknown as HTMLCanvasElement, timestamp, duration };
}

/** Fake CanvasSink: yields a fixed frame list (>= startTimestamp) in order, and
 *  records how many frames it decoded so we can assert O(n) sequential decode. */
function fakeSink(frames: ReturnType<typeof frame>[]) {
  const state = { decoded: 0, starts: [] as number[] };
  return {
    state,
    async *canvases(start = 0) {
      state.starts.push(start);
      for (const f of frames) {
        if (f.timestamp + f.duration <= start) continue; // before window
        state.decoded++;
        yield f;
      }
    },
  };
}

const FRAMES = Array.from({ length: 8 }, (_, i) => frame(i, i / 4)); // 0,0.25,0.5,...,1.75

function idOf(src: MediaBunnyExportFrameSource, t: number): number {
  return (src.getFrame(t) as unknown as { __id: number }).__id;
}

describe("MediaBunnyExportFrameSource", () => {
  it("returns the frame whose interval covers the requested time", async () => {
    const sink = fakeSink(FRAMES);
    const src = new MediaBunnyExportFrameSource("", sink);
    await src.seekAndDecode(0);
    expect(idOf(src, 0)).toBe(0);
    await src.seekAndDecode(0.25);
    expect(idOf(src, 0.25)).toBe(1);
    await src.seekAndDecode(0.6); // between frame 2 (0.5) and 3 (0.75) -> frame 2
    expect(idOf(src, 0.6)).toBe(2);
    await src.seekAndDecode(1.75);
    expect(idOf(src, 1.75)).toBe(7);
  });

  it("decodes each frame at most once across a monotonic walk (O(n))", async () => {
    const sink = fakeSink(FRAMES);
    const src = new MediaBunnyExportFrameSource("", sink);
    for (let i = 0; i < 8; i++) await src.seekAndDecode(i / 4);
    expect(sink.state.decoded).toBeLessThanOrEqual(8); // not 8*8
    expect(sink.state.starts.length).toBe(1); // single forward iterator, never restarted
  });

  it("restarts the iterator on a backward jump", async () => {
    const sink = fakeSink(FRAMES);
    const src = new MediaBunnyExportFrameSource("", sink);
    await src.seekAndDecode(1.5);
    expect(idOf(src, 1.5)).toBe(6);
    await src.seekAndDecode(0.25); // backward -> restart
    expect(idOf(src, 0.25)).toBe(1);
    expect(sink.state.starts.length).toBe(2);
  });

  it("clamps a time before the first frame to frame 0", async () => {
    const sink = fakeSink(FRAMES.slice(2)); // first frame at t=0.5
    const src = new MediaBunnyExportFrameSource("", sink);
    await src.seekAndDecode(0);
    expect(idOf(src, 0)).toBe(2);
  });

  it("restarts on a backward jump that lands within the already-iterated range", async () => {
    const sink = fakeSink(FRAMES);
    const src = new MediaBunnyExportFrameSource("", sink);
    await src.seekAndDecode(0); // restart at 0 (first call)
    await src.seekAndDecode(1.5); // forward to frame 6, no restart
    await src.seekAndDecode(0.5); // backward WITHIN [0,1.5) -> must restart
    expect(idOf(src, 0.5)).toBe(2);
    expect(sink.state.starts.length).toBe(2); // initial + one restart
  });
});
