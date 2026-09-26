/**
 * Who owns the code the worker thread is running (Task 13 fix round 2,
 * controller ruling: tag async work with its owner so that blame is exact).
 *
 * Every body shares one worker thread. When that thread wedges, the host's
 * watchdog can only blame what the worker last TOLD it was running: a render's
 * `started` says "the body of `id` has the thread now" (answered one task
 * later, so its own microtasks run inside that bracket — `attachRuntime`), and
 * this module adds the other half, work a body left behind:
 *  - the timer functions a body can reach — `setTimeout`, `setInterval` and
 *    (Chromium workers have it) `requestAnimationFrame` — are wrapped at boot,
 *    before any body runs, and pinned on every object of the global's chain
 *    that owns them. A callback is tagged with its owner when it is SCHEDULED
 *    (`current()`: the render or callback running at that moment), and when it
 *    runs, `enter(owner)` posts `{ t: "async", id, sourceHash }` first if the
 *    thread is not already announced as that owner's;
 *  - the settlement of the runtime's own async helpers (`loadImage`, `drawSvg`,
 *    `svgToImage` — helpers.ts) and of the worker's font readiness
 *    (`fonts.ready`, `fonts.load`) enters their owner before the body's
 *    `.then` runs;
 *  - a three body's build runs its factory inside a `load`, which has no
 *    `started`; the engine enters the id first (layers.ts).
 * A window closes with `{ t: "asyncDone", id }` from a LATER task (every
 * microtask the callback queued has run by then), or just before the next
 * `started` / `async` / render answer, whichever comes first. Consecutive
 * callbacks of one owner share one window, and a body that schedules nothing
 * costs nothing: no message is ever posted for it.
 *
 * The owner is the overlay AND the body it ran (`Owner.sourceHash`, fix
 * round 3, N3): a superseded version's leftover timer is charged to the old
 * source, which the host no longer holds, so it restarts the worker without
 * dropping the new one. A body that is disposed, or replaced by a different
 * source, loses every timer, interval and animation frame it still had
 * pending (`cancelOwnedBy`), so that case needs a timer that fires before the
 * worker installs the new body. A recompile of the SAME source keeps them
 * (fix round 4, NEW-3). The host, not this module, decides whether a hash is
 * one it superseded: a hash it never superseded is charged to the id's
 * current source, whatever the worker says (host.ts, NEW-1).
 *
 * What stays untagged, and why it is not claimed exact. The task sources a
 * body could schedule through without passing a wrapper here are stubbed at
 * boot instead (`MessageChannel`, `BroadcastChannel`, `scheduler`,
 * `AbortSignal.timeout`, `PerformanceObserver`, `ReportingObserver` —
 * harden.ts). What remains:
 *  - an event listener a body adds to a platform object — the worker global's
 *    `error` / `unhandledrejection` / `securitypolicyviolation`, a
 *    `WebSocket`'s or `WebSocketStream`'s failure, a `FileReader`'s
 *    `load` / `loadend` / `progress` / `error` events (or its `on…` handlers);
 *  - a callback the platform calls back into — WebCodecs' `output` / `error`
 *    callbacks (`VideoDecoder`, `VideoEncoder`, `AudioDecoder`,
 *    `AudioEncoder`) and its `dequeue` events;
 *  - the settlement of a browser promise the runtime does not hand out —
 *    `createImageBitmap`, `OffscreenCanvas#convertToBlob`, `Blob#text` /
 *    `arrayBuffer`, `crypto.subtle`, `navigator.locks.request`, `FontFace#load`,
 *    WebCodecs' `flush()` / `ImageDecoder#decode()` / `isConfigSupported()`,
 *    `WebAssembly.compile` / `instantiate`, `Atomics.waitAsync`
 *    (`navigator.gpu` is removed instead — harden.ts);
 *  - a module a body imports from a `blob:` URL (`script-src` carries `blob:`).
 * Code reached that way runs in whatever window is open when it runs (a render
 * awaiting its answer, or none), and a timer scheduled from there is tagged
 * with that window's owner, because that is exactly who the host would blame
 * for it. With no window open such work is the host's fallback case
 * (`OverlaySandbox.unstartedWedge`). And as everywhere in the shared realm
 * (spec amendment A3), a hostile body can patch what a sibling calls and run
 * inside the sibling's window; attribution is exact for bodies that do not
 * reach into each other.
 *
 * The bookkeeping itself uses nothing a body can patch (N2): every intrinsic
 * it calls is captured at module evaluation, before any body exists, and its
 * lists are chains of object literals — `Array.prototype.push` would consult
 * an index setter a body defined on `Array.prototype`, and a replaced
 * `self.Promise` could hold a sibling's helper settlement.
 */
