/**
 * The worker's message loop, bound to a port view: the worker entry binds it
 * to the MessagePort the supervisor handed over (A1 §3); the dev-only
 * in-origin mode spawns the same worker in the app's own origin. Same
 * protocol, same validation, same errors either way. The port is private to
 * the host, so there is no `source` to check; every reply carries the nonce.
 */
import {
  parseHostMessage,
  type ErrorMessage,
  type LoadMessage,
  type RuntimeMessage,
  type UnattributedMessage,
} from "@/lib/sandbox/protocol";
import { createAsyncOwner, type AsyncOwner } from "./async-owner";
import { BodyError, OversizedLayerError, mapBodyError } from "./compile";
import { sampleEffectCurve } from "./effect-curve";
import { errorOwner } from "./helpers";
import type { LayerEngine } from "./layers";

export interface RuntimePort {
  post(msg: RuntimeMessage, transfer: Transferable[]): void;
  onMessage(handler: (data: unknown) => void): void;
}

// ── the private port (Task 7 review I4) ─────────────────────────────────────
// Every body runs in this realm and may rewrite any prototype. A runtime that
// looked up `port.postMessage` per call would hand a body that had replaced
// `MessagePort.prototype.postMessage` the private port as `this` — and with it
// the power to post forged `layer` / `loaded` / `error` messages for any
// overlay. So everything the channel touches after boot is captured HERE, at
// module evaluation, which precedes the first body by construction: bodies
// arrive on the port this module binds.
//  - `MessagePort.prototype.postMessage`, called through `Reflect.apply`
//    (captured too: `Function.prototype.call` is just as patchable);
//  - `MessageEvent.prototype.data`'s getter: the handler reads every incoming
//    event, and a patched getter would receive the event — whose `target` is
//    the port.
// What this does NOT defend is the rest of the shared realm — a body can still
// change how zod parses or how Canvas2D draws for every overlay. That is the
// recorded limit of running bodies in one realm; the channel is what must hold.
const reflectApply = Reflect.apply;
const portPostMessage: MessagePort["postMessage"] | undefined =
  typeof MessagePort === "undefined" ? undefined : MessagePort.prototype.postMessage;
const messageEventData: (() => unknown) | undefined =
  typeof MessageEvent === "undefined" ? undefined : Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
/** `Event.prototype.preventDefault`, for `attachGlobalDiagnostics`: a body that
 *  replaced it with a no-op would otherwise un-cancel every uncaught error and
 *  flood the supervisor thread with them (Task 7 re-review N1). */
const eventPreventDefault: (() => void) | undefined =
  typeof Event === "undefined" ? undefined : Event.prototype.preventDefault;
/**
 * The worker's own `setTimeout`, captured before any body runs, so a body that
 * replaces `self.setTimeout` cannot decide when (or whether) a layer is posted.
 * Called as a plain function: a global's operations accept an undefined
 * `this`, so no `.call` a body could patch is involved.
 */
const scheduleTask: (fn: () => void, ms: number) => unknown = setTimeout;
/**
 * The clock and the Map operations `attachGlobalDiagnostics` rate-limits by,
 * captured with the rest (final security review, I1). Read live, a body that
 * made `Performance.prototype.now` jump 5 s per call — or made
 * `Map.prototype.get` forget — opened the limiter for every uncaught error it
 * could raise, and 200,000 unique reports went to the host main thread. The
 * host's own message budget (`host.ts`) is the bound that holds whatever the
 * realm does; this keeps the worker from being the one to hit it.
 */
const performanceNow: (() => number) | undefined =
  typeof performance === "undefined" ? undefined : performance.now;
const performanceObject: Performance | undefined = typeof performance === "undefined" ? undefined : performance;
const MapCtor = Map;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;

/** The worker's own `performance.now()`, through the primitives captured above. */
function capturedNow(): number {
  if (!performanceNow || !performanceObject) return Date.now();
  return reflectApply(performanceNow, performanceObject, []) as number;
}

/** One macrotask later — after every microtask the current task queued.
 *  Also what closes an `async` window (async-owner.ts). */
