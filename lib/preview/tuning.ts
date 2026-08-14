/**
 * Centralized preview decode-ahead / playback tuning constants.
 *
 * The WebCodecs preview engine is a single-path system now (no flag, no
 * legacy), so the knobs that shape decode-ahead depth, the source budget,
 * and audio scheduling live here in one place — discoverable and adjustable
 * without grepping across the engine, the hooks, and the audio scheduler.
 *
 * Each value carries the reasoning behind it; changing one is a deliberate
 * trade-off, not a magic-number tweak.
 */

/**
 * FrameRing depth, in frames. Holds ~`LOOKAHEAD_SEC` of decoded runway plus a
 * small cushion so the synchronous compositor (`getFrame`) always finds a
 * frame at-or-before the playhead. 24 ≈ 0.8s at 30fps — comfortably above the
 * 0.6s decode lookahead, bounded so we never pin many large canvases in memory.
 */
export const RING_CAPACITY = 24;

/**
 * Max span (seconds) the FrameRing may hold between its oldest and newest frame.
 * In normal play the ring spans only ~`RING_CAPACITY/fps` (≈0.8s), so this never
 * triggers. It exists purely as the SCRUB-POLLUTION guard: dragging the timeline
 * primes a frame at every swept position, and capacity-eviction (lowest-first)
 * lets a far-future leftover (e.g. a 4.4s frame while the playhead is at 1.0s)
 * squat in the ring — wasting slots and forcing the playhead-region frames to be
 * evicted early, which serves frames out of order on the next play (the
 * scrub-then-play flicker). 2.0s is comfortably above the normal span and below
 * any real scrub leftover distance.
 */
export const MAX_RING_SPAN_SEC = 2.0;

/**
 * Decode-ahead horizon, in seconds. The per-source pump keeps decoding until
 * it is this far ahead of the last-requested time, then parks. 0.6s covers the
 * worst single-frame decode + rAF jitter while staying small enough that
 * several sources decoding at once don't thrash the GPU/CPU.
 */
export const LOOKAHEAD_SEC = 0.6;

/**
 * Coverage epsilon, in seconds. Slack when deciding whether the ring already
 * "covers" a requested time, so floating-point frame-time jitter doesn't trip
 * a needless pump restart. 0.05s ≈ 1.5 frames at 30fps.
 */
export const COVERAGE_EPS = 0.05;

/**
 * Backward-jump restart tolerance, in seconds.
 *
 * A parked decode-ahead pump can't decode BACKWARD to fill a time before its
 * buffered window, so a genuine backward seek (scrub-back) must clear + restart
 * the pump. BUT a request only *marginally* before the window's earliest frame
 * is NOT a backward seek — it's the seek-landing gap: after seeking to a clip's
 * `trim.start` (e.g. 6.000s) the decoder's first available frame is the nearest
 * real frame at/after it (e.g. 6.083s — videos rarely have a frame at an exact
 * trim boundary), so the playhead momentarily sits a few-dozen ms *before*
 * `earliest`. Treating that as a backward jump triggers a `clear()` + re-seek
 * that lands on the same 6.083 frame → `t < earliest` again → restart again,
 * ~18×/s — a self-inflicted thrash that empties the ring and stutters every
 * non-frame-aligned clip start (which is essentially every stitched clip).
 *
 * So the backward-restart only fires when the playhead is behind `earliest` by
 * MORE than this tolerance (a real scrub-back). Smaller gaps are absorbed: the
 * forward pump keeps its buffer and `getFrame` serves the nearest frame. 0.5s
 * comfortably exceeds any first-frame landing gap while staying well under an
 * intentional scrub. Diagnosed empirically: see the WebCodecs preview engine
 * jitter investigation (seek-landing restart thrash, ~18 restarts/s).
 */
export const BACKWARD_RESTART_TOLERANCE_SEC = 0.5;

/**
 * How far AHEAD of the playhead `getFrame` may serve a decoded frame **while
 * playing**, in seconds.
 *
 * The ring legitimately decodes ahead, and the seek-landing fallback
 * (`selectAtOrNearestAhead`) shows the nearest upcoming frame when nothing is at
 * or before the requested time. That fallback is bounded by a tolerance. While
 * PAUSED that tolerance is `BACKWARD_RESTART_TOLERANCE_SEC` (0.5s) so a scrub
 * lands on its frame even when the only decoded frame is a few hundred ms ahead.
 *
 * But while PLAYING, serving a frame up to 0.5s ahead is exactly the visible
 * "one-frame re-painting" glitch: when the ring briefly runs behind the
 * playhead, the picture JUMPS forward ~15 frames then snaps back as the decoder
 * catches up (measured: `ahead` 162, `maxAbsGap` 0.5 on a real session). So
 * while playing we serve at most this far ahead (~3-4 frames); beyond it,
 * `getFrame` HOLDS the last good frame — a brief, smooth freeze rather than a
 * forward jump — and a *sustained* lag trips the buffering gate (hold the clock +
 * spinner). Small enough to never show a perceptibly-future frame; large enough
 * to absorb normal sub-frame decode jitter without holding on every tick.
 */
