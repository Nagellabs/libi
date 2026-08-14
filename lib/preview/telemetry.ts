"use client";

import { useEffect } from "react";

/**
 * Preview-engine telemetry — a permanent, zero-cost-when-off instrumentation
 * layer for the editor's playback pipeline (decode ring, audio-master clock,
 * compositor, React loop). The preview is a core, frequently-revisited system;
 * this gives every future investigation a one-switch monitor instead of ad-hoc
 * console.logs.
 *
 * ## Toggling (any of these turns it on)
 *  1. **Env (deployment default):** `NEXT_PUBLIC_LIBI_PREVIEW_TELEMETRY=1`
 *     (inlined at build — set it in dev `.env` while working on preview perf).
 *  2. **Persisted runtime:** `localStorage["libi:preview-telemetry"] = "1"`.
 *  3. **Live, no reload:** `window.__libiPreviewTelemetry.enable()` in the console.
 *
 * When OFF, `recordPreviewEvent` is a single boolean check + early return, and no
 * PerformanceObservers are installed → zero overhead. It NEVER changes playback
 * behavior — pure observation.
 *
 * ## Console API (`window.__libiPreviewTelemetry`, always present)
 *  `enable()` / `disable()` / `isEnabled()` · `clear()` · `dump()` (raw events)
 *  · `summary()` (rollup) · `mark(label)` (segment a capture).
 *
 * ## What each signal tells you
 *  - `tick`     — audio-master clock cadence; `dFrame>1` = a dropped frame.
 *  - `getFrame` — `kind:"held"` while playing = video FROZE (decode underrun).
 *  - `pump`     — decode-ahead (re)starts; a burst = ring thrash.
 *  - `render`   — `renderFrame()` compositor cost (ms).
 *  - `audio`    — the schedule-pump's per-chunk decode/schedule cost.
 *  - `longtask` / `loaf` — main-thread blocks >50ms WITH attribution (the
 *    LoAF rows name the culprit script/function/invoker + style-vs-script split).
 *  - `summary().gc` — heap sawtooth vs stalls = the GC-pressure verdict.
 *
 * Typical use: `__libiPreviewTelemetry.enable()` → `clear()` → reproduce →
 * `summary()`. See `docs-local/superpowers/specs` / CLAUDE.md "Preview telemetry".
 */

export type PreviewEventType =
  | "tick"
  | "getFrame"
  | "pump"
  | "render"
  | "mark"
  | "longtask"
  | "audio"
  | "loaf"
  | "buffering"
  | "decoder"
  | "react-render";

export interface PreviewEvent {
  /** performance.now() at record time. */
  t: number;
  type: PreviewEventType;
  /** Source label (scene/overlay id) for getFrame/pump rows. */
  src?: string;
  /** Free-form marker label (type:"mark"). */
  label?: string;
  // ── tick ──
  /** Audio-master composition time (s). */
  audioTime?: number;
  /** Derived frame at this tick. */
  frame?: number;
  /** frame delta vs previous tick (>1 ⇒ counter jumped, 0 ⇒ clock stalled). */
  dFrame?: number;
  /** JS heap used (MB) at this tick — sawtooth-vs-longtask = GC discriminator. */
  heapMB?: number;
  // ── getFrame ──
  /** Requested source-local time (s). */
  req?: number;
  /** Returned frame timestamp (s), or -1 when nothing buffered. */
  got?: number;
  /** "live" (≤req), "ahead" (seek-landing nearest-ahead), "held" (stale last-good). */
  kind?: "live" | "ahead" | "held";
  /** True when getFrame returned the 2×2 BLANK canvas (nothing buffered AND no
   *  last-good) — a real black flash, distinct from a benign held frame. */
  black?: boolean;
  /** Ring earliest buffered ts (coversFrom), Infinity when empty. */
  from?: number;
  /** Ring latest buffered ts (coversThrough), -Infinity when empty. */
  thru?: number;
  /** Ring entry count. */
  n?: number;
  /** Staleness: got - req (s). Large magnitude while playing = wrong frame on screen. */
  gap?: number;
  // ── pump ──
  /** Pump origin (fromSec). */
  fromSec?: number;
  /** Why the pump (re)started. */
  reason?: string;
  // ── decoder (MediaBunny Input + CanvasSink/WebCodecs VideoDecoder lifecycle) ──
  /** "create" when a source's decoder spins up, "dispose" when it tears down.
   *  `src` carries the source id. Walked in `summary().decoders` to a running
   *  live count → peak CONCURRENT decoders, the Phase-0 metric that proves
   *  "N clips = N simultaneously-mounted decoders" (the decoder-session wall). */
  // (reuses the existing `label` field for "create" | "dispose")
  // ── render / longtask ──
  /** renderFrame() wall-clock duration (ms), or longtask duration (ms). */
  ms?: number;
  // ── audio (web-audio-engine schedule pump) ──
  /** Time the buffers() iterator took to yield this chunk (decode/await, ms). */
  yieldMs?: number;
  /** Synchronous cost of scheduling this chunk's AudioBufferSourceNode (ms). */
  schedMs?: number;
  // ── loaf (long-animation-frame: the modern, attributed long-task API) ──
  /** Render-blocking duration within the frame (ms). */
  blockingMs?: number;
  /** Style+layout duration within the frame (ms) — high ⇒ DOM/CSS thrash. */
  styleLayoutMs?: number;
  /** Dominant script's self-duration within the frame (ms). */
  scriptMs?: number;
  /** Dominant script's source function name. */
  fn?: string;
  /** Dominant script's source URL (basename). */
  url?: string;
  /** How the dominant script was invoked (e.g. user-callback, event-listener). */
  invokerType?: string;
}