export function yieldOneTask(fn: () => void): void {
  scheduleTask(fn, 0);
}

/** Bind the runtime to its private port through the primitives captured above.
 *  Called once, at boot, before any body exists. */
export function bindPrivatePort(port: MessagePort): RuntimePort {
  const post = portPostMessage;
  const readData = messageEventData;
  if (!post || !readData) throw new Error("the overlay runtime needs MessagePort and MessageEvent");
  return {
    post: (msg, transfer) => {
      reflectApply(post, port, [msg, transfer]);
    },
    onMessage: (handler) => {
      port.onmessage = (ev: MessageEvent) => handler(reflectApply(readData, ev, []));
      port.start();
    },
  };
}

/** The wire's caps (`lib/sandbox/protocol.ts`). Applied HERE, before posting:
 *  a body controls both strings and has no length limit, and the host's parser
 *  nulls the WHOLE message when either overflows — losing the very diagnostic
 *  this exists to deliver. */
const MESSAGE_CAP = 2000;
const STACK_CAP = 8000;

/**
 * `sourceHash` is attached for `compile`/`build`, where the failure belongs to
 * a specific `load` the host may already have superseded (Task 5 ruling); a
 * `render` failure belongs to no load and carries none. `req` is attached when
 * the error ANSWERS a render, so the host clears that flight and no other.
 */
export function errorMessage(
  nonce: string,
  id: string,
  err: unknown,
  extra: { sourceHash?: string; req?: number } = {},
): ErrorMessage {
  const e = err instanceof BodyError ? err : new BodyError("render", err instanceof Error ? err.message : String(err));
  const msg: ErrorMessage = {
    t: "error",
    nonce,
    id,
    phase: e.phase,
    message: (e.message || "unknown error").slice(0, MESSAGE_CAP),
    ...(e.line ? { line: e.line } : {}),
    ...(e.column ? { column: e.column } : {}),
    ...(e.bodyStack ? { stack: e.bodyStack.slice(0, STACK_CAP) } : {}),
  };
  if (extra.sourceHash && (e.phase === "compile" || e.phase === "build")) msg.sourceHash = extra.sourceHash;
  if (extra.req !== undefined) msg.req = extra.req;
  if (e instanceof OversizedLayerError) msg.layerSize = { width: e.layerSize.width, height: e.layerSize.height };
  return msg;
}

export function unattributedMessage(nonce: string, e: BodyError): UnattributedMessage {
  return {
    t: "unattributed",
    nonce,
    message: (e.message || "unknown error").slice(0, MESSAGE_CAP),
    ...(e.line ? { line: e.line } : {}),
    ...(e.column ? { column: e.column } : {}),
    ...(e.bodyStack ? { stack: e.bodyStack.slice(0, STACK_CAP) } : {}),
  };
}

/**
 * Loads and disposes of one overlay run strictly in arrival order (Task 7
 * review I2): a load that awaits a font or a three renderer would otherwise be
 * overtaken by a newer load of the same id, then install over it — the host
 * holding the newer `loaded` while the worker rendered the older body — and two
 * three builds would share, and leak, the id's renderer. Each step posts its
 * own ack before the next begins, so the host's last word about an id is the
 * body that is live. Different ids still load concurrently; renders are never
 * queued (they are synchronous and read whatever entry is installed).
 *
 * Chained with `await` rather than `.then()`, which only avoids handing a
 * patched `Promise.prototype.then` the step closures directly. It is NOT a
 * guarantee against a hostile body: `await` runs PromiseResolve, which reads
 * `promise.constructor`, so a body that installs a `Promise.prototype.constructor`
 * getter gets a patched `then` called with the internal resume functions, and
 * can resume a queued step early (Task 7 re-review N2). What holds is the port:
 * nothing reachable this way leads to it (see `bindPrivatePort`). Load order
 * under a hostile body in the shared realm is not guaranteed — spec amendment A3.
 *
 * A render is bracketed for the host's watchdog (Task 13 fix round 1, I2):
 *  - `started` goes out the moment BEFORE the body is called, so a render the
 *    host never hears start from was blocked by something that ran before it,
 *    not by its own body (`OverlaySandbox.expire`);
 *  - the answer — `layer` or `error` — goes out one macrotask AFTER the body
 *    returned (`yieldTask`, the captured `setTimeout`). Every microtask the
 *    body queued runs first, and so does a `setTimeout(…, 0)` it set: work it
 *    left behind that never finishes wedges the worker while the host is still
 *    timing THIS render, which it saw start, and the body is blamed directly.
 *    Posted in the same task, the answer would land first and the wedge would
 *    fall on whichever sibling the host asked for next.
 *
 * The yield is still needed now that async work is tagged with its owner
 * (fix round 2, `async-owner.ts`): tagging covers timers, animation frames and
 * helper settlements, but nothing announces a MICROTASK the body queued in its
 * own render (`Promise.resolve().then`, `queueMicrotask`, an `await`). Those run
 * after the handler returns, before any other task, so the render's own bracket
 * is the only window that can hold them, and it must stay open until they are
 * done — one task. A timer the body set, even for 0 ms, is tagged and blamed
 * exactly whether or not the answer waits for it; and a sibling's callback that
 * falls due inside the yield announces itself with `async`, so it is the one
 * blamed, not this render (fix round 1, concern 1).
 */