import type { RuntimePort } from "./serve";

const reflectApply = Reflect.apply;
const FunctionCtor = Function;
const StringCtor = String;
const PromiseCtor = Promise;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;
const MapCtor = Map;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapForEach = Map.prototype.forEach;
const definePropertyOf = Object.defineProperty;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptorOf = Object.getOwnPropertyDescriptor;
const hasOwn = Object.prototype.hasOwnProperty;

/** Whose code is running: the overlay, and the body (source) of it that ran.
 *  `sourceHash` is null only for a render of an id with no body installed. */
export interface Owner {
  readonly id: string;
  readonly sourceHash: string | null;
}

export function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return a === b || (a !== null && b !== null && a.id === b.id && a.sourceHash === b.sourceHash);
}

export interface AsyncOwner {
  /** The owner the host would blame if the thread wedged right now: the open
   *  `async` window's, else the newest render still awaiting its answer. */
  current(): Owner | null;
  /** Code owned by `owner` is about to run (null: nobody the runtime knows).
   *  Closes the window of whoever ran before, and opens `owner`'s unless the
   *  thread is already announced as theirs. */
  enter(owner: Owner | null): void;
  /** A render is about to post `started`. The task it runs in is a new one,
   *  so any open window is over. */
  renderStarted(owner: Owner): void;
  /** A render's answer is about to be posted — from a later task, so any open
   *  window is over, and so is the render's bracket. */
  renderAnswered(id: string): void;
  /** Settle `promise` inside `owner`'s window, one task after it settled, so
   *  the `.then` a body chains on it runs where the host would blame that
   *  body. */
  settleAs<T>(owner: Owner | null, promise: Promise<T>): Promise<T>;
}

/** A render that said `started` and is not answered, newest first. */
interface RenderNode {
  owner: Owner;
  older: RenderNode | null;
}

export function createAsyncOwner(
  port: RuntimePort,
  nonce: string,
  /** How the window is closed from a later task: the runtime's captured
   *  `setTimeout(…, 0)` (serve.ts passes it; tests pass their clock's). */
  schedule: (fn: () => void) => void,
): AsyncOwner {
  /** The `async` window posted and not yet closed. */
  let open: Owner | null = null;
  let renders: RenderNode | null = null;
  let closePending = false;

  const current = (): Owner | null => open ?? (renders ? renders.owner : null);
  const close = (): void => {
    if (open === null) return;
    const id = open.id;
    open = null;
    port.post({ t: "asyncDone", nonce, id }, []);
  };
  const closeLater = (): void => {
    if (closePending) return;
    closePending = true;
    schedule(() => {
      closePending = false;
      close();
    });
  };
  const enter = (owner: Owner | null): void => {
    if (owner !== null && sameOwner(owner, open)) return;
    close();
    if (owner === null || sameOwner(current(), owner)) return;
    open = owner;
    port.post(
      owner.sourceHash === null
        ? { t: "async", nonce, id: owner.id }
        : { t: "async", nonce, id: owner.id, sourceHash: owner.sourceHash },
      [],
    );
    closeLater();
  };
  return {
    current,
    enter,
    renderStarted(owner) {
      close();
      renders = { owner, older: renders };
    },
    renderAnswered(id) {
      close();
      let newer: RenderNode | null = null;
      for (let n = renders; n; newer = n, n = n.older) {
        if (n.owner.id !== id) continue;
        if (newer) newer.older = n.older;
        else renders = n.older;
        return;
      }
    },
    // Each settlement gets a task of its own. Resolved in the microtask where
    // the promise settled, two owners waiting on ONE promise (`fonts.ready`
    // settles every waiter at once) would enter one after the other before
    // either `.then` ran, and the first owner's callback would run in the
    // second's window. Built from the captured `Promise` and its `then`, so a
    // body that replaced either cannot hold or reorder another's settlement.
    settleAs<T>(owner: Owner | null, promise: Promise<T>): Promise<T> {
      return new PromiseCtor<T>((resolve, reject) => {
        const land = (settle: (v: unknown) => void, v: unknown): void =>
          schedule(() => {
            enter(owner);
            settle(v);
          });
        reflectApply(promiseThen, reflectApply(promiseResolve, PromiseCtor, [promise]), [
          (v: unknown) => land(resolve as (v: unknown) => void, v),
          (e: unknown) => land(reject, e),
        ]);
      });
    },
  };
}

