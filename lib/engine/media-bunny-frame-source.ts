import { fallbackOrigin, ifSettled, originFromTiming, retryServerTiming, serverTiming, type ServerTiming } from "@/lib/engine/source-time-origin";
import { primaryVideoTrack } from "@/lib/engine/primary-track";
import { attributeMediaLogs } from "@/lib/engine/sps-diagnostics";
import { Input, UrlSource, ALL_FORMATS, CanvasSink } from "mediabunny";
import type { VideoFrameSource, VideoFrameSourceFailure } from "./video-frame-source";
import { FrameRing } from "@/lib/preview/frame-ring";
import { mediaFetchRetryDelay } from "./media-fetch-retry";
import {
  classifyMediaLoadError,
  mediaErrorMessage,
  TRANSIENT_RETRY_DELAYS_SEC,
  UnplayableMediaError,
} from "./media-load-failure";
import { pumpDecision } from "@/lib/preview/decode-ahead";
import {
  RING_CAPACITY,
  LOOKAHEAD_SEC,
  resolveDecodeHeight,
  BACKWARD_RESTART_TOLERANCE_SEC,
  COVERAGE_EPS,
  MAX_RING_SPAN_SEC,
} from "@/lib/preview/tuning";
import { recordPreviewEvent } from "@/lib/preview/telemetry";

/**
 * Per-clip preview video source backed by mediabunny (WebCodecs under the hood).
 * Implements the synchronous `VideoFrameSource` interface by running an async
 * decode-ahead "pump" that fills a small `FrameRing`; `getFrame(t)` returns the
 * latest decoded frame ≤ t (or the held last-good frame on underflow, so the
 * canvas never flashes). The cut is a non-event: the compositor just asks for
 * the frame at time T from whichever clip owns T.
 *
 * The pump is throttled to stay within `LOOKAHEAD_SEC` of the last-requested
 * time, so it tracks the playhead instead of draining the whole clip.
 */
export class MediaBunnyFrameSource implements VideoFrameSource {
  private ring = new FrameRing<HTMLCanvasElement | OffscreenCanvas>(
    RING_CAPACITY,
    undefined,
    MAX_RING_SPAN_SEC,
  );
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  /** Raw timestamp of `sink`'s source time 0 (sourceTimeOrigin, Review M6).
   *  Every request adds it and every decoded frame subtracts it, so the ring
   *  and the caller speak source time from the file's start, as the proxy and
   *  the export do. */
  private sinkOrigin = 0;
  private pumpAbort: AbortController | null = null;
  private lastGoodCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  /** Most recent source-local time the consumer asked for (drives the throttle). */
  private lastRequestedT = 0;
  /** Timestamp of the frame last PAINTED while playing — the monotonic-forward
   *  guard never paints earlier than this (reset on seek). See getFrame. */
  private lastServedTs = -Infinity;
  /** TRANSPORT play state: true only between play() and pause(). Drives the
   *  monotonic-forward guard + serve tolerance — the things that must reflect
   *  whether the composition is actually playing. Deliberately NOT set by
   *  warm(): a warmed (off-screen) source is decoding a runway, not "playing",
   *  so leaving this false keeps a paused on-screen source's guard/tolerance
   *  correct after a warm→active-paused transition. */
  private playing = false;
  /** RUNWAY decode flag: true while the pump should keep decoding past its first
   *  frame (LOOKAHEAD_SEC ahead). Set by play() AND warm(); cleared by pause().
   *  Split from `playing` so warm() can build a runway WITHOUT claiming the
   *  transport is playing — see `playing` above. */
  private decodeAhead = false;
  private disposed = false;
  /** True once the CanvasSink (WebCodecs decoder) is live — drives the balanced
   *  decoder create/dispose telemetry (peak-concurrency = the Phase-0 metric). */
  private decoderLive = false;
  private ready: Promise<void>;
  /** Fires once per pump (re)start when its first frame lands — lets the owner
   *  trigger a repaint for initial-paint / paused-scrub without per-frame churn. */
  private frameListeners = new Set<() => void>();