export function attachRuntime(
  port: RuntimePort,
  nonce: string,
  engine: LayerEngine,
  opts: { yieldTask?: (fn: () => void) => void; owner?: AsyncOwner } = {},
): void {
  const yieldTask = opts.yieldTask ?? yieldOneTask;
  const owner = opts.owner ?? createAsyncOwner(port, nonce, yieldTask);
  const tails = new Map<string, Promise<void>>();
  const serialize = (id: string, step: () => Promise<void>): void => {
    const prev = tails.get(id);
    const run = prev
      ? (async () => {
          await prev;
          await step();
        })()
      : step();
    tails.set(id, run);
    void (async () => {
      await run;
      if (tails.get(id) === run) tails.delete(id);
    })();
  };

  const load = async (msg: LoadMessage): Promise<void> => {
    try {
      const { fontFailures } = await engine.load(msg);
      port.post({ t: "loaded", nonce, id: msg.id, sourceHash: msg.sourceHash }, []);
      for (const f of fontFailures) {
        port.post(
          unattributedMessage(
            nonce,
            new BodyError(
              "build",
              `font "${f.family}" ${f.weight} could not be installed (${f.message}); text drawn in it falls back to another font`,
            ),
          ),
          [],
        );
      }
    } catch (err) {
      // Anything out of `load` belongs to THIS load — a corrupt input, a
      // WebGL context that will not come up — not only a body's own error.
      // As `build` it carries the load's hash and settles the host's pending
      // load; as the old `render` default it settled nothing, and the 5 s
      // watchdog restarted the worker over a body that compiled fine (I1).
      const e = err instanceof BodyError ? err : new BodyError("build", err instanceof Error ? err.message : String(err));
      port.post(errorMessage(nonce, msg.id, e, { sourceHash: msg.sourceHash }), []);
    }
  };

  port.onMessage((data) => {
    const msg = parseHostMessage(data);
    if (!msg) return;
    if (msg.t === "dispose") {
      serialize(msg.id, async () => {
        // A three body's objects are disposed here, and a body can make that
        // throw. Every step must settle, or the id's queue would stall.
        try {
          engine.dispose(msg.id);
        } catch (err) {
          port.post(unattributedMessage(nonce, new BodyError("render", `disposing ${msg.id}: ${err instanceof Error ? err.message : String(err)}`)), []);
        }
      });
      return;
    }
    if (msg.t === "load") {
      serialize(msg.id, () => load(msg));
      return;
    }
    if (msg.t === "sample") {
      // A custom effect's curve (lib/sandbox/effect-sampler.ts). Bracketed like
      // a render: whatever the body leaves running is owned by this request's
      // id, and the answer goes out one task after it returned.
      owner.renderStarted({ id: msg.id, sourceHash: msg.sourceHash });
      let answer: RuntimeMessage;
      let transfer: Transferable[] = [];
      try {
        const curve = sampleEffectCurve(msg.source, msg.params, msg.samples);
        answer = { t: "curve", nonce, id: msg.id, samples: msg.samples, data: curve.buffer as ArrayBuffer };
        transfer = [curve.buffer as ArrayBuffer];
      } catch (err) {
        answer = errorMessage(nonce, msg.id, err);
      }
      yieldTask(() => {
        owner.renderAnswered(msg.id);
        port.post(answer, transfer);
      });
      return;
    }
    owner.renderStarted({ id: msg.id, sourceHash: engine.sourceHashOf(msg.id) });
    port.post({ t: "started", nonce, id: msg.id, req: msg.req }, []);
    let answer: RuntimeMessage;
    let transfer: Transferable[] = [];
    try {
      const bitmap = engine.render(msg);
      answer = { t: "layer", nonce, id: msg.id, frame: msg.frame, req: msg.req, bitmap };
      transfer = [bitmap];
    } catch (err) {
      answer = errorMessage(nonce, msg.id, err, { req: msg.req });
    }
    yieldTask(() => {
      owner.renderAnswered(msg.id);
      port.post(answer, transfer);
    });
  });
}