/** The global's own timer functions, and everything else this module wraps. */
export interface TimerScope {
  setTimeout: unknown;
  setInterval: unknown;
  clearTimeout?: unknown;
  clearInterval?: unknown;
  requestAnimationFrame?: unknown;
  cancelAnimationFrame?: unknown;
  fonts?: unknown;
}

/** What `installOwnedTimers` hands back to the runtime. */
export interface OwnedTimers {
  /** Cancel every timeout, interval and animation frame a body of `id`
   *  scheduled and that has not run (an interval: not been cleared). Called
   *  when the body is disposed or replaced (layers.ts): a removed body's
   *  `setInterval` otherwise kept ticking — costing the thread, and able to
   *  wedge it — until the worker next restarted. */
  cancelOwnedBy(id: string): void;
}

/** Replace `name` on `target` and on every object of its prototype chain that
 *  owns a copy — non-writable, non-configurable — so a prototype walk finds
 *  the wrapper too (the lesson of `fetch`, harden.ts). */
function pinEverywhere(target: object, name: string, desc: PropertyDescriptor): void {
  const owners: object[] = [target];
  for (let o = getPrototypeOf(target) as object | null; o; o = getPrototypeOf(o) as object | null) {
    if (reflectApply(hasOwn, o, [name])) owners.push(o);
  }
  for (const o of owners) definePropertyOf(o, name, { ...desc, configurable: false, enumerable: false });
}

type Callable = (...args: unknown[]) => unknown;
type Kind = "timeout" | "interval" | "frame";

/**
 * Wrap the timer functions and the font readiness a body can reach. Called at
 * boot, before any body exists; the originals are read from `scope` here, so
 * they are the worker's own. The handles are the real ones; `clearTimeout` /
 * `clearInterval` / `cancelAnimationFrame` are wrapped only to forget a
 * cleared handle, so a body that sets and clears a timer every frame does not
 * grow the pending list.
 *
 * Pending callbacks are kept per kind (fix round 4, NEW-2), handle → owner id.
 * Chromium numbers animation frames and timers from independent counters, so
 * one table let a frame's handle overwrite a timer's (or its firing forget
 * one), and that timer then outlived its disposed body. Timeouts and
 * intervals share one counter in the platform, and `clearTimeout` /
 * `clearInterval` each clear either, so both forget from both tables;
 * `cancelAnimationFrame` forgets only a frame.
 */