export const AHEAD_SERVE_PLAYING_SEC = 0.12;

/**
 * Preview decode quality (a per-device performance preference, persisted in
 * editor-state localStorage; user-settable in Settings → General).
 *
 *  - `"auto"` — resolution-aware: decode at `min(sourceHeight, 1080)`. Matches
 *    the 1080p proxy we already store and never upscales. The default.
 *  - `"720p"` — cap decode at 720p. Cheaper for low-spec machines; the agent
 *    suggests this when a user reports laggy/stuttering preview.
 *
 * Exports always read the ORIGINAL at native resolution (the proxy invariant);
 * this knob is preview-only.
 */
export type PreviewQuality = "auto" | "720p";

/** Decode-height cap for the resolution-aware `"auto"` quality. */
export const PREVIEW_MAX_HEIGHT_AUTO = 1080;
/** Decode-height cap for the low-spec `"720p"` quality. */
export const PREVIEW_MAX_HEIGHT_LOW = 720;

/** The decode-height cap for a given preview-quality preference. */
export function previewMaxHeight(quality: PreviewQuality): number {
  return quality === "720p" ? PREVIEW_MAX_HEIGHT_LOW : PREVIEW_MAX_HEIGHT_AUTO;
}

/**
 * Resolution-aware decode height: never upscale (decode at the source's own
 * height when it's already ≤ the cap), and never exceed the cap. An unknown
 * source height (0/undefined — track dims not yet read) falls back to the cap.
 */
export function resolveDecodeHeight(
  sourceHeight: number | null | undefined,
  maxHeight: number,
): number {
  if (!sourceHeight || sourceHeight <= 0) return maxHeight;
  return Math.min(sourceHeight, maxHeight);
}

/**
 * Decode-height buckets (Phase 2 — decode by on-screen size). A video shown in a
 * SMALL rect (PIP / split-screen inset) shouldn't decode at full source height:
 * decode is ~quadratic in height, so a 320-px PIP at 360 vs 1080 is ~9× cheaper +
 * ~9× less memory — the lever that makes many parallel small videos affordable.
 * Coarse buckets (not the exact rect height) so a resize only re-attaches the
 * decoder when it crosses a bucket, never per pixel of a drag (reattach churn).
 */
export const DECODE_HEIGHT_BUCKETS = [360, 540, 720, 1080] as const;

/**
 * Bucketed decode-height cap for a source shown at `neededHeightPx` (its rect
 * height, in COMPOSITION pixels — a safe upper bound on displayed pixels), never
 * exceeding `cap` (the preview-quality cap). Full-frame rects land in the top
 * bucket ⇒ no change from `cap`; small PIP rects drop to a small bucket. Snapping
 * UP to the next bucket keeps the preview from looking soft at the rect's size.
 */
export function bucketDecodeHeight(neededHeightPx: number, cap: number): number {
  if (!neededHeightPx || neededHeightPx <= 0) return cap; // unknown → full cap
  for (const b of DECODE_HEIGHT_BUCKETS) {
    if (b >= neededHeightPx) return Math.min(b, cap);
  }
  return cap;
}

/**
 * Source budget cap K — the max number of simultaneously-active decoded
 * sources (active + warm). Beyond this the planner demotes the farthest
 * sources to cold. 3 = the active clip + the next ~2 across an upcoming cut,
 * which is the most a browser decodes smoothly at once.
 */
export const SOURCE_BUDGET_K = 3;

/**
 * Warm-ahead horizon, in seconds, for the source budget. A source whose clip
 * starts within this window of the playhead is kept warm (primed) so its first
 * frame is decoded before the cut reaches it.
 *
 * Widened 1.0 → 2.5s (Phase 1A): 1.0s was too short to decode a COLD clip up to
 * the gate's START_MARGIN (0.5s) runway before the playhead reached it —
 * especially across a timeline GAP (all sources go cold in the gap, then the next
 * cluster cold-starts on arrival → the readiness gate holds ~1.5s = the reported
 * mid-play buffering at a cut after a gap; see the Phase-0 baseline note). 2.5s
 * gives a cold clip ample time to warm + park a runway before it activates. The
 * concurrent WARM count is still capped by SOURCE_BUDGET_K (warm slots =
 * max(0, K - active)), so a wider horizon only warms the NEAREST upcoming clips
 * EARLIER — it does not increase simultaneous decode load. Must stay ≤
 * MOUNT_AHEAD_SEC so an upcoming clip is mounted before it tries to warm.
 */
