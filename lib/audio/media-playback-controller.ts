/**
 * Tolerance while the element is PAUSED or scrubbing — snap tightly so a scrub
 * lands frame-accurate. A `currentTime` write here is cheap (the element isn't
 * decoding forward) and is what the user wants when dragging the playhead.
 */
const SEEK_TOLERANCE_S = 0.1;

/**
 * Tolerance while the element is in STEADY NATIVE PLAYBACK. Mirrors Remotion's
 * `acceptableTimeShift` (0.45s). A `currentTime` write is a *seek* — it
 * re-decodes frames and interrupts an in-progress decode. During playback the
 * native decoder advances on its own; writing `currentTime` on small drift
 * restarts the decode every tick and pins a cold-warming element in place
 * (the "timecode stuck while playhead advances" freeze on first play). So while
 * playing we leave the decoder alone and only correct a LARGE divergence
 * (a real loading hiccup), never the sub-frame jitter between our wall-clock
 * playhead and the element's media clock. The element + our clock stay locked
 * because both advance at rate 1 from the same origin.
 */
const PLAYING_DRIFT_TOLERANCE_S = 0.45;

export interface MediaDesiredState {
  /** Should the element be playing right now? */
  playing: boolean;
  /** Where the element should be in its source timeline (seconds). */
  time: number;
  /** Element output volume (0..1). */
  volume: number;
}

/**
 * Wraps one `HTMLMediaElement` with race-safe play/pause + threshold-
 * gated seek + idempotent volume application.
 *
 * Why this exists: `el.play()` is async. Calling `.pause()` while a
 * previous `.play()` promise is still resolving has no effect — when the
 * play promise settles, the element starts playing. So if the transport
 * flips playing=false during that window, the element ignores it. The
 * controller serializes intent: every `setState` records the latest
 * desired state, then reconciles against the element after any pending
 * play resolves.
 */
export class MediaPlaybackController {
  private el: HTMLMediaElement;
  private desired: MediaDesiredState = { playing: false, time: 0, volume: 1 };
  private pendingPlay: Promise<void> | null = null;
  private disposed = false;

  constructor(el: HTMLMediaElement) {
    this.el = el;
  }

  setState(next: MediaDesiredState): void {
    if (this.disposed) return;
    this.desired = next;

    // Apply volume immediately (cheap, synchronous).
    if (this.el.volume !== next.volume) this.el.volume = next.volume;

    // Reconcile position. The threshold depends on whether the element is in
    // steady native playback or paused/scrubbing — see the constants above.
    // KEY: during steady playback we do NOT write currentTime on small drift;
    // a write is a seek that re-decodes and interrupts a warming decoder, which
    // is the cold-first-play freeze. We let the native decoder run and only
    // correct a large (>0.45s) divergence — and never while a seek is already
    // in flight (writing currentTime mid-seek just restarts it).
    const steadyPlayback = next.playing && !this.el.paused;
    if (steadyPlayback) {
      if (
        !this.el.seeking &&
        Math.abs(this.el.currentTime - next.time) > PLAYING_DRIFT_TOLERANCE_S
      ) {
        this.el.currentTime = next.time;
      }
    } else if (Math.abs(this.el.currentTime - next.time) > SEEK_TOLERANCE_S) {
      // Paused / scrubbing: snap tightly. Retargeting an in-flight seek is
      // desirable here (track the dragging cursor), so no seeking guard.
      this.el.currentTime = next.time;
    }

    void this.reconcilePlayState();
  }

  private async reconcilePlayState(): Promise<void> {
    // Wait out any pending play promise so we don't fight it.
    if (this.pendingPlay) {
      try { await this.pendingPlay; } catch { /* play() rejected, fall through */ }
    }
    if (this.disposed) return;

    // Re-check desired state — caller may have flipped it while we waited.
    if (this.desired.playing && this.el.paused) {
      const p = this.el.play().catch(() => { /* autoplay may be blocked */ });
      this.pendingPlay = p.finally(() => { this.pendingPlay = null; });
    } else if (!this.desired.playing && !this.el.paused) {
      this.el.pause();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (!this.el.paused) this.el.pause();
  }
}
