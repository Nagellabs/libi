/**
 * The export's LayerSource (spec §4.6): frame-exact. Before each frame the
 * export loop calls `settle(collectLayerRequests(...), at)`, which posts the
 * renders one after another and resolves once each overlay has answered —
 * with a bitmap, an error, or a watchdog timeout — so the synchronous
 * `renderFrame` that follows always finds exactly frame N, or a recorded
 * failure for it (which the export reports as a dropped overlay). Output stays
 * deterministic.
 *
 * Like PreviewLayerSource it takes the sandbox's `render` as a function and
 * exposes `onLayer` / `onError` / `onTimeout` / `onRestart` /
 * `onUnattributed` for the OverlaySandbox's event options to call;
 * render-entry.ts wires the two together.
 *
 * A watchdog timeout restarts the WORKER, and the host abandons every render
 * in flight with it — not only the offender's. Those overlays are not
 * failures: they wait for the fresh worker (and for `reloadAll` to re-load
 * every body into it), then post again. The wait is bounded so a supervisor
 * that never answers cannot hang an export.
 *
 * It also keeps what the agent needs afterwards (spec §4.7): the first
 * failure per overlay with the composition second it failed at, the
 * composition frames each overlay rendered cleanly (what lets a clean
 * `libi.render_overlay_frames` retire an old diagnostic), and the runtime's
 * unattributed diagnostics. `buildExportDiagnosticsReport` turns that into the
 * render page's postback.
 */
import { sameLayerRequest, type LayerBitmap, type LayerRequest, type LayerSource } from "@/lib/engine/layer-source";
import { roundToMs } from "@/lib/engine/overlay-timing";
import {
  MAX_DIAGNOSTICS_PER_PIECE,
  MAX_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_UNATTRIBUTED_PER_PIECE,
  type ExportDiagnosticsReport,
  type ExportRenderDiagnostic,
} from "@/lib/render/render-diagnostics-types";
import type { OverlaySandboxOptions, RenderInput } from "./host";
import { LOAD_TIMEOUT_MS, RENDER_TIMEOUT_MS } from "./host";
import type { BodyKind, ErrorMessage, ErrorPhase, LayerMessage, UnattributedMessage } from "./protocol";

export interface LayerFailure {
  phase: ErrorPhase;
  message: string;
  line?: number;
  column?: number;
  /** Composition seconds of the frame that failed — `render` failures that
   *  answered a request (or timed out on one) only. */
  time?: number;
  /** That frame's absolute index — set whenever `time` is. */
  frame?: number;
}

export interface UnattributedFailure {
  message: string;
  line?: number;
  column?: number;
}

/** Where the export is: the composition frame index and its second. */
export interface SettleAt {
  frame: number;
  time: number;
}