/** Circular-buffer capacity — bounded memory; ~ enough for several seconds of
 *  full per-frame detail across the active sources. */
const CAP = 20000;

/**
 * Build-time env toggle. `NEXT_PUBLIC_*` is statically inlined by Next at build,
 * so this is the "always-on for this deployment" switch (e.g. set it in the dev
 * `.env` while actively working on preview rendering). The localStorage flag and
 * `__libiPreviewTelemetry.enable()` are the per-session runtime toggles on top.
 */
const ENV_ON = process.env.NEXT_PUBLIC_LIBI_PREVIEW_TELEMETRY === "1";
/** localStorage key for the persisted per-session runtime toggle. */
const LS_KEY = "libi:preview-telemetry";

let enabled = false;
let initialized = false;
let observersInstalled = false;
let ring: (PreviewEvent | undefined)[] = new Array(CAP);
let head = 0;
let count = 0;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function readLocalStorageFlag(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

/** One-time init: attach the always-present control API on `window`, compute the
 *  initial enabled state (env OR localStorage), and wire the observers if on. */
function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  installControlApi(); // always present, even when disabled, so enable() is reachable
  enabled = ENV_ON || readLocalStorageFlag();
  if (enabled) installObservers();
}

function isEnabled(): boolean {
  ensureInit();
  return enabled;
}

/** Runtime toggle (persisted to localStorage). Lets you flip telemetry mid-session
 *  from the console — `__libiPreviewTelemetry.enable()` — without a reload. */
function setEnabled(on: boolean): void {
  ensureInit();
  enabled = on;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY, on ? "1" : "0");
  } catch {
    /* private mode / SSR — ignore */
  }
  if (on) installObservers();
}

/** Install the PerformanceObserver-based attribution probes exactly once. */
function installObservers(): void {
  if (observersInstalled) return;
  observersInstalled = true;
  installLongtaskObserver();
  installLoafObserver();
}

/**
 * Hook: record one `react-render` event per render of the calling component.
 * `summary().reactRenders` then shows how many times each component re-rendered
 * during a capture — the direct measure of per-frame React churn (a component
 * at ~30/sec during playback is reconciling every frame and feeding the GC).
 * Zero cost when telemetry is off. Place the call at the TOP of the component.
 */
export function useReactRenderTelemetry(label: string): void {
  // No dependency array → runs after every render/commit of the host component.
  useEffect(() => {
    if (!isEnabled()) return;
    recordPreviewEvent({ t: nowMs(), type: "react-render", src: label });
  });
}

export function recordPreviewEvent(e: PreviewEvent): void {
  if (!isEnabled()) return;
  ring[head] = e;
  head = (head + 1) % CAP;
  if (count < CAP) count++;
}

function ordered(): PreviewEvent[] {
  const out: PreviewEvent[] = [];
  const start = count < CAP ? 0 : head;
  for (let i = 0; i < count; i++) {
    const e = ring[(start + i) % CAP];
    if (e) out.push(e);
  }
  return out;
}