export const WARM_AHEAD_SEC = 2.5;

/**
 * Proximity MOUNT horizon (Phase 1A), in seconds. A clip is given a live decoder
 * when it starts within this window ahead of the playhead (so it exists in time
 * to warm), stays mounted while active, and for MOUNT_BEHIND_SEC after it ends.
 * Everything else is disposed — so a timeline of N cut/duplicate clips no longer
 * holds N simultaneous decoders (only active + near). ≥ WARM_AHEAD_SEC so a clip
 * is mounted before `warm()` runs on it. See `lib/preview/mount-window.ts`.
 */
export const MOUNT_AHEAD_SEC = 3.0;

/** Keep a just-ended clip's decoder mounted this many seconds after it ends, so a
 *  short scrub-back re-shows it without a cold re-decode. */
export const MOUNT_BEHIND_SEC = 1.5;

/** Hysteresis margin (seconds) added to BOTH mount horizons for the DISPOSE
 *  decision: a clip mounts at the horizon but is only disposed once it drifts
 *  `MOUNT_HYSTERESIS_SEC` beyond it — so a source parked right at the boundary
 *  never flap-mounts (the per-tick churn Trap). */
export const MOUNT_HYSTERESIS_SEC = 1.5;

/** Cap on retained last-good thumbnails (one small canvas per recently-disposed
 *  source) used to seed `adoptLastGood` on re-mount so a scrub-back never
 *  black-flashes. Bounded so the retention itself can't defeat the memory win. */
export const MOUNT_THUMB_CACHE = 8;

/**
 * Debounce (ms) before the paused settle-warm fires. While PAUSED, once the
 * playhead has RESTED this long, the active sources warm a runway so a subsequent
 * play() is instant (the readiness gate can't build runway during its hold —
 * playing=false there, so a cold press-play otherwise times out at ~MAX_GATE_MS).
 * The debounce is the safety: a scrub streams frame changes that keep resetting
 * the timer, so warm NEVER fires mid-drag (the "extra frames" artifact) — only
 * ~this long after the playhead comes to rest (load / scrub-release). 250ms is
 * short enough to be ready before a human presses play, long enough to never
 * mistake a scrub for a rest.
 */
export const PAUSED_WARM_SETTLE_MS = 250;

/**
 * Audio schedule-ahead horizon, in seconds. The per-clip audio pump stays this
 * far ahead of `ctx.currentTime` when scheduling decoded AudioBuffer chunks —
 * deep enough to absorb decode jitter without audible gaps, shallow enough that
 * a seek/pause discards little already-scheduled audio.
 */
export const SCHEDULE_AHEAD_S = 1.0;

/**
 * Delay (ms) after an effect is selected before the preview plays its window —
 * lets the PATCH→SSE→refetch land so the NEW effect renders from the window's
 * first frame. Re-selecting the same effect replays after the same settle.
 */
export const EFFECT_PREVIEW_SETTLE_MS = 300;

/**
 * Preview supersample cap — the max canvas-backing multiplier PER CSS pixel.
 *
 * The preview canvas backing store is `displaySize × min(devicePixelRatio, this)`
 * so vector/text/code/3D overlays rasterize at the real screen resolution (crisp
 * on HiDPI) instead of the fixed logical 1080 (which CSS-upscaled → blur). Capped
 * at 2 because beyond 2× per CSS pixel the eye can't tell but the GPU pays full
 * fill cost every frame. A 1×-DPR screen renders at display size (cheaper than the
 * old fixed 1080); only a large HiDPI preview approaches the cap. Export ignores
 * this entirely (it renders at the true target resolution). Code-tunable only —
 * intentionally NOT a user setting (the surface stays small).
 */
export const PREVIEW_SUPERSAMPLE_CAP = 2;

/**
 * Adaptive-downscale thresholds. If the compositor blows the per-frame budget on
 * a sustained fraction of frames (a weak GPU on a huge preview), the effective
 * supersample cap halves toward 1 to keep playback smooth, then restores with
 * hysteresis once frames are healthy again. Preview-only; export never adapts.
 *
 *  - `SLOW_FRACTION`: fraction of frames in a 1s window whose compositor time
 *    exceeds the frame budget (1000/fps) that marks the window "stressed".
 *  - `DROP_TICKS`: consecutive stressed 1s windows before dropping the cap.
 *  - `RECOVER_TICKS`: consecutive healthy 1s windows before restoring the cap.
 * The asymmetry (drop fast, recover slow) prevents flapping.
 */
export const SUPERSAMPLE_SLOW_FRACTION = 0.2;
export const SUPERSAMPLE_DROP_TICKS = 3;
export const SUPERSAMPLE_RECOVER_TICKS = 6;
/** The 1s cadence at which dropped-frame stats are sampled and the controller stepped. */
export const SUPERSAMPLE_TICK_MS = 1000;
