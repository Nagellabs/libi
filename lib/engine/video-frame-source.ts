/** Abstraction for getting video frames — preview uses MediaBunny (WebCodecs), export uses MediaBunny */

export interface VideoFrameSource {
  /** Get the frame source at a given time (seconds). Returns an element drawable via ctx.drawImage() */
  getFrame(time: number): CanvasImageSource;
  /** Seek the source to a specific time (for preview sync) */
  seek(time: number): void;
  /**
   * USER-initiated seek/scrub: position to `time` and FORCE a clear + re-decode
   * from there, bypassing the soft `seek()`'s backward-tolerance. The soft
   * `seek()` tolerates a marginal backward gap so playback doesn't thrash-restart
   * a non-frame-aligned clip start; a discrete user seek/scrub must instead flush
   * any pre-decoded (warm) frames so the source lands on the target with no
   * replay. Optional — sources without a decode-ahead ring (export, canvas) can
   * omit it and callers fall back to `seek()`. Called only from the transport's
   * user-seek signal, never the per-frame render loop.
   */
  hardSeek?(time: number): void;
  /**
   * Export-only frame-accurate seek: position to `time` and resolve once a
   * frame AT that time is decoded & presentable, so a subsequent synchronous
   * `getFrame()` draws the correct (non-stale) frame.
   *
   * Distinct from `prime()`: `prime` is tuned for live preroll and may treat a
   * source as "already there" within a proximity window, so it could skip the
   * seek for consecutive frames and freeze a one-shot export. `seekAndDecode`
   * always advances unless within ~1 ms of the target — the offline export
   * source (`MediaBunnyExportFrameSource`) implements it; real-time preview
   * sources omit it.
   */
  seekAndDecode?(time: number): Promise<void>;
  /** Start playback (preview only) */
  play(): void;
  /** Pause playback (preview only) */
  pause(): void;
  /**
   * Pre-warm: begin decoding AHEAD from `timeSec` without being the actively
   * drawn source, so an upcoming clip has decoded runway ready by the time the
   * playhead reaches it (no cold-start stall at the cut). Optional — callers
   * fall back to `prime()` when absent.
   */
  warm?(timeSec: number): void;
  /** Set native playback rate — used to mirror the transport's speed multiplier. */
  setPlaybackRate?(rate: number): void;
  /** Set output volume (0..1). Only meaningful for unmuted sources; muted
   *  scene/overlay sources may omit it. */
  setVolume?(volume: number): void;
  /**
   * Preroll: seek to `timeSec` and resolve once the frame at that time is
   * actually decoded & paintable. Used by the preview preroll controller to
   * warm an upcoming scene before the playhead reaches the cut. Optional so
   * non-preview sources (e.g. MediaBunny/export) don't have to implement it.
   * Idempotent / cancellable-safe: overlapping prime calls never deadlock.
   */
  prime?(timeSec: number): Promise<void>;
  /**
   * True when the source can paint a correct frame at `timeSec` without a
   * visible decode stall (readyState gate + currentTime proximity). The
   * renderer uses this to decide whether to hold the last good frame instead
   * of flashing a stale/black frame on a not-ready source.
   */
  isReadyAt?(timeSec: number): boolean;
  /**
   * A cheap, paintable snapshot of the last frame this source successfully
   * produced (or null if it has never painted). The renderer draws this as a
   * hold-last-frame fallback when the live element isn't ready at `t`. Kept as
   * an offscreen canvas to avoid per-tick allocations.
   */
  lastGoodFrame?(): CanvasImageSource | null;
  /**
   * Records that the live element was successfully painted at `timeSec` —
   * lets the source refresh its `lastGoodFrame` snapshot. Called by the
   * renderer right after a real (ready) draw. Optional.
   */
  notePainted?(timeSec: number): void;
  /**
   * The composition-second up to which this source can play forward from
   * `timeSec` WITHOUT a decode stall — the end of the buffered `TimeRanges`
   * span covering `timeSec`, gated on `readyState >= HAVE_FUTURE_DATA (3)`.
   * Returns `timeSec` itself when nothing past it is buffered (no runway).
   *
   * This is the Layer-B read-ahead primitive: the gate uses it as a start
   * condition and the rolling look-ahead uses it to decide whether an
   * upcoming source still needs priming. Optional so export / other impls
   * (MediaBunny) don't have to implement it — callers treat a missing impl
   * as "always ready" (`bufferedThrough(t) === t` with no runway is the
   * conservative absence value; absence ⇒ skip the gate for that source).
   */
  bufferedThrough?(timeSec: number): number;
  /**
   * The source's REAL current decode position, in the SAME (source-local)
   * time base this source's `seek`/`getFrame` accept. Used by the transport's
   * video-pacing clamp to keep the playhead from running ahead of the pixels
   * the decoder has actually produced. Optional — absent impls (canvas /
   * export) are treated as "don't pace" by the caller.
   */
  getMediaTime?(): number;
  /** Clean up resources */
  dispose(): void;
}

/**
 * Seconds of decoded runway ahead of `timeSec` for a source — derived from
 * `bufferedThrough`. A small helper rather than an interface member so the
 * gate / look-ahead can call it uniformly across sources. When the source
 * doesn't implement `bufferedThrough`, returns `Infinity` (treat as fully
 * warm — non-`<video>` sources like canvas scenes never stall).
 */
export function readyAhead(
  source: Pick<VideoFrameSource, "bufferedThrough">,
  timeSec: number,
): number {
  if (!source.bufferedThrough) return Infinity;
  return Math.max(0, source.bufferedThrough(timeSec) - timeSec);
}

/** `code` mirrors `MediaError.code` (4 = MEDIA_ERR_SRC_NOT_SUPPORTED, the codec case). */
export interface VideoFrameSourceError {
  code: number;
  message: string;
}