function clear(): void {
  ring = new Array(CAP);
  head = 0;
  count = 0;
}

/** Compact per-source + per-tick rollup for fast eyeballing in the console. */
function summary() {
  const evs = ordered();
  const bySrc: Record<
    string,
    {
      total: number;
      live: number;
      ahead: number;
      held: number;
      black: number;
      longestHeldRun: number;
      maxAbsGap: number;
      pumps: number;
      pumpReasons: Record<string, number>;
    }
  > = {};
  let heldRun = 0;
  let curSrcForRun = "";
  let tickSkips = 0;
  let tickStalls = 0;
  let ticks = 0;

  for (const e of evs) {
    if (e.type === "tick") {
      ticks++;
      if ((e.dFrame ?? 0) > 1) tickSkips++;
      if ((e.dFrame ?? 0) === 0) tickStalls++;
      continue;
    }
    if (e.type === "getFrame") {
      const id = e.src ?? "?";
      const s =
        bySrc[id] ??
        (bySrc[id] = {
          total: 0,
          live: 0,
          ahead: 0,
          held: 0,
          black: 0,
          longestHeldRun: 0,
          maxAbsGap: 0,
          pumps: 0,
          pumpReasons: {},
        });
      s.total++;
      if (e.kind === "live") s.live++;
      else if (e.kind === "ahead") s.ahead++;
      else if (e.kind === "held") s.held++;
      if (e.black) s.black++;
      if (typeof e.gap === "number") s.maxAbsGap = Math.max(s.maxAbsGap, Math.abs(e.gap));
      // Held-run tracking (consecutive held getFrames on the same source).
      if (id !== curSrcForRun) {
        curSrcForRun = id;
        heldRun = 0;
      }
      if (e.kind === "held") {
        heldRun++;
        s.longestHeldRun = Math.max(s.longestHeldRun, heldRun);
      } else heldRun = 0;
      continue;
    }
    if (e.type === "pump") {
      const id = e.src ?? "?";
      const s =
        bySrc[id] ??
        (bySrc[id] = {
          total: 0,
          live: 0,
          ahead: 0,
          held: 0,
          black: 0,
          longestHeldRun: 0,
          maxAbsGap: 0,
          pumps: 0,
          pumpReasons: {},
        });
      s.pumps++;
      const r = e.reason ?? "?";
      s.pumpReasons[r] = (s.pumpReasons[r] ?? 0) + 1;
    }
  }
  // ── Loop-health analysis: where does the playback loop actually hitch? ──
  // renderFrame() cost distribution + inter-tick wall-clock gaps. A healthy
  // 60Hz rAF loop ticks every ~16.7ms; an inter-tick gap > ~32ms means the
  // loop missed a frame deadline (a dropped/skipped frame) — the objective
  // "stutter". Correlating the gap with the renderFrame ms recorded just
  // before it separates "renderFrame is slow" from "something ELSE on the
  // main thread blocked the loop" (e.g. a heavy React commit, GC, the budget
  // effect, audio scheduling).
  const renderMs: number[] = [];
  const tickEvents: PreviewEvent[] = [];
  for (const e of evs) {
    if (e.type === "render" && typeof e.ms === "number") renderMs.push(e.ms);
    if (e.type === "tick") tickEvents.push(e);
  }
  renderMs.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) =>
    arr.length ? +arr[Math.min(arr.length - 1, Math.floor(p * arr.length))].toFixed(2) : 0;

  const t0 = tickEvents.length ? tickEvents[0].t : 0;
  const bigGaps: {
    dtMs: number;
    atSec: number;
    frame?: number;
    dFrame?: number;
    heapBefore?: number;
    heapAfter?: number;
    heapDelta?: number;
  }[] = [];
  for (let i = 1; i < tickEvents.length; i++) {
    const dt = tickEvents[i].t - tickEvents[i - 1].t;
    if (dt > 32) {
      const hb = tickEvents[i - 1].heapMB;
      const ha = tickEvents[i].heapMB;
      bigGaps.push({
        dtMs: +dt.toFixed(1),
        atSec: +((tickEvents[i].t - t0) / 1000).toFixed(2),
        frame: tickEvents[i].frame,
        dFrame: tickEvents[i].dFrame,
        heapBefore: hb,
        heapAfter: ha,
        heapDelta: hb != null && ha != null ? +(ha - hb).toFixed(2) : undefined,
      });
    }
  }
  bigGaps.sort((a, b) => b.dtMs - a.dtMs);
  const earlyGaps = bigGaps.filter((g) => g.atSec < 1).length; // first 1s of play
  const lateGaps = bigGaps.length - earlyGaps;

  // ── GC discriminator: does the heap sawtooth in lockstep with the stalls? ──
  // Sample the used JS heap each tick. If it climbs steadily then DROPS right at
  // a long-task stall, that stall is a garbage collection (the fix is reducing
  // per-frame allocation). If the heap does NOT drop at the stalls, the 66ms is
  // a compute/re-render, not GC.
  const heaps = tickEvents
    .map((e) => e.heapMB)
    .filter((h): h is number => typeof h === "number");
  const spanSec = tickEvents.length
    ? (tickEvents[tickEvents.length - 1].t - t0) / 1000
    : 0;
  // Count of distinct downward steps in the heap series (GC reclaims).
  let heapDrops = 0;
  let biggestDropMB = 0;
  for (let i = 1; i < heaps.length; i++) {
    const d = heaps[i] - heaps[i - 1];
    if (d < -0.3) {
      heapDrops++;
      biggestDropMB = Math.max(biggestDropMB, -d);
    }
  }
  const gapsWithHeapDrop = bigGaps.filter(
    (g) => typeof g.heapDelta === "number" && g.heapDelta < -0.3,
  ).length;

  // Long tasks (>50ms main-thread blocks) and audio-pump bursts, with their
  // time relative to the first tick so they can be lined up against loop.worst.
  const longtasks = evs
    .filter((e) => e.type === "longtask")
    .map((e) => ({ ms: e.ms ?? 0, atSec: +((e.t - t0) / 1000).toFixed(2), label: e.label || "" }))
    .sort((a, b) => b.ms - a.ms);
  const audioEvs = evs.filter((e) => e.type === "audio");
  let maxYieldMs = 0;
  let maxSchedMs = 0;
  const audioBursts = audioEvs
    .map((e) => {
      maxYieldMs = Math.max(maxYieldMs, e.yieldMs ?? 0);
      maxSchedMs = Math.max(maxSchedMs, e.schedMs ?? 0);
      return {
        src: e.src,
        yieldMs: e.yieldMs ?? 0,
        schedMs: e.schedMs ?? 0,
        atSec: +((e.t - t0) / 1000).toFixed(2),
      };
    })
    .sort((a, b) => Math.max(b.yieldMs, b.schedMs) - Math.max(a.yieldMs, a.schedMs));

  // ── Buffering (decode-backpressure gate) ──────────────────────────────────
  // Pair each `enter` with the next `exit` to get the hold durations. On healthy
  // hardware this should be ~0 for an easy scene; a high count/totalMs is the
  // gate firing often = a real decode-pipeline problem surfacing honestly (chase
  // it with this count as evidence, not guesswork).
  const bufferingDurations: number[] = [];
  let bufEnterAt: number | null = null;
  for (const e of evs) {
    if (e.type !== "buffering") continue;
    if (e.label === "enter") bufEnterAt = e.t;
    else if (e.label === "exit" && bufEnterAt != null) {
      bufferingDurations.push(e.t - bufEnterAt);
      bufEnterAt = null;
    }
  }
  const bufferingTotalMs = bufferingDurations.reduce((a, b) => a + b, 0);

  // ── Decoder concurrency: the Phase-0 "decoder-session wall" metric ──────────
  // Walk create/dispose in time order, maintain a running live count → peak
  // CONCURRENT decoders during the capture. peakConcurrent ≈ clip count is the
  // smoking gun (every timeline clip mounts a decoder for the whole session,
  // regardless of distance from the playhead). After Phase 1A this should track
  // (active + warm + near), NOT total clip count.
  let decCreated = 0;
  let decDisposed = 0;
  let decLive = 0;
  let decPeak = 0;
  let decPeakAtSec = 0;
  for (const e of evs) {
    if (e.type !== "decoder") continue;
    if (e.label === "create") {
      decCreated++;
      decLive++;
      if (decLive > decPeak) {
        decPeak = decLive;
        decPeakAtSec = +((e.t - t0) / 1000).toFixed(2);
      }
    } else if (e.label === "dispose") {
      decDisposed++;
      decLive = Math.max(0, decLive - 1);
    }
  }

  // Per-component React re-render counts (from useReactRenderTelemetry). A
  // component at ~ticks/sec re-rendered every playback frame; ~0 = memoized/idle.
  const reactRenders: Record<string, number> = {};
  for (const e of evs) {
    if (e.type === "react-render") {
      const id = e.src ?? "?";
      reactRenders[id] = (reactRenders[id] ?? 0) + 1;
    }
  }

  return {
    events: evs.length,
    ticks,
    tickSkips,
    tickStalls,
    bySrc,
    // Decode-backpressure gate firing rate. count ≈ 0 on healthy HW for an easy
    // scene; a high count/totalMs = the gate is masking a real underrun.
    buffering: {
      count: bufferingDurations.length,
      totalMs: +bufferingTotalMs.toFixed(1),
      maxMs: bufferingDurations.length ? +Math.max(...bufferingDurations).toFixed(1) : 0,
    },
    // Decoder concurrency over the capture. `peakConcurrent` ≈ clip count BEFORE
    // Phase 1A (every clip mounts a decoder for the session); ≈ active+warm+near
    // AFTER. `created` ≫ `peakConcurrent` after 1A = healthy churn (re-mount on
    // approach); `created` spiking with no playhead movement = dispose↔attach
    // flap (Trap: per-tick churn).
    decoders: {
      created: decCreated,
      disposed: decDisposed,
      live: decLive, // still-mounted at capture end
      peakConcurrent: decPeak,
      peakAtSec: decPeakAtSec,
    },
    reactRenders, // {ComponentName: renderCount over the capture}
    // renderFrame() wall-clock cost (ms): is the compositor itself slow?
    render: {
      count: renderMs.length,
      p50: pct(renderMs, 0.5),
      p95: pct(renderMs, 0.95),
      max: renderMs.length ? +renderMs[renderMs.length - 1].toFixed(2) : 0,
    },
    // Playback-loop hitches: inter-tick gaps > 32ms (= a dropped frame).
    loop: {
      droppedFrames: bigGaps.length,
      maxGapMs: bigGaps[0]?.dtMs ?? 0,
      earlyDrops: earlyGaps, // in first 1s (start-of-play)
      lateDrops: lateGaps, // after 1s
      worst: bigGaps.slice(0, 8), // {dtMs, atSec, frame, dFrame, heapBefore/After/Delta}
    },
    // GC verdict. If `gapsWithHeapDrop` ≈ `droppedFrames` and the heap sawtooths
    // (heapDrops ~1/sec, growthMBPerSec > 0), the 1-Hz stutter IS garbage
    // collection → fix = cut per-frame allocation. If gapsWithHeapDrop ≈ 0, the
    // stalls are compute/re-render, not GC.
    gc: {
      heapSamples: heaps.length,
      heapMinMB: heaps.length ? Math.min(...heaps) : 0,
      heapMaxMB: heaps.length ? Math.max(...heaps) : 0,
      growthMBPerSec:
        heaps.length && spanSec > 0
          ? +(((heaps[heaps.length - 1] - heaps[0]) / spanSec)).toFixed(2)
          : 0,
      heapDrops, // # of downward heap steps (GC reclaims) in the window
      biggestDropMB: +biggestDropMB.toFixed(2),
      gapsWithHeapDrop, // # of dropped-frame stalls where the heap fell (GC-coincident)
    },
    // Objective main-thread blocks (>50ms). Line atSec up against loop.worst.
    longtask: {
      count: longtasks.length,
      maxMs: longtasks[0]?.ms ?? 0,
      worst: longtasks.slice(0, 8), // {ms, atSec, label}
    },
    // Audio schedule-pump bursts (decode + node scheduling). If these atSec
    // line up with loop.worst, the audio pump is the frame-dropper.
    audio: {
      bursts: audioEvs.length,
      maxYieldMs: +maxYieldMs.toFixed(2),
      maxSchedMs: +maxSchedMs.toFixed(2),
      worst: audioBursts.slice(0, 8), // {src, yieldMs, schedMs, atSec}
    },
    // THE attribution: Long Animation Frames name the culprit script + split
    // script-time vs style/layout-time. `worst` lists the heaviest frames with
    // the dominant function/url/invoker and styleLayout vs script breakdown.
    loaf: {
      count: evs.filter((e) => e.type === "loaf").length,
      worst: evs
        .filter((e) => e.type === "loaf")
        .map((e) => ({
          ms: e.ms ?? 0,
          atSec: +((e.t - t0) / 1000).toFixed(2),
          blockingMs: e.blockingMs ?? 0,
          styleLayoutMs: e.styleLayoutMs ?? 0,
          scriptMs: e.scriptMs ?? 0,
          fn: e.fn || "",
          url: e.url || "",
          invokerType: e.invokerType || "",
        }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10),
    },
  };
}

