import { Input, UrlSource, ALL_FORMATS, CanvasSink, type WrappedCanvas } from "mediabunny";
import { mediaFetchRetryDelay } from "./media-fetch-retry";
import { fallbackOrigin, originFromTiming, retryServerTiming, serverTiming } from "./source-time-origin";
import { primaryVideoTrack } from "./primary-track";
import { attributeMediaLogs } from "./sps-diagnostics";
import type { VideoFrameSource } from "./video-frame-source";

/** How long the export waits for the server's start time (it runs on a loaded machine). */
export const EXPORT_TIMING_TIMEOUT_MS = 30_000;

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
  /** Raw timestamp of source time 0 (sourceTimeOrigin): requests add it,
   *  decoded frames subtract it, so a file that starts at 1.5 s renders in the
   *  same place as its audio, which ffmpeg mixes from the file's start
   *  (Review M6). */
  private origin = 0;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private lastCovered = -Infinity; // timestamp of the frame currently covering the cursor
  private next: WrappedCanvas | null = null; // look-ahead: next undelivered frame
  private current: CanvasImageSource | null = null;
  private disposed = false;
  private readonly ready: Promise<void>;

  /** @param sinkForTest inject a fake `CanvasIterable` to bypass real demuxing.
   *  @param originForTest the injected sink's raw timestamp of source time 0. */
  constructor(url: string, sinkForTest?: CanvasIterable, originForTest = 0) {
    if (sinkForTest) {
      this.sink = sinkForTest;
      this.origin = originForTest;
      this.ready = Promise.resolve();
    } else {
      this.ready = this.init(url);
    }
  }

  private async init(url: string): Promise<void> {
    const input = new Input({
      // Bounded retries: mediabunny's default retries a same-origin fetch
      // failure forever. See media-fetch-retry.ts.
      source: new UrlSource(url, { getRetryDelay: mediaFetchRetryDelay }),
      formats: ALL_FORMATS,
    });
    this.input = input;
    // The export is offline and must be exact, so it waits for the server's
    // start time (EXPORT_TIMING_TIMEOUT_MS), asked for in parallel with the
    // track. Measured on a file whose subtitle starts before its video (ffprobe
    // start 0.6 s, mediabunny's first timestamp 1.0 s): the canvas export's
    // video moved 400 ms onto the ffmpeg-overlay export and the proxy, which
    // count from ffmpeg's start (review round 2, M1).
    // A lookup that failed is asked once more at once (no back-off: nothing
    // interactive waits here, and the export must be exact).
    const timing = serverTiming(url, EXPORT_TIMING_TIMEOUT_MS).then(
      (t) => t ?? retryServerTiming(url, Number.POSITIVE_INFINITY, EXPORT_TIMING_TIMEOUT_MS) ?? null,
    );
    // An unparsable HEVC SPS is reported once, naming this file
    // (sps-diagnostics.ts). Listing the tracks is where it is parsed, in
    // MPEG-TS already while reading the first timestamp, so that is inside the
    // region too, before the origin needs it.
    const { fallback, track } = await attributeMediaLogs(url, async () => {
      const first = await fallbackOrigin(input);
      const t = await primaryVideoTrack(input);
      if (t) await t.getDecoderConfig();
      return { fallback: first, track: t };
    });
    this.origin = originFromTiming(await timing) ?? fallback;
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
    this.iter = this.sink.canvases(Math.max(0, fromSec) + this.origin);
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
    while (this.next && this.next.timestamp - this.origin <= target + EPS) {
      this.current = this.next.canvas;
      this.lastCovered = this.next.timestamp - this.origin;
      if (this.disposed || !this.iter) return;
      this.next = (await this.iter.next()).value ?? null;
    }
    // t precedes the first decoded frame (trim/rounding): show the first frame.
    if (this.current === null && this.next) {
      this.current = this.next.canvas;
      this.lastCovered = this.next.timestamp - this.origin;
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
