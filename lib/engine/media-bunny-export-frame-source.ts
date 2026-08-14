import { Input, UrlSource, ALL_FORMATS, CanvasSink, type WrappedCanvas } from "mediabunny";
import type { VideoFrameSource } from "./video-frame-source";

/** The narrow slice of `CanvasSink` this source uses — lets tests inject a fake. */
interface CanvasIterable {
  canvases(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<WrappedCanvas, void, unknown>;
}

/**
 * Offline, frame-exact video source for EXPORT. Decodes the clip SEQUENTIALLY
 * in presentation order via mediabunny (WebCodecs) — the same decoder the
 * preview uses (`MediaBunnyFrameSource`), minus the real-time decode-ahead
 * pump / ring / throttle.
 *
 * The export walks composition frames in time order, so each source is asked
 * for monotonically-increasing times; a single forward `CanvasSink` iterator
 * therefore decodes every frame exactly once (O(n)). `seekAndDecode(t)` advances
 * the cursor to the frame whose presentation interval covers t; `getFrame()`
 * returns it. Frame-exact, no `<video>` seeking, no dupes/skips. (Per-frame
 * random `getCanvas(t)` would re-decode from the nearest keyframe each call →
 * O(n²) on single-GOP originals.)
 */
export class MediaBunnyExportFrameSource implements VideoFrameSource {
  private input: Input | null = null;
  private sink: CanvasIterable | null = null;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private lastCovered = -Infinity; // timestamp of the frame currently covering the cursor
  private next: WrappedCanvas | null = null; // look-ahead: next undelivered frame
  private current: CanvasImageSource | null = null;
  private disposed = false;
  private readonly ready: Promise<void>;

  /** @param sinkForTest inject a fake `CanvasIterable` to bypass real demuxing. */
  constructor(url: string, sinkForTest?: CanvasIterable) {
    if (sinkForTest) {
      this.sink = sinkForTest;
      this.ready = Promise.resolve();
    } else {
      this.ready = this.init(url);
    }
  }

  private async init(url: string): Promise<void> {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    this.input = input;
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("MediaBunnyExportFrameSource: no video track in " + url);
    // No `height` option → decode at the source's NATIVE resolution (full quality).
    // `alpha: true` — same reason as MediaBunnyFrameSource: CanvasSink
    // defaults to opaque canvases, which would bake a cutout's transparent
    // region as black into canvas-source exports.
    this.sink = new CanvasSink(track, { poolSize: 2, alpha: true });
  }

  /** Resolves once the demuxer/decoder is ready (track + sink). Throws on a
   *  source with no decodable video track — callers use this to fall back. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async restartIter(fromSec: number): Promise<void> {
    if (!this.sink) return;
    void this.iter?.return?.(undefined);
    this.iter = this.sink.canvases(Math.max(0, fromSec));
    this.next = (await this.iter.next()).value ?? null;
    this.current = null;
    this.lastCovered = -Infinity;
  }

  async seekAndDecode(t: number): Promise<void> {
    await this.ready;
    if (this.disposed || !this.sink) return;
    const target = Math.max(0, t);
    // First call or backward jump → (re)start the forward iterator at t.
    if (this.iter === null || target < this.lastCovered - 1e-6) {
      await this.restartIter(target);
    }
    const EPS = 1e-3;
    // Advance while the look-ahead frame starts at/before t; the last such frame
    // is the one whose presentation interval covers t.
    while (this.next && this.next.timestamp <= target + EPS) {
      this.current = this.next.canvas;
      this.lastCovered = this.next.timestamp;
      if (this.disposed || !this.iter) return;
      this.next = (await this.iter.next()).value ?? null;
    }
    // t precedes the first decoded frame (trim/rounding): show the first frame.
    if (this.current === null && this.next) {
      this.current = this.next.canvas;
      this.lastCovered = this.next.timestamp;
    }
  }

  getFrame(_t: number): CanvasImageSource {
    return this.current ?? blankCanvas();
  }

  // One-shot offline export: no live playback semantics.
  seek(_t: number): void {}
  play(): void {}
  pause(): void {}

  dispose(): void {
    this.disposed = true;
    void this.iter?.return?.(undefined);
    this.iter = null;
    this.next = null;
    this.current = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}

let _blank: HTMLCanvasElement | OffscreenCanvas | null = null;
function blankCanvas(): CanvasImageSource {
  if (!_blank) {
    _blank =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(2, 2)
        : (() => {
            const c = document.createElement("canvas");
            c.width = 2;
            c.height = 2;
            return c;
          })();
  }
  return _blank;
}
