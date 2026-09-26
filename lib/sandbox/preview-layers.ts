/**
 * The preview's LayerSource (spec §4.5): synchronous `get` returns the newest
 * bitmap for an overlay whatever frame it is for (hold-last-good — a code
 * overlay shows the previous frame's pixels for one round-trip while
 * scrubbing, never nothing); `request` posts at most ONE render per overlay at
 * a time and remembers only the latest request made while one is in flight.
 * Arrival notifies subscribers (the player repaints imperatively) and sends the
 * pending request, if any.
 *
 * Two rules the Task 8 review made binding:
 *  - A render is skipped only when the WHOLE request equals the one in flight
 *    or the one the held bitmap answers — frame, size, pixel ratio, pad, 3D
 *    transform, words, timing. Comparing the frame alone left a paused resize,
 *    rect drag or inspector edit drawing the old bitmap for good.
 *  - A bitmap is placed by the geometry of the request its reply ANSWERS (the
 *    `req` it echoes), never by the latest request's: a held bitmap from before
 *    a resize or a tracked-box change would otherwise be zoomed or cropped.
 */
import { sameLayerRequest, type LayerBitmap, type LayerRequest, type LayerSource } from "@/lib/engine/layer-source";
import type { LayerMessage } from "./protocol";

/** Re-exported: it lives with `LayerRequest`, which both sources compare. */
export { sameLayerRequest };

interface Slot {
  last: LayerBitmap | null;
  /** The request `last` answers — what a repeat request is compared with. */
  lastRequest: LayerRequest | null;
  inFlight: { req: number; request: LayerRequest } | null;
  pending: LayerRequest | null;
  /** Every render posted and not yet answered, by req id — how an arrival
   *  finds its own geometry even after `release` forgot the in-flight one
   *  (an error for a newer source does not cancel a render already out). */
  sent: Map<number, LayerRequest>;
  /** `markStale` ran while renders up to this req were already out: they may
   *  have drawn the old body (or font), so their answers must not count as
   *  answering a repeat of their request. */
  staleThrough: number;
}

export class PreviewLayerSource implements LayerSource {
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<{ frame: number; resolve: () => void }>();
  private disposed = false;

  /** `post` sends the render and returns the sandbox's req id, or -1 when it
   *  did not send (not loaded, dropped, destroyed, one already in flight).
   *  Without one, nothing is sent until `connect` names a sandbox. */
  constructor(private post: (req: LayerRequest) => number = () => -1) {}