/**
 * A throw that ESCAPES the synchronous body call — inside a `.then()` the body
 * chained, a timer it set — is not caught by `compileDrawBody`'s try/catch. It
 * surfaces on the worker's global `error` / `unhandledrejection` events, after
 * the frame, when nothing says which body it came from. It is mapped onto the
 * body's own line (Task 6 review ruling) and then:
 *  - blamed on an overlay ONLY when the rejection carries an owner tag — a
 *    runtime helper (`loadImage`, `drawSvg`, `svgToImage`) rejected with it,
 *    and each overlay's helpers are its own (helpers.ts#errorOwner). Such an
 *    error answers no render, so it carries no `req` and clears no flight;
 *  - otherwise posted `unattributed`, which the host reports and which drops
 *    nothing. "The overlay last worked on" is a guess: a `drawSvg` rejection
 *    from overlay A lands after the host's per-frame batch moved on to B, and
 *    blaming B froze a healthy sibling (Task 7 review I3).
 * `securitypolicyviolation` (a `WebSocket` the CSP refused — its constructor
 * does not throw, A1) names no body either, and goes out `unattributed`.
 *
 * Rate-limited per overlay (and one bucket for the unattributed): a body that
 * fails every frame, or a hostile `setTimeout(() => { throw … })` loop, would
 * otherwise post hundreds of diagnostics a second into the host main thread.
 *
 * Every `error` and `unhandledrejection` is CANCELLED, first, before the rate
 * limit decides whether to report it (Task 7 re-review N1). An uncaught error
 * the worker does not cancel is re-fired at the `Worker` object on the
 * supervisor thread (HTML "report an exception"), which `lockWorkerPostMessage`
 * exists to keep bodies off: one loop of 2000 `queueMicrotask(() => { throw })`
 * put 2000 events and 2 MB of message text there. Cancelling an unhandled
 * rejection only keeps it off the worker console — rejections never propagate.
 * These listeners are attached in `boot`, so a failure BEFORE boot is still
 * uncancelled and still reaches the supervisor's boot-failure relay.
 *
 * Only TRUSTED events count (Task 13 fix round 1). A body can
 * `dispatchEvent(new SecurityPolicyViolationEvent(…))` or a hand-made
 * `ErrorEvent` on the global; neither is anything the browser reported, and
 * without this it could forge "blocked by the sandbox policy" text or take the
 * shared unattributed slot at will. `isTrusted` is an unforgeable own property
 * of every event. A dispatched event is never re-fired at the supervisor, so
 * ignoring one needs no cancel.
 *
 * The unattributed slot is shared by every body, so what it drops is made
 * visible: the next unattributed report carries how many it swallowed since the
 * last one ("+N more suppressed"), and when the slot reopens with nothing new
 * to say, the newest swallowed report goes out then, carrying that count.
 */
export const ASYNC_REPORT_INTERVAL_MS = 1000;

export interface RuntimeScope {
  addEventListener(type: string, handler: (ev: never) => void): void;
}