/** Capture main-thread long tasks (>50ms) — these are exactly the blocks that
 *  make the rAF playback loop miss frame deadlines. `entry.startTime` shares
 *  the same time origin as `performance.now()`, so it correlates with tick/loop
 *  timestamps. Attribution is best-effort (Chrome exposes only container info). */
function installLongtaskObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const attr = (entry as unknown as { attribution?: Array<{ name?: string; containerType?: string; containerName?: string }> }).attribution?.[0];
        recordPreviewEvent({
          t: entry.startTime,
          type: "longtask",
          ms: +entry.duration.toFixed(1),
          label: attr?.containerName || attr?.name || attr?.containerType || "",
        });
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask entry type unsupported — skip */
  }
}

/** Long Animation Frame observer — the modern attributed long-task API. Each
 *  entry exposes the frame's blocking/style-layout durations AND a `scripts[]`
 *  array naming the source function/URL/invoker that ran. This is the
 *  telemetry-native equivalent of a DevTools profile: it tells us EXACTLY what
 *  the periodic 66ms task is (a React commit, a draw fn, an async decode
 *  callback, style/layout thrash, …). */
function installLoafObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  type ScriptTiming = {
    duration: number;
    sourceFunctionName?: string;
    sourceURL?: string;
    invoker?: string;
    invokerType?: string;
  };
  type LoafEntry = PerformanceEntry & {
    duration: number;
    blockingDuration?: number;
    styleAndLayoutDuration?: number;
    scripts?: ScriptTiming[];
  };
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LoafEntry[]) {
        if (e.duration < 50) continue;
        const scripts = e.scripts ?? [];
        let top: ScriptTiming | undefined;
        for (const s of scripts) if (!top || s.duration > top.duration) top = s;
        const base = (top?.sourceURL || "").split("/").slice(-1)[0]?.split("?")[0] || "";
        recordPreviewEvent({
          t: e.startTime,
          type: "loaf",
          ms: +e.duration.toFixed(1),
          blockingMs: e.blockingDuration != null ? +e.blockingDuration.toFixed(1) : undefined,
          styleLayoutMs: e.styleAndLayoutDuration != null ? +e.styleAndLayoutDuration.toFixed(1) : undefined,
          scriptMs: top ? +top.duration.toFixed(1) : undefined,
          fn: top?.sourceFunctionName || top?.invoker || "",
          url: base,
          invokerType: top?.invokerType || "",
        });
      }
    });
    obs.observe({ entryTypes: ["long-animation-frame"] });
  } catch {
    /* LoAF entry type unsupported (needs Chrome 123+) — skip */
  }
}

/** Attach the always-present console control surface (`window.__libiPreviewTelemetry`).
 *  Present even when telemetry is disabled so an investigator can `enable()` at
 *  runtime. The observers/recording are gated separately by `enabled`. */
function installControlApi(): void {
  if (typeof window === "undefined") return;
  (window as unknown as { __libiPreviewTelemetry?: unknown }).__libiPreviewTelemetry = {
    /** Turn recording on (persists to localStorage) + install observers. */
    enable: () => setEnabled(true),
    /** Turn recording off (persists). Keeps the captured buffer for inspection. */
    disable: () => setEnabled(false),
    /** Current on/off state. */
    isEnabled: () => enabled,
    /** Reset the captured event buffer. */
    clear,
    /** Ordered copy of every captured event. */
    dump: ordered,
    /** Compact rollup keyed for fast eyeballing — see `summary()` below. */
    summary,
    /** Push a labelled marker event (segments a capture: `mark("before-fix")`). */
    mark: (label: string) => recordPreviewEvent({ t: nowMs(), type: "mark", label }),
  };
}

// Bootstrap on module load: always attaches the control API; starts recording
// immediately when the env flag or the persisted localStorage flag is set.
ensureInit();