  /** Subscribe to "first frame after a (re)start decoded". Returns an unsubscribe. */
  onFrame(fn: () => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /**
   * @param url source/proxy URL to decode.
   * @param maxDecodeHeight decode-height CAP. The sink decodes at
   *   `min(sourceHeight, maxDecodeHeight)` — resolution-aware, never upscaling
   *   (so a 1080p source under a 1080 cap decodes at 1080, a 4K source caps at
   *   1080, a 720p source stays 720). See `previewMaxHeight` / the
   *   Preview-quality setting.
   */
  /** Telemetry-only correlation label (scene/overlay id). Behavior-neutral. */
  private label = "";
  /** @internal Diagnostic-only: tag this source so telemetry rows are
   *  attributable to a scene/overlay. No effect on decode/playback. */
  setTelemetryLabel(label: string): void {
    this.label = label;
  }

  // ── Load failure handling (T3, 2026-09-25) ──────────────────────────────────
  // A clip that can't be played must SAY so, not buffer forever. See
  // lib/engine/media-load-failure.ts for the permanent/transient split.
  /** URLs to try in order: the preview URL (usually the proxy), then — when it
   *  differs — the original, tried ONCE if the first fails permanently. */
  private readonly urls: string[];
  private urlIndex = 0;
  /** The URL whose server timing this source asked for, and whether it answered. */
  private timingUrl: string | null = null;
  private timingAnswered = false;
  /** Transient retries spent on the current URL (bounded by
   *  TRANSIENT_RETRY_DELAYS_SEC). */
  private transientRetries = 0;
  /** Cancels a pending transient retry (dispose). */
  private cancelRetry: (() => void) | null = null;
  /** Non-null once the source has given up — see `failure()`. */
  private failed: VideoFrameSourceFailure | null = null;
  /** Decode errors already logged, so a pump that keeps restarting into the same
   *  error prints one line, not one per restart. */
  private loggedDecodeErrors = new Set<string>();

  /**
   * @param opts.fallbackUrl the ORIGINAL, when `url` is a proxy — tried once if
   *   the proxy fails permanently (a 4xx, a codec, a demux error).
   */
  constructor(
    url: string,
    private readonly maxDecodeHeight: number,
    opts: { fallbackUrl?: string } = {},
  ) {
    this.urls = opts.fallbackUrl && opts.fallbackUrl !== url ? [url, opts.fallbackUrl] : [url];
    this.ready = this.load();
  }

  /** Why this source gave up, or null while it is (or may yet become) playable. */
  failure(): VideoFrameSourceFailure | null {
    return this.failed;
  }

  /** Start loading the current URL. A failure is routed through `onLoadFailed`,
   *  which REPLACES `this.ready` (fallback / retry) or marks the source failed;
   *  `awaitReady` follows the replacement. */
  private load(): Promise<void> {
    const url = this.urls[this.urlIndex];
    const p = this.init(url).catch((err: unknown) => {
      this.onLoadFailed(url, err);
      throw err;
    });
    // startPump/prime go through `awaitReady` inside try/catch, so a failed
    // load is handled there. Attach a no-op catch so it never surfaces as an
    // unhandled rejection when neither has run yet (created then disposed).
    void p.catch(() => {});
    return p;
  }

  private onLoadFailed(url: string, err: unknown): void {
    if (this.disposed || this.failed) return;
    this.teardownInput();
    const kind = classifyMediaLoadError(err);
    const message = mediaErrorMessage(err);
    if (kind === "permanent") {
      if (this.urlIndex + 1 < this.urls.length) {
        this.urlIndex++;
        this.transientRetries = 0;
        console.warn(
          `[MediaBunnyFrameSource] ${this.label || url}: ${url} can't be played (${message}); trying ${this.urls[this.urlIndex]}`,
        );
        this.ready = this.load();
        return;
      }
      this.fail("permanent", message);
      return;
    }
    if (this.transientRetries < TRANSIENT_RETRY_DELAYS_SEC.length) {
      const delaySec = TRANSIENT_RETRY_DELAYS_SEC[this.transientRetries++];
      const waited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.cancelRetry = null;
          resolve();
        }, delaySec * 1000);
        this.cancelRetry = () => {
          clearTimeout(timer);
          reject(new Error("retry cancelled: source disposed"));
        };
      });
      const next = waited.then(() => this.load());
      void next.catch(() => {});
      this.ready = next;
      return;
    }
    this.fail("transient", message);
  }

  /** Give up: stop decoding, tell the owner to repaint (the renderer draws the
   *  placeholder), and say so ONCE. */
  private fail(kind: VideoFrameSourceFailure["kind"], message: string): void {
    this.failed = { kind, message };
    this.pumpAbort?.abort();
    this.pumpFrom = null;
    this.ring.clear();
    this.lastGoodCanvas = null;
    console.warn(
      `[MediaBunnyFrameSource] ${this.label || this.urls[this.urlIndex]} can't be played (${kind}): ${message}`,
    );
    for (const fn of this.frameListeners) fn();
  }

  /** Dispose the current mediabunny Input/sink (a failed load, or dispose()). */
  private teardownInput(): void {
    if (this.decoderLive) {
      this.decoderLive = false;
      recordPreviewEvent({ t: performance.now(), type: "decoder", src: this.label, label: "dispose" });
    }
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }

  /**
   * Wait for the source to be decodable. Follows a `ready` that was REPLACED
   * while waiting (proxy→original fallback, transient retry), so a pump or
   * prime started before the failure carries on once the replacement loads.
   * False when the source failed, was disposed, or has no sink.
   */
  private async awaitReady(): Promise<boolean> {
    for (;;) {
      const current = this.ready;
      try {
        await current;
        return !this.disposed && !this.failed && this.sink !== null;
      } catch {
        if (this.disposed || this.failed || this.ready === current) return false;
      }
    }
  }

  /** A decode error mid-stream. A permanent one (decoder rejection) is handled
   *  like a failed load — fall back once, else fail; anything else is logged
   *  once per distinct message.
   *
   *  `from` is the sink the failing decode was reading. When it is no longer
   *  the live sink, the input was torn down under it (a fallback / retry /
   *  failure triggered by ANOTHER decode) and the error is that teardown's
   *  InputDisposedError — expected, not worth a line, and must not be judged as
   *  a failure of the replacement. */
  private onDecodeError(where: "pump" | "prime", err: unknown, from: CanvasSink): void {
    if (this.disposed || this.failed || this.sink !== from) return;
    // NOTE: a WebCodecs EncodingError mid-stream can also be a GPU/decoder
    // hiccup rather than bad data; it is still treated as permanent here (one
    // fallback, then the placeholder). A remount (reopen the piece, change the
    // preview quality) builds a fresh source and clears it.
    if (classifyMediaLoadError(err) === "permanent") {
      this.onLoadFailed(this.urls[this.urlIndex], err);
      if (!this.failed) void this.resumeAfterReload();
      return;
    }
    const message = mediaErrorMessage(err);
    if (this.loggedDecodeErrors.has(message)) return;
    this.loggedDecodeErrors.add(message);
    console.warn(`[MediaBunnyFrameSource] ${where} decode failed`, message);
  }

  /** After a mid-stream fallback, pick decoding back up where the consumer is. */
  private async resumeAfterReload(): Promise<void> {
    if (!(await this.awaitReady())) return;
    if (this.decodeAhead) this.startPump(this.lastRequestedT, "reload");
    else void this.prime(this.lastRequestedT);
  }

  private async init(url: string): Promise<void> {
    const input = new Input({
      // Bounded retries: mediabunny's default retries a same-origin fetch
      // failure forever. See media-fetch-retry.ts.
      source: new UrlSource(url, { getRetryDelay: mediaFetchRetryDelay }),
      formats: ALL_FORMATS,
    });
    this.input = input;
    // Asked for at once, never waited on: until the server's answer lands the
    // source uses mediabunny's own origin (source-time-origin.ts, review I1).
    const timing = serverTiming(url);
    this.timingAnswered = false;
    this.timingUrl = url;
    // Reading the first timestamp lists the tracks; listing them and reading
    // the decoder config is where mediabunny parses an HEVC SPS (in MPEG-TS
    // already while listing). All of it runs in one attribution region, so an
    // unparsable SPS is reported once, naming this file (sps-diagnostics.ts).
    const { fallback, track } = await attributeMediaLogs(url, async () => {
      const first = await fallbackOrigin(input);
      const t = await primaryVideoTrack(input);
      if (t) await t.getDecoderConfig();
      return { fallback: first, track: t };
    });
    if (!track) throw new UnplayableMediaError("no video track found in " + url);
    // A codec this browser can't decode (e.g. HEVC without platform support)
    // would otherwise fail inside every pump. Say so up front — permanent.
    // Caveat: mediabunny's canDecode() also answers false when its
    // getDecoderConfig() hit a (possibly transient) read error, so a network
    // blip here reads as "can't be decoded". Accepted: the proxy→original
    // fallback still runs, and a remount builds a fresh source.
    if (!(await track.canDecode())) {
      throw new UnplayableMediaError(`the ${(await track.getCodec()) ?? "unknown"} codec can't be decoded here`);
    }
    const displayHeight = await track.getDisplayHeight();
    if (this.disposed) throw new Error("disposed during init");
    const early = await ifSettled(timing, null);
    if (early) this.timingAnswered = true;
    this.sinkOrigin = originFromTiming(early) ?? fallback;
    if (early === null) void timing.then((t) => this.takeTiming(input, t));
    this.sink = new CanvasSink(track, {
      height: resolveDecodeHeight(displayHeight, this.maxDecodeHeight),
      poolSize: RING_CAPACITY + 2,
      // Transparent canvases so VP9-alpha WebM cutouts composite for real in
      // the preview. Mediabunny decodes the WebM alpha side-band (second
      // VideoDecoder + merge), but CanvasSink defaults to OPAQUE canvases —
      // without this flag a cutout's transparent region renders black.
      // Opaque sources are unaffected (every pixel stays alpha=1).
      alpha: true,
    });
    // Decoder is now live — record one create event (balanced by dispose()).
    // A source disposed mid-init (before the sink lands) never created a decoder,
    // so it emits no create and no dispose — keeping the concurrency count honest.
    this.decoderLive = true;
    recordPreviewEvent({ t: performance.now(), type: "decoder", src: this.label, label: "create" });
  }

  /** A (late) answer from the server: take its origin, if it gives one. */
  private takeTiming(input: Input, t: ServerTiming | null): void {
    if (!t || this.input !== input) return;
    this.timingAnswered = true;
    const origin = originFromTiming(t);
    if (origin !== null) this.applyOrigin(origin);
  }

  /**
   * On play and on a user seek: ask the server again when the lookup failed
   * and its back-off has passed (retryServerTiming bounds the attempts).
   * Never waited on.
   */
  private retryTiming(): void {
    const input = this.input;
    if (!input || this.timingAnswered || !this.timingUrl) return;
    const again = retryServerTiming(this.timingUrl);
    if (again) void again.then((t) => this.takeTiming(input, t));
  }

  /**
   * The server's origin landed after the source started on its fallback: take
   * it and re-decode from where the consumer is. It differs only for a file
   * whose first timestamp isn't ffmpeg's start (a subtitle stream starting
   * before the video, say).
   */
  private applyOrigin(origin: number): void {
    if (this.disposed || Math.abs(origin - this.sinkOrigin) < 1e-6) return;
    this.sinkOrigin = origin;
    this.lastServedTs = -Infinity;
    this.ring.clear();
    if (!this.sink || this.failed) return;
    if (this.playing) this.startPump(this.lastRequestedT, "origin");
    else void this.prime(this.lastRequestedT);
  }

  /** Single-in-flight guard for `prime()`. A paused SCRUB fires prime() per
   *  mousemove; each `getCanvas()` is async, so decoding EVERY request would
   *  either queue a backlog that replays after the drag stops (the forward "gif")
   *  or — if each new request cancels the prior — never paint until the drag
   *  stops (1–2s lag). Instead we keep exactly ONE decode in flight and remember
   *  only the LATEST requested position (`pendingPrimeT`); when the in-flight
   *  decode finishes it paints and immediately chases the newest position. The
   *  displayed frame thus tracks the playhead at decode speed — live scrub, no
   *  backlog. */
  private priming = false;
  private pendingPrimeT: number | null = null;

  /** The `fromSec` of the currently-live pump, or null when no pump is running.
   *  Used to avoid aborting+restarting a pump that's already heading to the
   *  requested time (which would starve it before its first push). */
  private pumpFrom: number | null = null;

  /** (Re)start the decode-ahead pump from `fromSec`, cancelling any prior pump.
   *  `reason` is telemetry-only (why the restart fired). */
  private startPump(fromSec: number, reason = "?"): void {
    if (this.failed || this.disposed) return;
    recordPreviewEvent({
      t: performance.now(),
      type: "pump",
      src: this.label,
      fromSec,
      reason,
    });
    this.pumpAbort?.abort();
    const ac = new AbortController();
    this.pumpAbort = ac;
    this.pumpFrom = fromSec;
    let firstPush = true;
    let sink: CanvasSink | null = null;
    void (async () => {
      try {
        if (!(await this.awaitReady())) return;
        if (!this.sink || ac.signal.aborted || this.disposed) return;
        sink = this.sink;
        const origin = this.sinkOrigin;
        for await (const wrapped of sink.canvases(fromSec + origin)) {
          if (ac.signal.aborted || this.disposed) return;
          const ts = wrapped.timestamp - origin;
          this.ring.push(ts, wrapped.canvas);
          if (firstPush) {
            firstPush = false;
            for (const fn of this.frameListeners) fn();
          }
          // No runway requested (paused on-screen source): a single frame at the
          // seek position is enough to display — stop so the ring never holds a
          // forward sequence the paused settle would jiggle through.
          if (!this.decodeAhead) return;
          // Throttle: park until the playhead advances to within LOOKAHEAD of the
          // frame we just produced, so we decode a sliding window around the
          // playhead rather than the whole clip into an evicting ring.
          while (
            this.decodeAhead &&
            !ac.signal.aborted &&
            !this.disposed &&
            ts > this.lastRequestedT + LOOKAHEAD_SEC
          ) {
            await sleep(16);
          }
          if (ac.signal.aborted || this.disposed) return;
        }
      } catch (err) {
        // Same teardown race as prime(): canvases() can reject when the Input
        // is disposed mid-iteration (InputDisposedError). Swallow while
        // shutting down / aborting; surface anything genuinely unexpected.
        if (!this.disposed && !ac.signal.aborted && sink) this.onDecodeError("pump", err, sink);
      } finally {
        if (this.pumpAbort === ac) this.pumpFrom = null;
      }
    })();
  }

  /**
   * Ensure the ring covers (or a live pump is heading to) source-local time `t`.
   * No-op when a decoded frame at `t` is already buffered. Crucially, does NOT
   * restart a pump that's already in-flight toward `t` (even before its first
   * push) — that starvation is what left the ring empty at a cut. Only (re)starts
   * for a backward jump before the pump's origin or a forward jump far past what
   * the live pump will soon reach.
   */
  private ensureCovers(t: number): void {
    const from = this.ring.coversFrom();
    const thru = this.ring.coversThrough();
    const action = pumpDecision(t, from, thru, this.pumpFrom, LOOKAHEAD_SEC);
    if (action !== "restart") return; // "ok" (buffered) or "wait" (pump heading here)
    // Telemetry-only classification of WHY the restart fired.
    const reason =
      thru === -Infinity
        ? "empty"
        : t < from - BACKWARD_RESTART_TOLERANCE_SEC
        ? "backward"
        : "forward";
    this.ring.clear();
    this.startPump(t, reason);
  }

  /** How far AHEAD getFrame/isReadyAt may serve a frame.
   *
   *  REVERTED to a single generous tolerance. The earlier playing-tight variant
   *  (AHEAD_SERVE_PLAYING_SEC, 0.12s) assumed the ring stays AT the playhead, so
   *  a far-ahead frame was a rare glitch to hold through. But on machines where
   *  the decode ring perpetually runs AHEAD of the playhead, a tight tolerance
   *  makes getFrame return HELD (frozen) every frame AND makes isReadyAt read
   *  not-ready every frame → the buffering gate loops → "buffer to buffer, no
   *  frames" (a hard playback regression). Serving the nearest decoded frame
   *  (even up to ~0.5s ahead) keeps the picture MOVING; the small A/V offset is
   *  invisible vs a frozen preview. */
  private serveTolerance(): number {
    return BACKWARD_RESTART_TOLERANCE_SEC;
  }

  getFrame(t: number): CanvasImageSource {
    const prevReq = this.lastRequestedT;
    this.lastRequestedT = t;
    // A real BACKWARD jump in the requested time = a seek / scrub-back (which may
    // not route through seek() for a base-scene source) — drop the monotonic
    // anchor so the new, earlier target paints instead of being held.
    if (t < prevReq - BACKWARD_RESTART_TOLERANCE_SEC) this.lastServedTs = -Infinity;
    // Latest frame ≤ t, or the nearest just-ahead frame within the serve
    // tolerance; only then the held last-good.
    let sel = this.ring.selectAtOrNearestAhead(t, this.serveTolerance());

    // ── Monotonic-forward guard (PLAYING only) ──────────────────────────────
    // Never paint a frame EARLIER than the one we last painted while playing.
    // At play-start (and after a pump catch-up) the ring can briefly hold a
    // frame BEHIND the playhead before the decoder fills up to it, so getFrame
    // would serve 0.83→0.63→0.83…: the base video jitters backward-then-forward,
    // which is the visible play-start "whole-frame flash" (confirmed on a screen
    // recording: the car oscillates for ~0.4s at play start). Holding the latest
    // painted frame instead is strictly forward and resolves the instant a
    // >= frame arrives. SAFE vs the prior freeze regression: this only suppresses
    // BACKWARD steps — it never withholds a forward frame, so playback cannot
    // freeze on an advancing playhead. Disabled while paused (a scrub must show
    // any frame) and reset on seek() (a real seek may legitimately go backward).
    let monotonicHeld = false;
    if (shouldHoldForMonotonic(this.playing, sel?.timestamp ?? null, this.lastServedTs, COVERAGE_EPS)) {
      monotonicHeld = true;
      sel = null; // fall through to hold the last-good (latest painted) frame
    }

    // A truly BLACK frame: nothing buffered at/near t AND no last-good to hold —
    // i.e. the 2×2 blank goes on screen. Distinct from a "held" (stale-but-real)
    // frame. This is the cold-start flash; tracked separately so telemetry can
    // tell a black-flash apart from a benign held frame.
    const black = !sel && !this.lastGoodCanvas && !monotonicHeld;
    recordPreviewEvent({
      t: performance.now(),
      type: "getFrame",
      src: this.label,
      req: t,
      got: sel ? sel.timestamp : -1,
      kind: sel ? (sel.kind === "before" ? "live" : "ahead") : "held",
      black,
      from: this.ring.coversFrom(),
      thru: this.ring.coversThrough(),
      n: this.ring.size(),
      gap: sel ? sel.timestamp - t : undefined,
    });
    if (sel) {
      this.lastServedTs = sel.timestamp;
      this.lastGoodCanvas = sel.value;
      return sel.value;
    }
    return this.lastGoodCanvas ?? blankCanvas();
  }

  isReadyAt(t: number): boolean {
    // Same rule as getFrame (so the readiness gate's view matches what actually
    // paints): tight ahead-tolerance while playing — a far-ahead-only ring reads
    // as NOT ready so a SUSTAINED lag trips the buffering gate instead of serving
    // a future frame; generous while paused so a scrub lands.
    if (this.failed) return false;
    return this.ring.frameAtOrNearestAhead(t, this.serveTolerance()) != null;
  }

  bufferedThrough(t: number): number {
    const c = this.ring.coversThrough();
    return c === -Infinity ? t : Math.max(t, c);
  }

  seek(t: number): void {
    this.lastRequestedT = t;
    // A seek may legitimately jump BACKWARD — clear the monotonic-forward anchor
    // so getFrame can paint the new (possibly earlier) target instead of holding.
    this.lastServedTs = -Infinity;
    this.ensureCovers(t);
  }

  /**
   * USER-initiated seek/scrub: unconditionally clear the ring and restart the
   * pump from `t`, BYPASSING the `pumpDecision` backward-tolerance.
   *
   * The soft per-frame `seek(t)` (the playback render loop) deliberately
   * tolerates a sub-`BACKWARD_RESTART_TOLERANCE_SEC` backward gap so a
   * non-frame-aligned clip start doesn't thrash-restart the pump ~18×/s. But
   * that same tolerance is exactly what makes a WARM overlay source (its pump
   * decoded AHEAD of the in-point and parked) replay stale ahead-frames after a
   * user seek that lands within the window: `seek()` returns "not a restart" so
   * the ring keeps its pre-decoded frames and `getFrame` serves them. A user
   * seek/scrub is a discrete intent (not the 30 Hz playback cadence), so here we
   * ALWAYS flush + re-decode from `t` — no tolerance — so both base and overlay
   * sources land on the target frame with no replay. Never called from the rAF
   * advance; only from the transport's user-seek signal (see useVideoSources).
   */
  hardSeek(t: number): void {
    this.retryTiming();
    // A user seek is a discrete intent — the one thing that gives a source whose
    // TRANSIENT retries ran out (server was down) a fresh try. A permanent
    // failure stays failed: the same request would fail the same way.
    if (this.failed?.kind === "transient" && !this.disposed) {
      this.failed = null;
      this.transientRetries = 0;
      this.ready = this.load();
    }
    this.lastRequestedT = t;
    this.lastServedTs = -Infinity;
    this.ring.clear();
    if (this.playing) {
      // Playing: re-decode a runway from t so playback resumes full.
      this.startPump(t, "hard-seek");
    } else {
      // PAUSED: land EXACTLY one frame via a direct getCanvas(t) — do NOT start
      // the forward decode-ahead pump. A pump would (a) emit its seek-landing
      // frame slightly AHEAD of t before the exact frame lands (the 1–2-frame
      // paused "jiggle"), and (b) on a scrub, accumulate a forward sequence the
      // compositor walks through (the ~10-frame "gif"). One exact frame is all a
      // paused seek needs; the runway is rebuilt on play().
      void this.prime(t);
    }
  }

  async prime(t: number): Promise<void> {
    this.lastRequestedT = t;
    if (this.failed) return;
    if (this.priming) {
      // A decode is already in flight — just record the LATEST position; the live
      // chain will chase it when the current decode finishes. This is what makes a
      // fast paused scrub paint frames at decode speed (chasing the playhead)
      // instead of queuing a per-mousemove backlog (gif) or starving (1–2s lag).
      this.pendingPrimeT = t;
      return;
    }
    await this.runPrimeChain(t);
  }

  /** Decode `t`, paint it, then chase `pendingPrimeT` (the latest position
   *  requested while this decode was in flight) until no more is pending. Exactly
   *  one decode runs at a time. */
  private async runPrimeChain(t: number): Promise<void> {
    this.priming = true;
    let target: number | null = t;
    try {
      while (target !== null && !this.disposed) {
        const cur = target;
        this.pendingPrimeT = null;
        let sink: CanvasSink | null = null;
        try {
          // `await this.ready` MUST be inside the try: a source disposed before
          // its init resolves (StrictMode unmount, piece switch, source-swap)
          // rejects `ready` with InputDisposedError, and prime() is
          // fire-and-forget — an unguarded await surfaces as an unhandled
          // rejection.
          if (!(await this.awaitReady())) break;
          if (!this.sink || this.disposed) break;
          sink = this.sink;
          const origin = this.sinkOrigin;
          const wrapped = await sink.getCanvas(cur + origin);
          if (this.disposed) break;
          if (wrapped) {
            this.ring.push(wrapped.timestamp - origin, wrapped.canvas);
            // Notify so the owner repaints — this is what makes a SEEK-WHILE-PAUSED
            // update the canvas to the landed frame (the renderer's own pump may
            // have been aborted by the budget's pause(); prime() is the reliable
            // path).
            for (const fn of this.frameListeners) fn();
          }
        } catch (err) {
          // A concurrent dispose() / source-swap tears down the mediabunny Input
          // mid-init or mid-decode → `ready`/getCanvas rejects
          // (InputDisposedError). prime() MUST never reject — so resolve quietly.
          // A dispose race is expected; log anything else.
          if (!this.disposed && sink) this.onDecodeError("prime", err, sink);
        }
        // Chase the latest position requested while this decode was in flight.
        target = this.pendingPrimeT;
      }
    } finally {
      this.priming = false;
    }
  }

  play(): void {
    this.retryTiming();
    this.playing = true;
    this.decodeAhead = true;
    this.ensureCovers(this.lastRequestedT);
  }

  /**
   * Pre-warm: decode-ahead from `fromSec` while NOT the actively-drawn source,
   * so an upcoming clip has ~LOOKAHEAD_SEC of runway ready at the cut. Sets
   * playing=true so the pump keeps going past the first frame, then parks at
   * `fromSec + LOOKAHEAD_SEC` (throttle) until the playhead advances into it
   * (at which point the renderer's getFrame/seek resume it).
   */
  warm(fromSec: number): void {
    // Build a runway (decodeAhead) but do NOT set `playing` — a warmed source is
    // off-screen, not the transport playing. Leaving `playing` false keeps the
    // serve tolerance + monotonic guard correct if it later becomes the active
    // PAUSED (on-screen) source.
    this.decodeAhead = true;
    this.lastRequestedT = fromSec;
    // Force a RUNWAY ahead of `fromSec`, not just coverage of `fromSec`. A source
    // primed to a single frame (paused) HAS `fromSec` buffered, so `ensureCovers`
    // would no-op and never pre-decode — which is exactly why a cold press-play's
    // readiness gate used to time out at MAX_GATE_MS (~1.6s): the pump can't run
    // during the gate hold (`playing` is false there), so warming a real runway
    // while paused is what lets the gate release instantly. Start the pump only
    // when the runway is short AND no pump is already building it (else a per-tick
    // warm would restart the pump every frame until the runway fills = thrash).
    const thru = this.ring.coversThrough();
    const hasRunway = thru !== -Infinity && thru >= fromSec + LOOKAHEAD_SEC - COVERAGE_EPS;
    const pumpBuilding = this.pumpFrom !== null;
    if (!hasRunway && !pumpBuilding) {
      this.startPump(fromSec, "warm");
    } else {
      this.ensureCovers(fromSec);
    }
  }

  pause(): void {
    this.playing = false;
    this.decodeAhead = false;
    this.pumpAbort?.abort();
    // Keep the ring so getFrame() can still paint the current frame while paused.
  }

  lastGoodFrame(): CanvasImageSource | null {
    return this.lastGoodCanvas;
  }

  /**
   * Seed the held last-good frame from a PRIOR source for this same scene/overlay
   * — used on a URL/quality reattach (e.g. a proxy becoming ready) so the brand-
   * new source's empty ring shows the previous frame (hold-last) instead of a
   * BLACK flash until its first decode lands. Behavior-neutral once the new
   * source decodes its own frame (getFrame overwrites lastGoodCanvas).
   */
  adoptLastGood(c: CanvasImageSource | null): void {
    if (c) this.lastGoodCanvas = c as HTMLCanvasElement | OffscreenCanvas;
  }

  notePainted(): void {
    // lastGoodCanvas is updated in getFrame; nothing extra needed here.
  }

  dispose(): void {
    this.disposed = true;
    this.pumpAbort?.abort();
    this.ring.clear();
    this.lastGoodCanvas = null;
    this.frameListeners.clear();
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.teardownInput();
  }
}

/**
 * Pure monotonic-forward decision for `getFrame`: should we HOLD the last painted
 * frame instead of serving `selTimestamp`?
 *
 * True only when PLAYING and the selected frame is meaningfully EARLIER than the
 * last one we painted — that backward step is the play-start oscillation flash.
 * Crucially returns false whenever `selTimestamp >= lastServedTs` (any forward or
 * same frame serves), so it can NEVER freeze an advancing playhead — that's the
 * invariant that makes this safe vs the earlier strict-tolerance freeze.
 */
export function shouldHoldForMonotonic(
  playing: boolean,
  selTimestamp: number | null,
  lastServedTs: number,
  eps: number,
): boolean {
  return playing && selTimestamp != null && selTimestamp < lastServedTs - eps;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let _blank: HTMLCanvasElement | null = null;
function blankCanvas(): HTMLCanvasElement {
  if (!_blank) {
    _blank = document.createElement("canvas");
    _blank.width = 2;
    _blank.height = 2;
  }
  return _blank;
}