export function attachGlobalDiagnostics(
  scope: RuntimeScope,
  port: RuntimePort,
  nonce: string,
  wrapperLineOffset: number,
  opts: { now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown } = {},
): void {
  const now = opts.now ?? capturedNow;
  const setTimer = opts.setTimer ?? scheduleTask;
  const preventDefault = eventPreventDefault;
  if (!preventDefault) throw new Error("the overlay runtime needs Event");
  const cancel = (ev: Event): void => {
    reflectApply(preventDefault, ev, []);
  };
  // Read and written through the captured Map operations only (I1).
  const lastReport = new MapCtor<string, number>();
  const lastReportOf = (key: string): number | undefined => reflectApply(mapGet, lastReport, [key]) as number | undefined;
  const UNATTRIBUTED = "\u0000unattributed";
  const allow = (key: string): boolean => {
    const t = now();
    const prev = lastReportOf(key);
    if (prev !== undefined && t - prev < ASYNC_REPORT_INTERVAL_MS) return false;
    reflectApply(mapSet, lastReport, [key, t]);
    return true;
  };

  // ── the shared unattributed slot, with what it swallowed ──
  let suppressed = 0;
  /** Built only if it is ever posted: a flood maps nothing it drops. */
  let newestSuppressed: (() => BodyError) | null = null;
  let flushPending = false;
  const withCount = (e: BodyError): UnattributedMessage => {
    const msg = unattributedMessage(nonce, e);
    if (suppressed > 0) {
      const note = ` (+${suppressed} more unattributed report${suppressed === 1 ? "" : "s"} suppressed by the rate limit)`;
      msg.message = (msg.message.slice(0, MESSAGE_CAP - note.length) + note).slice(0, MESSAGE_CAP);
    }
    suppressed = 0;
    newestSuppressed = null;
    return msg;
  };
  /** Wake when the slot reopens. Timers and `now()` are separate clocks, so
   *  the wake can come a hair early; `flushSuppressed` then asks again. */
  const scheduleFlush = (): void => {
    if (flushPending) return;
    flushPending = true;
    const since = now() - (lastReportOf(UNATTRIBUTED) ?? now());
    setTimer(flushSuppressed, Math.max(1, ASYNC_REPORT_INTERVAL_MS - since));
  };
  /** The slot reopened: say what it swallowed, if nothing newer said it. */
  const flushSuppressed = (): void => {
    flushPending = false;
    const make = newestSuppressed;
    if (!make) return;
    if (!allow(UNATTRIBUTED)) {
      scheduleFlush();
      return;
    }
    suppressed--; // it goes out itself; the count is of the others
    port.post(withCount(make()), []);
  };
  const reportUnattributed = (make: () => BodyError): void => {
    if (allow(UNATTRIBUTED)) {
      port.post(withCount(make()), []);
      return;
    }
    suppressed++;
    newestSuppressed = make;
    scheduleFlush();
  };

  const report = (err: unknown): void => {
    const owner = errorOwner(err);
    if (!owner) {
      reportUnattributed(() => mapBodyError(err, "render", wrapperLineOffset));
      return;
    }
    if (!allow(owner)) return;
    port.post(errorMessage(nonce, owner, mapBodyError(err, "render", wrapperLineOffset)), []);
  };
  scope.addEventListener("securitypolicyviolation", ((ev: SecurityPolicyViolationEvent) => {
    if (ev.isTrusted === false) return;
    const text = `blocked by the sandbox policy: ${ev.violatedDirective} (${ev.blockedURI || "no URI"})`;
    reportUnattributed(() => new BodyError("render", text));
  }) as (ev: never) => void);
  scope.addEventListener("error", ((ev: ErrorEvent) => {
    if (ev.isTrusted === false) return;
    cancel(ev);
    report(ev.error ?? ev.message ?? "uncaught error in an overlay body");
  }) as (ev: never) => void);
  scope.addEventListener("unhandledrejection", ((ev: PromiseRejectionEvent) => {
    if (ev.isTrusted === false) return;
    cancel(ev);
    report(ev.reason);
  }) as (ev: never) => void);
}