export function installOwnedTimers(scope: TimerScope, owner: AsyncOwner): OwnedTimers {
  // Every key is an own property from the start: a missing one would be read
  // through Object.prototype, where a body can define it.
  const pending: Record<Kind, Map<unknown, string>> = {
    timeout: new MapCtor<unknown, string>(),
    interval: new MapCtor<unknown, string>(),
    frame: new MapCtor<unknown, string>(),
  };
  const forget = (kind: Kind, handle: unknown): void => {
    reflectApply(mapDelete, pending[kind], [handle]);
  };
  const cancelers: Record<Kind, Callable | null> = { timeout: null, interval: null, frame: null };

  /** Schedule `handler` through `original`: a callback that enters the owner
   *  it had when it was SCHEDULED. A string handler is compiled when it fires,
   *  as the platform would: it must not become a way to run untagged. */
  const scheduleOwned = (kind: Kind, original: Callable, handler: unknown, ms: unknown, args: unknown[]): unknown => {
    const who = owner.current();
    const slot: { handle: unknown } = { handle: undefined };
    const callback = (...fired: unknown[]): unknown => {
      if (who !== null && kind !== "interval") forget(kind, slot.handle);
      owner.enter(who);
      const fn = typeof handler === "function" ? (handler as Callable) : (new FunctionCtor(StringCtor(handler)) as Callable);
      return reflectApply(fn, scope, args.length ? args : fired);
    };
    const handle = reflectApply(original, scope, kind === "frame" ? [callback] : [callback, ms]);
    if (who !== null) {
      slot.handle = handle;
      reflectApply(mapSet, pending[kind], [handle, who.id]);
    }
    return handle;
  };

  const wrap = (kind: Kind, name: "setTimeout" | "setInterval" | "requestAnimationFrame", clearName: "clearTimeout" | "clearInterval" | "cancelAnimationFrame"): void => {
    const original = scope[name] as Callable | undefined;
    if (typeof original !== "function") return;
    pinEverywhere(scope, name, {
      writable: false,
      value:
        kind === "frame"
          ? function ownedAnimationFrame(callback: unknown) {
              return scheduleOwned(kind, original, callback, undefined, []);
            }
          : function ownedTimer(handler: unknown, ms?: unknown, ...args: unknown[]) {
              return scheduleOwned(kind, original, handler, ms, args);
            },
    });
    const clear = scope[clearName] as Callable | undefined;
    if (typeof clear !== "function") return;
    cancelers[kind] = (handle: unknown) => reflectApply(clear, scope, [handle]);
    pinEverywhere(scope, clearName, {
      writable: false,
      value: function ownedClear(handle?: unknown) {
        if (kind === "frame") forget("frame", handle);
        else {
          forget("timeout", handle);
          forget("interval", handle);
        }
        return reflectApply(clear, scope, [handle]);
      },
    });
  };
  wrap("timeout", "setTimeout", "clearTimeout");
  wrap("interval", "setInterval", "clearInterval");
  wrap("frame", "requestAnimationFrame", "cancelAnimationFrame");

  // Font readiness: the promise a body waits on settles inside its window.
  const fonts = scope.fonts as object | undefined;
  if (fonts && typeof fonts === "object") {
    const load = (fonts as { load?: unknown }).load as Callable | undefined;
    if (typeof load === "function") {
      pinEverywhere(fonts, "load", {
        writable: false,
        value: function ownedFontsLoad(this: unknown, ...args: unknown[]) {
          return owner.settleAs(owner.current(), reflectApply(load, this, args) as Promise<unknown>);
        },
      });
    }
    let readyGet: Callable | undefined;
    for (let o: object | null = fonts; o && !readyGet; o = getPrototypeOf(o) as object | null) {
      readyGet = getOwnPropertyDescriptorOf(o, "ready")?.get as Callable | undefined;
    }
    if (readyGet) {
      const get = readyGet;
      pinEverywhere(fonts, "ready", {
        get: function ownedFontsReady(this: unknown) {
          return owner.settleAs(owner.current(), reflectApply(get, this, []) as Promise<unknown>);
        },
      });
    }
  }

  return {
    cancelOwnedBy(id) {
      const cancelKind = (kind: Kind): void => {
        const cancel = cancelers[kind];
        reflectApply(mapForEach, pending[kind], [
          (owned: string, handle: unknown) => {
            if (owned !== id) return;
            forget(kind, handle);
            if (cancel) cancel(handle);
          },
        ]);
      };
      cancelKind("timeout");
      cancelKind("interval");
      cancelKind("frame");
    },
  };
}