export interface ExportLayerSourceOptions {
  /** Re-load every body into a fresh worker after a restart; resolves once
   *  each load has settled. Renders the restart abandoned wait for it. */
  reloadAll?: () => Promise<void>;
  /** Longest an abandoned render waits for the restart before it is tried
   *  again anyway (and, if nothing came back, fails as not loaded). */
  restartWaitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Outcome = "layer" | "failed" | "abandoned";

interface Waiter {
  request: LayerRequest;
  req: number;
  at: SettleAt;
  resolve: (outcome: Outcome) => void;
}

/**
 * What the export's OverlaySandbox is built with beyond its transport and
 * events (re-review 2, R2-M1): a dead frame is NOT replaced — its first death
 * fails the export through `onFrameLost` (`FRAME_DIED_MESSAGE`, or
 * `frameDiedMessage` naming the overlay the frame died recovering from).
 *
 * Chosen over waiting up to the export's 20 s for a replacement's `ready`,
 * because failing is one path with no race. A replacement is held to the
 * host's load deadline (60 s) and boot deadline (15 s), and this source's
 * restart wait (10 s × 3 attempts) runs beside them. Waiting would make the
 * outcome depend on which clock fired first, and a hung load always lost that
 * race: the export finished with every body listed as dropped, which I3
 * forbids.
 *
 * The cost is real, and it is NOT that a replacement would go down too
 * (sandbox re-review 3, R3-M2). A body that exhausts memory takes the
 * frame's renderer process down during its OWN render: the watchdog drops
 * that body before the death is declared, so a replacement would not replay
 * it, and such an export used to finish with only that body listed as
 * dropped. It now fails instead, and fails the same way on every run while the
 * body is unchanged. That is why the host names the overlay it was
 * recovering from in the failure (`frameDiedMessage`) and says to fix or
 * remove its code; only a death with no suspect says "export again". No
 * preview notice is wired either (`onFrameStarting`): the export's own 20 s
 * budget already fails a sandbox that never comes up.
 *
 * A frame can also stay up while its worker never comes back — the
 * supervisor answers every ping but no fresh worker says `ready` (a worker it
 * cannot create under memory pressure). That is no frame death, so before
 * R3-M3 the restart wait below ran out and the export finished with every
 * body listed as dropped. `workerRestartTimeoutMs` makes the host fail it the
 * same way instead (`workerNotRestartedMessage`).
 */
export const EXPORT_SANDBOX_OPTIONS = {
  maxFrameRemounts: 0,
  workerRestartTimeoutMs: 9_000,
} as const satisfies Partial<OverlaySandboxOptions>;

/** Longest a render the restart abandoned waits before it is tried again.
 *  The export's `workerRestartTimeoutMs` sits below it, so a worker that is
 *  not coming back fails the export before any render is retried on no
 *  worker; and above the ~7 s a frame death takes to confirm, so a dead frame
 *  is reported as one. */
export const DEFAULT_RESTART_WAIT_MS = 10_000;
/** A render abandoned by this many restarts in a row is given up on. */
const MAX_ATTEMPTS = 3;
/** Clean ranges kept per overlay; past it the record simply stops growing
 *  (it can then retire fewer diagnostics, never a wrong one). */
const MAX_CLEAN_RANGES = 256;

export const NOT_LOADED_MESSAGE = "the overlay runtime did not load this body";
export const RESTARTED_MESSAGE = "the overlay runtime restarted repeatedly while rendering this frame";

function positioned(base: { phase: ErrorPhase; message: string }, line?: number, column?: number): LayerFailure {
  return { ...base, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

/** RenderInput from a LayerRequest. Spread, never hand-copied: every field the
 *  request carries — `pad` above all, tracked code renders offset without it —
 *  reaches the runtime. */
function toRenderInput(req: LayerRequest): RenderInput {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { overlayId, kind, ...rest } = req;
  return { id: overlayId, ...rest };
}

export class ExportLayerSource implements LayerSource {
  /** The FIRST failure per overlay over the whole export — what the agent is
   *  told about. A load-phase failure is replaced by anything later (the body
   *  got past it) and forgotten when the body renders cleanly. */
  readonly failures = new Map<string, LayerFailure>();
  /** Composition frames each overlay rendered cleanly, `[start, end)`. */
  readonly cleanFrames = new Map<string, Array<[number, number]>>();
  /** Runtime diagnostics no overlay can be blamed for, newest last. */
  readonly unattributed: UnattributedFailure[] = [];
  private readonly frameFailures = new Map<string, LayerFailure>();
  private readonly held = new Map<string, { layer: LayerBitmap; request: LayerRequest }>();
  private readonly waiting = new Map<string, Waiter>();
  private restarting: { promise: Promise<void>; resolve: () => void; timer: unknown } | null = null;
  private disposed = false;
  /** Set once the sandbox's frame is lost for good (`onFrameLost`). */
  private lost: string | null = null;
  private readonly restartWaitMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /** `post` is `OverlaySandbox.render`: returns the req id, or -1 when it did
   *  not send (not loaded, dropped, destroyed). */
  constructor(
    private readonly post: (input: RenderInput) => number,
    private readonly opts: ExportLayerSourceOptions = {},
  ) {
    this.restartWaitMs = opts.restartWaitMs ?? DEFAULT_RESTART_WAIT_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ── sandbox events ────────────────────────────────────────────────────────

  onLayer(msg: LayerMessage): void {
    const w = this.waiting.get(msg.id);
    if (!w || w.req !== msg.req) {
      // Not the render this frame is waiting on: nothing to place it by.
      msg.bitmap.close();
      return;
    }
    this.waiting.delete(msg.id);
    this.dropBitmap(msg.id);
    const { size, pixelRatio, pad } = w.request;
    this.held.set(msg.id, {
      layer: { frame: msg.frame, bitmap: msg.bitmap, size, pixelRatio, ...(pad ? { pad } : {}) },
      request: w.request,
    });
    const prev = this.failures.get(msg.id);
    if (prev && prev.phase !== "render") this.failures.delete(msg.id);
    w.resolve("layer");
  }

  onError(msg: ErrorMessage): void {
    const w = this.waiting.get(msg.id);
    if (msg.phase === "render") {
      if (msg.req === undefined) {
        // An async escape tagged to this overlay: a real body failure, but it
        // answers no render — the one in flight may still arrive.
        this.record(msg.id, positioned({ phase: "render", message: msg.message }, msg.line, msg.column));
        return;
      }
      if (!w || w.req !== msg.req) return; // answers nothing this export waits on
      this.fail(w, positioned({ phase: "render", message: msg.message }, msg.line, msg.column), true);
      return;
    }
    // compile / build: the body will not render.
    const failure = positioned({ phase: msg.phase, message: msg.message }, msg.line, msg.column);
    if (w) this.fail(w, failure, false);
    else this.record(msg.id, failure);
  }

  onTimeout(id: string, phase: "load" | "render", afterMs?: number, reason?: string): void {
    this.beginRestart();
    // `afterMs` is the budget that ran out — a first render gets the load one.
    // `reason` replaces "timed out" for a drop that was not one (a flood).
    const ms = afterMs ?? (phase === "render" ? RENDER_TIMEOUT_MS : LOAD_TIMEOUT_MS);
    const message = reason ?? `timed out after ${Math.round(ms / 1000)} s`;
    const failure: LayerFailure = phase === "render" ? { phase: "render", message } : { phase: "build", message };
    const w = this.waiting.get(id);
    if (w) this.fail(w, failure, phase === "render");
    // A load timeout right after a boot failure's `build` error for the same
    // attempt (OverlaySandbox.handleSupervisorError sends both) is a symptom:
    // keep the reason. Same rule as the preview (use-overlay-layers.ts).
    else if (phase === "render" || !this.failures.has(id)) this.record(id, failure);
    // The host dropped EVERY render in flight with the worker; the others are
    // tried again once it is back.
    this.abandonAll();
  }

  /** A fresh worker is up (after a watchdog timeout, or a boot failure's
   *  retry): re-load every body, then let the abandoned renders go again. */
  onRestart(): void {
    this.beginRestart();
    this.abandonAll();
    const r = this.restarting;
    const reload = this.opts.reloadAll ? this.opts.reloadAll() : Promise.resolve();
    void reload
      .catch(() => {})
      .then(() => {
        if (this.restarting === r) this.endRestart();
      });
  }

  /**
   * The supervisor frame died, and the export's host replaces none
   * (`EXPORT_SANDBOX_OPTIONS`, R2-M1; I3): nothing will render any more. The export FAILS rather than finishing
   * with every body overlay silently missing from the frames still to come —
   * every waiter is released, and the next `settle` throws, which fails the
   * render page's job with this message.
   */
  onFrameLost(message: string): void {
    if (this.lost !== null) return;
    this.lost = message;
    for (const w of Array.from(this.waiting.values())) {
      this.waiting.delete(w.request.overlayId);
      w.resolve("failed");
    }
    this.endRestart();
  }

  onUnattributed(msg: UnattributedMessage): void {
    const same = (u: UnattributedFailure) => u.message === msg.message && u.line === msg.line && u.column === msg.column;
    const i = this.unattributed.findIndex(same);
    if (i >= 0) this.unattributed.splice(i, 1);
    this.unattributed.push({ message: msg.message, ...(msg.line ? { line: msg.line } : {}), ...(msg.column ? { column: msg.column } : {}) });
    if (this.unattributed.length > MAX_UNATTRIBUTED_PER_PIECE) this.unattributed.shift();
  }

  // ── the export loop ───────────────────────────────────────────────────────

  /**
   * Settle every request, ONE AT A TIME: each is posted only once the one
   * before it has answered (a layer, an error, a timeout). The worker renders
   * one body at a time anyway. This was the Task 10 fix for the watchdog
   * charging each overlay for the time it sat queued behind its siblings
   * (Important 1); since Task 12b the host itself times only the oldest
   * unanswered request on the port, so posting together would now be safe
   * too. Sequential posting stays: it costs one port round-trip per overlay
   * (~0.6 ms, A1) and keeps a restart's blast radius to one render.
   */
  async settle(requests: LayerRequest[], at: SettleAt): Promise<void> {
    if (this.lost !== null) throw new Error(this.lost);
    this.frameFailures.clear();
    // An overlay this frame does not ask for has ended (or not begun): its
    // bitmap can never be drawn again, so it is not held until dispose.
    const wanted = new Set(requests.map((r) => r.overlayId));
    for (const id of Array.from(this.held.keys())) if (!wanted.has(id)) this.dropBitmap(id);
    for (const request of requests) {
      if (this.disposed) return;
      await this.settleOne(request, at);
      if (this.lost !== null) throw new Error(this.lost);
    }
  }

  /** The failure that answered THIS frame's request for the overlay, if any. */
  failureFor(overlayId: string): LayerFailure | undefined {
    return this.frameFailures.get(overlayId);
  }

  get(overlayId: string, frame: number): LayerBitmap | null {
    const h = this.held.get(overlayId);
    return h && h.layer.frame === frame ? h.layer : null;
  }

  /** `drawBodyLayer` asks on every draw; everything it can ask for was
   *  settled before the frame, so a repeat is a no-op. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  request(_req: LayerRequest): void {}

  dispose(): void {
    this.disposed = true;
    for (const { layer } of this.held.values()) layer.bitmap.close();
    this.held.clear();
    for (const w of Array.from(this.waiting.values())) w.resolve("failed");
    this.waiting.clear();
    this.endRestart();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async settleOne(request: LayerRequest, at: SettleAt): Promise<void> {
    const id = request.overlayId;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.restarting) await this.restarting.promise;
      if (this.disposed) return;
      const held = this.held.get(id);
      if (held && sameLayerRequest(held.request, request)) return; // already answered
      const outcome = await this.postAndWait(request, at);
      if (outcome === "layer") {
        this.markClean(id, at.frame);
        return;
      }
      if (outcome === "failed") return;
    }
    this.frameFailures.set(id, { phase: "render", message: RESTARTED_MESSAGE });
    this.record(id, { phase: "render", message: RESTARTED_MESSAGE, time: at.time, frame: at.frame });
    this.dropBitmap(id);
  }

  private postAndWait(request: LayerRequest, at: SettleAt): Promise<Outcome> {
    const id = request.overlayId;
    return new Promise<Outcome>((resolve) => {
      const req = this.post(toRenderInput(request));
      if (req < 0) {
        // Not loaded, or dropped after a timeout: nothing will ever arrive.
        this.dropBitmap(id);
        // Recorded as well, so the agent hears of it (get_piece_state), not
        // only droppedOverlays — unless a real load failure already explains it.
        if (!this.failures.has(id)) this.failures.set(id, { phase: "build", message: NOT_LOADED_MESSAGE });
        this.frameFailures.set(id, this.failures.get(id)!);
        resolve("failed");
        return;
      }
      this.waiting.set(id, { request, req, at, resolve });
    });
  }

  /** The waiter's frame failed: nothing is drawn for it — least of all the
   *  previous frame's pixels. */
  private fail(w: Waiter, failure: LayerFailure, timed: boolean): void {
    const withTime = timed ? { ...failure, time: w.at.time, frame: w.at.frame } : failure;
    this.waiting.delete(w.request.overlayId);
    this.dropBitmap(w.request.overlayId);
    this.frameFailures.set(w.request.overlayId, withTime);
    this.record(w.request.overlayId, withTime);
    w.resolve("failed");
  }

  private record(id: string, failure: LayerFailure): void {
    const prev = this.failures.get(id);
    if (!prev || prev.phase !== "render") this.failures.set(id, failure);
  }

  private abandonAll(): void {
    for (const w of Array.from(this.waiting.values())) {
      this.waiting.delete(w.request.overlayId);
      w.resolve("abandoned");
    }
  }

  private beginRestart(): void {
    if (this.restarting || this.disposed) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = this.setTimer(() => this.endRestart(), this.restartWaitMs);
    this.restarting = { promise, resolve, timer };
  }

  private endRestart(): void {
    const r = this.restarting;
    if (!r) return;
    this.restarting = null;
    this.clearTimer(r.timer);
    r.resolve();
  }

  private dropBitmap(id: string): void {
    const h = this.held.get(id);
    if (!h) return;
    h.layer.bitmap.close();
    this.held.delete(id);
  }

  private markClean(id: string, frame: number): void {
    let ranges = this.cleanFrames.get(id);
    if (!ranges) {
      ranges = [];
      this.cleanFrames.set(id, ranges);
    }
    const last = ranges[ranges.length - 1];
    if (last && last[1] === frame) last[1] = frame + 1;
    else if (!last || last[1] < frame) {
      if (ranges.length < MAX_CLEAN_RANGES) ranges.push([frame, frame + 1]);
    }
  }
}

function capped(text: string): string {
  return text.length > MAX_DIAGNOSTIC_MESSAGE_CHARS ? text.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS) : text;
}

/** The render page's `renderDiagnostics` postback (spec §4.7): every failure
 *  and clean run named by the body's kind and the hash of the source it ran,
 *  which is how the server tells a diagnostic about the CURRENT body from one
 *  about a body the agent has since replaced. */
export function buildExportDiagnosticsReport(
  source: Pick<ExportLayerSource, "failures" | "cleanFrames" | "unattributed">,
  bodies: ReadonlyMap<string, { kind: BodyKind; sourceHash: string }>,
  opts: { fps: number; now: number },
): ExportDiagnosticsReport {
  const diagnostics: ExportRenderDiagnostic[] = [];
  for (const [overlayId, f] of source.failures) {
    const body = bodies.get(overlayId);
    if (!body) continue;
    diagnostics.push({
      overlayId,
      kind: body.kind,
      phase: f.phase,
      message: capped(f.message),
      ...(f.line ? { line: f.line } : {}),
      ...(f.column ? { column: f.column } : {}),
      // `time` rounded to ms reads back as its own frame only through
      // `frameForTime`'s 1 ms snap; `frame` names it exactly (re-review 2, N1).
      ...(f.time !== undefined ? { time: roundToMs(f.time) } : {}),
      ...(f.frame !== undefined ? { frame: f.frame } : {}),
      sourceHash: body.sourceHash,
      at: opts.now,
    });
  }
  const clean: ExportDiagnosticsReport["clean"] = [];
  for (const [overlayId, frames] of source.cleanFrames) {
    const body = bodies.get(overlayId);
    if (body && frames.length) clean.push({ overlayId, sourceHash: body.sourceHash, frames: frames.map(([s, e]) => [s, e]) });
  }
  return {
    fps: opts.fps,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS_PER_PIECE),
    unattributed: source.unattributed.map((u) => ({
      message: capped(u.message),
      ...(u.line ? { line: u.line } : {}),
      ...(u.column ? { column: u.column } : {}),
      at: opts.now,
    })),
    clean,
  };
}