  /** Route renders to a (new) sandbox, or to nowhere with `null`. The owner of
   *  the source outlives any one sandbox (a React hook re-creating it). */
  connect(post: ((req: LayerRequest) => number) | null): void {
    this.post = post ?? (() => -1);
  }

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { last: null, lastRequest: null, inFlight: null, pending: null, sent: new Map(), staleThrough: -1 };
      this.slots.set(id, s);
    }
    return s;
  }

  /** Whatever frame the newest bitmap is for (hold-last-good); the frame asked
   *  for is `request`'s business. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get(overlayId: string, _frame: number): LayerBitmap | null {
    return this.slots.get(overlayId)?.last ?? null;
  }

  request(req: LayerRequest): void {
    if (this.disposed) return;
    const s = this.slot(req.overlayId);
    if (s.inFlight) {
      // Only the newest wish survives; asking again for what is already out
      // cancels an older wish rather than queueing a duplicate.
      s.pending = sameLayerRequest(s.inFlight.request, req) ? null : req;
      return;
    }
    if (s.lastRequest && sameLayerRequest(s.lastRequest, req)) return;
    this.send(s, req);
  }

  private send(s: Slot, req: LayerRequest): void {
    const id = this.post(req);
    s.pending = null;
    if (id >= 0) {
      s.inFlight = { req: id, request: req };
      s.sent.set(id, req);
    } else {
      s.inFlight = null;
    }
  }

  /** The request a posted-and-unanswered render `req` was made for — what a
   *  render error answering it failed on. Read it before `release(id, req)`,
   *  which forgets it. */
  requestFor(overlayId: string, req: number): LayerRequest | undefined {
    return this.slots.get(overlayId)?.sent.get(req);
  }

  accept(msg: LayerMessage): void {
    const s = this.disposed ? undefined : this.slots.get(msg.id);
    const answered = s?.sent.get(msg.req);
    if (!s || !answered) {
      // Nothing this source posted — no geometry to place it by.
      msg.bitmap.close();
      return;
    }
    // Replies arrive in req order (one render in flight per overlay), so every
    // older request is answered or abandoned by now.
    for (const req of Array.from(s.sent.keys())) if (req <= msg.req) s.sent.delete(req);
    if (s.last && s.last.bitmap !== msg.bitmap) s.last.bitmap.close();
    s.last = {
      frame: msg.frame,
      bitmap: msg.bitmap,
      size: answered.size,
      pixelRatio: answered.pixelRatio,
      ...(answered.pad ? { pad: answered.pad } : {}),
    };
    // A render posted before `markStale` answers with what the worker held
    // then: show it, but let the same request go out again.
    s.lastRequest = msg.req > s.staleThrough ? answered : null;
    if (s.inFlight?.req === msg.req) s.inFlight = null;
    if (!s.inFlight && s.pending) this.send(s, s.pending);
    this.notify();
    this.settleWaiters();
  }

  /** The sandbox answered this overlay's render with an error, or will never
   *  answer it: nothing is in flight any more and the queued wish is dropped
   *  (the next draw re-asks). The last-good bitmap stays on screen, and a
   *  layer still out keeps its geometry in `sent`.
   *
   *  With `req` (a render error names the render it answers) this is exact:
   *  the slot is freed only when that render is the one in flight. A late
   *  error for an older render must not free a newer one — its request would
   *  post over the render still out, the host would refuse it, and the wish
   *  would be lost. */
  release(overlayId: string, req?: number): void {
    const s = this.slots.get(overlayId);
    if (!s) return;
    if (req !== undefined) {
      s.sent.delete(req); // answered: no layer will come for it
      if (s.inFlight?.req !== req) return;
    }
    s.inFlight = null;
    s.pending = null;
    this.settleWaiters();
  }

  /** The overlay's BODY changed (a new source loaded), or what it draws with
   *  did (a font landed): the held bitmap stays on screen, but it no longer
   *  answers any request, so the next one — even for the same frame and
   *  geometry, as on a paused preview — is sent. That holds for a render
   *  already out, too: the worker may have drawn it before the change, so its
   *  answer is shown but does not stop the same request going out again. */
  markStale(overlayId: string): void {
    const s = this.slots.get(overlayId);
    if (!s) return;
    s.lastRequest = null;
    for (const req of s.sent.keys()) if (req > s.staleThrough) s.staleThrough = req;
  }

  /** A worker restart abandoned every render: nothing will answer any of them. */
  releaseAll(): void {
    for (const s of this.slots.values()) {
      s.inFlight = null;
      s.pending = null;
      s.sent.clear();
    }
    this.settleWaiters();
  }

  forget(overlayId: string): void {
    const s = this.slots.get(overlayId);
    if (!s) return;
    s.last?.bitmap.close();
    this.slots.delete(overlayId);
    this.settleWaiters();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Ask subscribers to repaint — e.g. a body just finished loading, so the
   *  frame on screen (drawn while it could not render) must ask again. */
  invalidate(): void {
    this.notify();
  }

  private notify(): void {
    for (const l of Array.from(this.listeners)) l();
  }

  /** Resolves when no overlay is in flight or pending for `frame` (or another
   *  frame — a newer request supersedes). Bounded by `timeoutMs` so a dropped
   *  overlay can never hang a screenshot. */
  waitForLayers(frame: number, timeoutMs = 3000): Promise<void> {
    if (this.quietFor(frame)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = { frame, resolve };
      this.waiters.add(waiter);
      setTimeout(() => {
        if (this.waiters.delete(waiter)) resolve();
      }, timeoutMs);
    });
  }

  private quietFor(frame: number): boolean {
    for (const s of this.slots.values()) {
      if (s.inFlight && s.inFlight.request.frame === frame) return false;
      if (s.pending && s.pending.frame === frame) return false;
    }
    return true;
  }

  private settleWaiters(): void {
    for (const w of Array.from(this.waiters)) {
      if (this.quietFor(w.frame)) {
        this.waiters.delete(w);
        w.resolve();
      }
    }
  }

  /** The sandbox behind this source went away: every held bitmap is closed and
   *  every slot forgotten, but subscribers stay and the source keeps working
   *  for the next sandbox (a StrictMode remount, a re-enable). */
  reset(): void {
    for (const s of this.slots.values()) s.last?.bitmap.close();
    this.slots.clear();
    for (const w of this.waiters) w.resolve();
    this.waiters.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
    this.listeners.clear();
  }
}

/**
 * Subscribe to `source` with at most ONE call per animation frame. Layer
 * arrivals come one per overlay, so during playback with N body overlays an
 * unbatched listener would composite the whole frame N extra times per tick;
 * every arrival inside one frame is answered by a single repaint instead.
 */
export function subscribeOncePerFrame(
  source: Pick<PreviewLayerSource, "subscribe">,
  listener: () => void,
  schedule: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancel: (handle: number) => void = (h) => cancelAnimationFrame(h),
): () => void {
  let handle: number | null = null;
  const off = source.subscribe(() => {
    if (handle !== null) return;
    handle = schedule(() => {
      handle = null;
      listener();
    });
  });
  return () => {
    off();
    if (handle !== null) cancel(handle);
    handle = null;
  };
}
