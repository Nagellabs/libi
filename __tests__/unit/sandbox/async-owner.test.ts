import { describe, it, expect, vi, afterEach } from "vitest";
import { createAsyncOwner, installOwnedTimers, type Owner, type TimerScope } from "@/lib/sandbox/runtime/async-owner";
import { attachRuntime } from "@/lib/sandbox/runtime/serve";
import { LayerEngine } from "@/lib/sandbox/runtime/layers";
import { makeRuntimeHelpers } from "@/lib/sandbox/runtime/helpers";
import type { RuntimeMessage } from "@/lib/sandbox/protocol";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import { __resetImageCachesForTests } from "@/lib/engine/drawing";

/**
 * Task 13 fix round 2: every callback a body schedules is tagged with its
 * owner, and announces it (`async`) before it runs. These tests drive the
 * worker side over an in-memory port with REAL timers — the order of tasks and
 * microtasks is the point, and a fake clock would decide it for them.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const timing = { frame: 0, time: 0, totalFrames: 1, duration: 1, progress: 0 };
const g = globalThis as unknown as Record<string, unknown>;
/** An owner as the runtime makes one: the overlay and the body it ran. */
const own = (id: string, sourceHash: string | null = null): Owner => ({ id, sourceHash });

/** What the worker posts, compacted to `t:id` (answers `layer:id`). */
function wirePort() {
  const wire: RuntimeMessage[] = [];
  let handler: ((d: unknown) => void) | null = null;
  return {
    port: {
      post: (msg: RuntimeMessage) => { wire.push(msg); },
      onMessage: (h: typeof handler) => { handler = h; },
    },
    wire,
    trace: () => wire.map((m) => `${m.t}${"id" in m ? `:${m.id}` : ""}`),
    emit: (d: unknown) => handler?.(d),
  };
}
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async (tasks = 3) => { for (let i = 0; i < tasks; i++) await nextTask(); };

/** A scope standing in for the worker global: the real timers, un-pinned
 *  copies, so the test's own `setTimeout` stays the platform's. */
function scope(extra: Partial<TimerScope> = {}): TimerScope & Record<string, unknown> {
  return {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    ...extra,
  } as TimerScope & Record<string, unknown>;
}

type Timers = {
  setTimeout: (fn: unknown, ms?: number, ...a: unknown[]) => unknown;
  setInterval: (fn: unknown, ms?: number) => unknown;
  clearTimeout: (h: unknown) => void;
  clearInterval: (h: unknown) => void;
};

/** The real runtime loop and engine, bodies compiled from source, with the
 *  scope's wrapped timers reachable from a body as `__t`. */
function runtime() {
  const w = wirePort();
  const s = scope();
  const owner = createAsyncOwner(w.port, "n1", (fn) => { setTimeout(fn, 0); });
  g.__t = s as unknown as Timers;
  const makeCanvas = (width: number, height: number) => {
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : (t[k as string] = vi.fn())),
      set: (t, k, v) => { t[k as string] = v; return true; },
    });
    return { width, height, getContext: () => ctx, transferToImageBitmap: () => ({ width: 1, height: 1, close() {} }) } as unknown as OffscreenCanvas;
  };
  const ownedTimers = installOwnedTimers(s, owner);
  const engine = new LayerEngine({ makeCanvas, now: () => 0, wrapperLineOffset: 2, installFont: vi.fn(async () => {}), measureContentBox: () => null, asyncOwner: owner, ownedTimers });
  attachRuntime(w.port, "n1", engine, { owner });
  let req = 0;
  const load = async (id: string, source: string, sourceHash = HASH_A) => {
    w.emit({ t: "load", id, kind: "code", source, sourceHash, width: 10, height: 10 });
    await settle(1);
  };
  const render = (id: string) => w.emit({ t: "render", id, frame: 0, req: ++req, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing });
  const dispose = async (id: string) => {
    w.emit({ t: "dispose", id });
    await settle(1);
  };
  return { ...w, owner, scope: s, load, render, dispose };
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetImageCachesForTests();
  delete g.__t;
  delete g.__log;
});

describe("async ownership — what the worker announces", () => {
  it("a body that schedules nothing costs nothing: a render is `started` and its answer, no window", async () => {
    const r = runtime();
    await r.load("a", "context.ctx.fillRect(0, 0, 1, 1);");
    r.render("a");
    await settle();
    expect(r.trace()).toEqual(["loaded:a", "started:a", "layer:a"]);
  });

  it("a delayed timer announces its owner before it runs, and closes from a later task — after every microtask it queued", async () => {
    const log: string[] = [];
    g.__log = log;
    const r = runtime();
    await r.load("a", "__t.setTimeout(() => { __log.push('cb:' + __wire()); Promise.resolve().then(() => __log.push('micro:' + __wire())); }, 5);");
    g.__wire = () => r.trace().at(-1);
    r.render("a");
    // The window closes from a later task: wait for it, not a fixed 30 ms.
    await vi.waitFor(() => expect(r.trace().at(-1)).toBe("asyncDone:a"));
    delete g.__wire;
    expect(log).toEqual(["cb:async:a", "micro:async:a"]);
    expect(r.trace()).toEqual(["loaded:a", "started:a", "layer:a", "async:a", "asyncDone:a"]);
  });

  it("a timer of the body's OWN render that fires inside its yield posts nothing: the render bracket already names it", async () => {
    const r = runtime();
    await r.load("a", "__t.setTimeout(() => {}, 0);");
    r.render("a");
    await settle();
    expect(r.trace()).toEqual(["loaded:a", "started:a", "layer:a"]);
  });

  it("a SIBLING's timer due inside a render's yield opens its own window, closed before that render's answer", async () => {
    // b's render queues a 0 ms timer; a's render arrives in the same task, so
    // a's yield is queued after b's timer: b's callback runs while a waits.
    const r = runtime();
    await r.load("b", "__t.setTimeout(() => {}, 0);", HASH_B);
    await r.load("a", "1;");
    r.render("b");
    r.render("a");
    await settle();
    // b's callback runs while BOTH renders await their answers, so it is not
    // "inside b's own render" as far as the host can tell (a started later):
    // it announces itself, and b's answer closes it.
    expect(r.trace()).toEqual(["loaded:b", "loaded:a", "started:b", "started:a", "async:b", "asyncDone:b", "layer:b", "layer:a"]);
  });

  it("the owner is fixed when the callback is SCHEDULED: a timer set from inside another callback keeps it, and consecutive callbacks share one window", async () => {
    const r = runtime();
    await r.load("a", "__t.setTimeout(() => { __t.setTimeout(() => {}, 0); __t.setTimeout(() => {}, 0); }, 2);");
    r.render("a");
    // Wait for the four async events, not a fixed 30 ms (a loaded CI runner
    // had not fired the 2 ms timer by then, 2026-10-02).
    await vi.waitFor(() => expect(r.trace().slice(3)).toHaveLength(4), { timeout: 5000, interval: 5 });
    const t = r.trace();
    expect(t.filter((x) => x.startsWith("async")).every((x) => x.endsWith(":a"))).toBe(true);
    // One window for the parent, then (after its close task) one for the two
    // children, which ran back to back.
    expect(t.slice(3)).toEqual(["async:a", "asyncDone:a", "async:a", "asyncDone:a"]);
  });

  it("setInterval: every tick runs in its owner's window", async () => {
    const r = runtime();
    await r.load("a", "let n = 0; const h = __t.setInterval(() => { if (++n === 3) clearInterval(h); }, 5);");
    r.render("a");
    // Until the third tick has run and its window closed, not a fixed 60 ms.
    await vi.waitFor(
      () => {
        const done = r.trace().slice(3);
        expect(done.filter((x) => x === "async:a")).toHaveLength(3);
        expect(done.at(-1)).toBe("asyncDone:a");
      },
      { timeout: 5000, interval: 5 },
    );
    const t = r.trace().slice(3);
    expect(t.filter((x) => x === "async:a")).toHaveLength(3);
    expect(t.at(-1)).toBe("asyncDone:a");
    expect(t.every((x) => x === "async:a" || x === "asyncDone:a")).toBe(true);
  });

  it("requestAnimationFrame is wrapped when the worker has one, and a string handler is tagged too", async () => {
    const frames: Array<(ts: number) => void> = [];
    const s = scope({ requestAnimationFrame: (cb: (ts: number) => void) => { frames.push(cb); return frames.length; } });
    const w = wirePort();
    const owner = createAsyncOwner(w.port, "n1", (fn) => { setTimeout(fn, 0); });
    installOwnedTimers(s, owner);
    const seen: number[] = [];
    owner.renderStarted(own("a"));
    (s.requestAnimationFrame as (cb: (ts: number) => void) => number)((ts) => { seen.push(ts); });
    g.__log = [] as string[];
    (s.setTimeout as (h: string, ms: number) => void)("__log.push('string ran')", 0);
    owner.renderAnswered("a");
    await settle(); // the string handler fires: a's window, closed a task later
    frames[0]!(16.7); // the animation frame: a's window again
    await settle();
    expect(seen).toEqual([16.7]);
    expect(g.__log).toEqual(["string ran"]);
    expect(w.wire.map((m) => `${m.t}:${(m as { id: string }).id}`)).toEqual(["async:a", "asyncDone:a", "async:a", "asyncDone:a"]);
  });

  it("the wrappers are pinned on the scope AND on every prototype that owns a copy", () => {
    const proto = { setTimeout: globalThis.setTimeout };
    const s = Object.create(proto) as TimerScope & Record<string, unknown>;
    s.setTimeout = globalThis.setTimeout;
    s.setInterval = globalThis.setInterval;
    installOwnedTimers(s, createAsyncOwner(wirePort().port, "n1", () => {}));
    expect((s.setTimeout as { name: string }).name).toBe("ownedTimer");
    expect((proto.setTimeout as unknown as { name: string }).name).toBe("ownedTimer");
    expect(Object.getOwnPropertyDescriptor(s, "setTimeout")).toMatchObject({ writable: false, configurable: false });
    expect(() => { "use strict"; s.setTimeout = () => 0; }).toThrow(TypeError);
  });

  it("a timer scheduled while nothing is announced runs unowned: it closes the open window and opens none", async () => {
    const s = scope();
    const w = wirePort();
    // Windows here close only when something else runs (no close task).
    const owner = createAsyncOwner(w.port, "n1", () => {});
    installOwnedTimers(s, owner);
    (s.setTimeout as (fn: () => void, ms: number) => void)(() => {}, 5); // nobody's
    owner.enter(own("a")); // a's helper settled
    expect(w.wire.map((m) => m.t)).toEqual(["async"]);
    await vi.waitFor(() => expect(w.wire.map((m) => m.t)).toEqual(["async", "asyncDone"]));
    expect(owner.current()).toBeNull();
  });
});

describe("async ownership — the runtime's own helpers and builds", () => {
  it("loadImage settles inside its owner's window: the body's .then is announced as the body's, although it runs in a later task", async () => {
    let decode!: (b: unknown) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise((res) => { decode = res; })));
    const log: string[] = [];
    g.__log = log;
    const r = runtime();
    g.__wire = () => r.trace().at(-1);
    await r.load("a", "loadImage('data:image/png;base64,AAAA').then(() => __log.push('then:' + __wire()));");
    await r.load("b", "1;", HASH_B);
    r.render("a");
    await settle();
    r.render("b"); // b is mid-yield when a's decode lands
    decode({ width: 1, height: 1, close() {} });
    await settle();
    delete g.__wire;
    // The settlement waits a task of its own (settleAs), so a's `.then` runs
    // after b's answer, announced as a's.
    expect(log).toEqual(["then:async:a"]);
    expect(r.trace()).toEqual(["loaded:a", "loaded:b", "started:a", "layer:a", "started:b", "layer:b", "async:a", "asyncDone:a"]);
  });

  it("a rejected helper settles inside its owner's window too", async () => {
    const w = wirePort();
    const owner = createAsyncOwner(w.port, "n1", (fn) => { setTimeout(fn, 0); });
    const helpers = makeRuntimeHelpers(() => ({}), "a", owner);
    let at = "";
    await (helpers.loadImage as (s: string) => Promise<unknown>)("https://example.com/x.png").catch(() => { at = w.wire.map((m) => m.t).join(","); });
    expect(at).toBe("async");
  });

  it("fonts.ready and fonts.load settle inside the caller's window — one task per settlement, so two owners on one promise never share a window", async () => {
    const face = { family: "Inter" };
    class FakeFontSet {
      get ready() { return Promise.resolve(this); }
      load() { return Promise.resolve([face]); }
    }
    const fonts = new FakeFontSet();
    const s = scope({ fonts });
    const w = wirePort();
    const owner = createAsyncOwner(w.port, "n1", (fn) => { setTimeout(fn, 0); });
    installOwnedTimers(s, owner);
    const seen: string[] = [];
    owner.renderStarted(own("a"));
    const ready = fonts.ready.then(() => seen.push(`ready:${owner.current()?.id}`));
    owner.renderAnswered("a");
    owner.renderStarted(own("b"));
    const loaded = fonts.load().then(() => seen.push(`load:${owner.current()?.id}`));
    owner.renderAnswered("b");
    await Promise.all([ready, loaded]);
    expect(seen).toEqual(["ready:a", "load:b"]);
    // The prototype's copies are the wrappers too.
    expect(Object.getOwnPropertyDescriptor(FakeFontSet.prototype, "ready")?.get?.name).toBe("ownedFontsReady");
  });

  it("a three body's build enters its owner the moment before the factory runs", async () => {
    const w = wirePort();
    const owner = createAsyncOwner(w.port, "n1", (fn) => { setTimeout(fn, 0); });
    const inst = { ready: Promise.resolve(), dispose: vi.fn(), applyTransform: vi.fn(), render: vi.fn() } as unknown as ThreeOverlayInstance;
    let atFactory: string | null = "unset";
    const e = new LayerEngine({
      makeCanvas: () => ({}) as OffscreenCanvas,
      now: () => 0,
      wrapperLineOffset: 2,
      asyncOwner: owner,
      three: {
        acquire: vi.fn(async () => ({ renderer: {}, dispose: vi.fn() }) as never),
        release: vi.fn(),
        build: vi.fn(async (_b, _p, _s, _z, _o, beforeBody?: () => void) => { beforeBody?.(); atFactory = owner.current()?.id ?? null; return inst; }),
      },
    });
    await e.load({ t: "load", id: "t1", kind: "three", source: "return () => {};", sourceHash: HASH_A, width: 10, height: 10 });
    expect(atFactory).toBe("t1");
    expect(w.wire).toEqual([{ t: "async", nonce: "n1", id: "t1", sourceHash: HASH_A }]);
  });
});

describe("fix round 3 — the bookkeeping a body cannot bend (N2)", () => {
  const RealPromise = Promise;
  const realPush = Array.prototype.push;
  afterEach(() => {
    g.Promise = RealPromise;
    Array.prototype.push = realPush;
  });

  it("a body that patched Array.prototype.push cannot make its own timer announce a sibling", async () => {
    const r = runtime();
    await r.load("s", "1;", HASH_B);
    await r.load("h", "__t.setTimeout(() => {}, 5);");
    // What a hostile body can do in its render: every `h` pushed anywhere in
    // the realm becomes `s`, owners included.
    // (Strings only: rewriting every object with an `id` would rewrite the
    // host's own message as zod parses it — the shared-realm limit, A3.)
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      return realPush.apply(this, items.map((x) => (x === "h" ? "s" : x)));
    };
    try {
      r.render("h");
      await vi.waitFor(() => expect(r.wire.some((m) => m.t === "asyncDone")).toBe(true));
    } finally {
      Array.prototype.push = realPush;
    }
    const windows = r.wire.filter((m) => m.t === "async");
    expect(windows).toEqual([{ t: "async", nonce: "n1", id: "h", sourceHash: HASH_A }]);
  });

  it("a body that replaced self.Promise cannot hold a sibling's helper settlement", async () => {
    const w = wirePort();
    const owner = createAsyncOwner(w.port, "n1", (fn) => { setTimeout(fn, 0); });
    const out: string[] = [];
    // The hostile body's replacement is live exactly while the settlement
    // lands: microtasks run in order, so it is installed by the job queued
    // before the settled promise's reaction and removed by the one after —
    // nothing but that reaction runs under it (the test runner's own code
    // would, across an await).
    queueMicrotask(() => { g.Promise = function HostilePromise() { throw new Error("held by another body"); }; });
    const settled = owner.settleAs(own("s", HASH_B), RealPromise.resolve("bitmap"));
    queueMicrotask(() => { g.Promise = RealPromise; });
    RealPromise.prototype.then.call(settled, (v: unknown) => out.push(`then:${String(v)}`), (e: unknown) => out.push(`caught:${String(e)}`));
    await settle();
    expect(out).toEqual(["then:bitmap"]);
    expect(w.wire).toEqual([{ t: "async", nonce: "n1", id: "s", sourceHash: HASH_B }, { t: "asyncDone", nonce: "n1", id: "s" }]);
  });
});

describe("fix round 3 — a body that is disposed or replaced loses the work it left pending", () => {
  it("a disposed body's setInterval stops firing; a sibling's keeps going", async () => {
    const log: string[] = [];
    g.__log = log;
    const r = runtime();
    await r.load("a", "__t.setInterval(() => __log.push('a'), 5);");
    await r.load("b", "__t.setInterval(() => __log.push('b'), 5);", HASH_B);
    r.render("a");
    r.render("b");
    const ticksOf = (who: string) => log.filter((x) => x === who).length;
    await vi.waitFor(() => expect(ticksOf("a")).toBeGreaterThan(1));
    await r.dispose("a");
    const aTicks = ticksOf("a");
    const bTicks = ticksOf("b");
    // b's interval ticks every 5 ms, as a's did: once b has ticked twice more, a has had its chance.
    await vi.waitFor(() => expect(ticksOf("b")).toBeGreaterThan(bTicks + 1));
    expect(ticksOf("a")).toBe(aTicks);
    await r.dispose("b");
  });

  it("a superseded body's pending timeout never runs once the new source is installed", async () => {
    const log: string[] = [];
    g.__log = log;
    const r = runtime();
    await r.load("a", "__t.setTimeout(() => __log.push('old'), 20);");
    r.render("a");
    await settle();
    await r.load("a", "__t.setTimeout(() => __log.push('new'), 5);", HASH_B);
    r.render("a");
    await new Promise((res) => setTimeout(res, 50));
    expect(log).toEqual(["new"]);
  });

  it("a cleared handle is forgotten, and an animation frame is cancelled too", () => {
    const frames = new Map<number, () => void>();
    let next = 0;
    const s = scope({
      requestAnimationFrame: (cb: () => void) => { frames.set(++next, cb); return next; },
      cancelAnimationFrame: (h: number) => { frames.delete(h); },
    });
    const owner = createAsyncOwner(wirePort().port, "n1", () => {});
    const timers = installOwnedTimers(s, owner);
    owner.renderStarted(own("a", HASH_A));
    (s.requestAnimationFrame as (cb: () => void) => number)(() => {});
    const h = (s.setTimeout as (fn: () => void, ms: number) => unknown)(() => {}, 1000);
    (s.clearTimeout as (h: unknown) => void)(h); // the body clears its own
    owner.renderAnswered("a");
    owner.renderStarted(own("b", HASH_B));
    (s.requestAnimationFrame as (cb: () => void) => number)(() => {});
    owner.renderAnswered("b");
    expect(frames.size).toBe(2);
    timers.cancelOwnedBy("a");
    expect([...frames.keys()]).toEqual([2]); // b's frame stays
    expect((s.clearTimeout as { name: string }).name).toBe("ownedClear");
    timers.cancelOwnedBy("b");
    expect(frames.size).toBe(0);
  });
});

describe("fix round 4 — a render's owner is read through bookkeeping a body cannot bend (NEW-1a)", () => {
  const realGet = Map.prototype.get;
  afterEach(() => {
    Map.prototype.get = realGet;
    delete g.__patched;
  });

  it("a body that patched Map.prototype.get cannot make its own windows carry a hash of its choosing", async () => {
    const FAKE = "f".repeat(64);
    const r = runtime();
    // Its first render rewrites every Map lookup in the realm that yields an
    // object carrying its own hash — the engine's entry among them — so that
    // its later renders, and the timers they set, would be charged to FAKE:
    // a hash the host could take for a version it has superseded.
    await r.load(
      "h",
      `if (!__patched) {
         __patched = true;
         const get = Map.prototype.get;
         Map.prototype.get = function (k) {
           const v = get.call(this, k);
           return v && typeof v === "object" && v.sourceHash === "${HASH_A}" ? { ...v, sourceHash: "${FAKE}" } : v;
         };
       }
       __t.setTimeout(() => {}, 5);`,
    );
    g.__patched = false;
    const closed = () => r.wire.filter((m) => m.t === "asyncDone").length;
    r.render("h");
    await vi.waitFor(() => expect(closed()).toBe(1));
    r.render("h");
    await vi.waitFor(() => expect(closed()).toBe(2));
    Map.prototype.get = realGet;
    const windows = r.wire.filter((m) => m.t === "async");
    expect(windows.length).toBe(2);
    for (const m of windows) expect(m).toEqual({ t: "async", nonce: "n1", id: "h", sourceHash: HASH_A });
  });
});

describe("fix round 4 — timer and frame handles are bookkept per kind (NEW-2)", () => {
  /** A scope whose timers AND animation frames number their handles from 1,
   *  as Chromium's independent counters routinely collide. */
  function collidingScope() {
    const timers = new Map<number, () => void>();
    const frames = new Map<number, () => void>();
    let nextTimer = 0;
    let nextFrame = 0;
    const s = scope({
      setTimeout: ((fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }) as unknown as TimerScope["setTimeout"],
      setInterval: ((fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }) as unknown as TimerScope["setInterval"],
      clearTimeout: (h: number) => { timers.delete(h); },
      clearInterval: (h: number) => { timers.delete(h); },
      requestAnimationFrame: (cb: () => void) => { frames.set(++nextFrame, cb); return nextFrame; },
      cancelAnimationFrame: (h: number) => { frames.delete(h); },
    });
    return { s, timers, frames };
  }

  it("a timeout and an animation frame with the SAME handle are both cancelled when their body is disposed", () => {
    const { s, timers, frames } = collidingScope();
    const owner = createAsyncOwner(wirePort().port, "n1", () => {});
    const ownedTimers = installOwnedTimers(s, owner);
    owner.renderStarted(own("a", HASH_A));
    expect((s.requestAnimationFrame as (cb: () => void) => number)(() => {})).toBe(1);
    expect((s.setTimeout as (fn: () => void, ms: number) => number)(() => {}, 1000)).toBe(1);
    owner.renderAnswered("a");
    ownedTimers.cancelOwnedBy("a");
    expect(timers.size).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("a frame that FIRES does not forget the timeout sharing its handle, and cancelAnimationFrame does not either", () => {
    const { s, timers, frames } = collidingScope();
    const owner = createAsyncOwner(wirePort().port, "n1", () => {});
    const ownedTimers = installOwnedTimers(s, owner);
    owner.renderStarted(own("a", HASH_A));
    (s.requestAnimationFrame as (cb: () => void) => number)(() => {}); // frame 1
    (s.setTimeout as (fn: () => void, ms: number) => number)(() => {}, 1000); // timer 1
    (s.requestAnimationFrame as (cb: () => void) => number)(() => {}); // frame 2
    (s.setInterval as (fn: () => void, ms: number) => number)(() => {}, 1000); // timer 2
    owner.renderAnswered("a");
    frames.get(1)!(); // the frame runs…
    frames.delete(1);
    (s.cancelAnimationFrame as (h: number) => void)(2); // …and the other is cancelled by the body
    ownedTimers.cancelOwnedBy("a");
    expect(timers.size).toBe(0); // both timers still went
  });

  it("clearTimeout forgets an interval too (the platform shares their handles), and never an animation frame", () => {
    const { s, timers, frames } = collidingScope();
    const owner = createAsyncOwner(wirePort().port, "n1", () => {});
    const ownedTimers = installOwnedTimers(s, owner);
    owner.renderStarted(own("a", HASH_A));
    const iv = (s.setInterval as (fn: () => void, ms: number) => number)(() => {}, 1000); // timer 1
    (s.requestAnimationFrame as (cb: () => void) => number)(() => {}); // frame 1
    owner.renderAnswered("a");
    (s.clearTimeout as (h: number) => void)(iv);
    expect(timers.size).toBe(0);
    ownedTimers.cancelOwnedBy("a");
    expect(frames.size).toBe(0); // the frame sharing the handle was not forgotten
  });
});

describe("fix round 4 — a reload of the SAME body keeps the timers it has running (NEW-3)", () => {
  afterEach(() => {
    delete g.__started;
  });

  it("a same-hash recompile (a new kind) does not cancel the interval the body started once", async () => {
    const log: string[] = [];
    g.__log = log;
    const r = runtime();
    const source = "if (!__started) { __started = true; __t.setInterval(() => __log.push('tick'), 5); }";
    g.__started = false;
    await r.load("a", source);
    r.render("a");
    await vi.waitFor(() => expect(log.length).toBeGreaterThan(1));
    // The same body, recompiled: a kind change keeps the hash.
    r.emit({ t: "load", id: "a", kind: "tracked", source, sourceHash: HASH_A, width: 10, height: 10 });
    await settle(1);
    const ticks = log.length;
    await vi.waitFor(() => expect(log.length).toBeGreaterThan(ticks));
    await r.dispose("a"); // …and disposing it still stops it
    const after = log.length;
    // Nothing more may tick: a window of several of its 5 ms periods (a negative, so it IS a wait).
    await new Promise((res) => setTimeout(res, 30));
    expect(log.length).toBe(after);
  });
});

describe("Task 13 re-review 3, M5: the engine installs an entry through a captured Map#set", () => {
  const realSet = Map.prototype.set;
  afterEach(() => {
    Map.prototype.set = realSet;
    delete g.__patched;
  });

  it("a body that patched Map.prototype.set cannot make its NEXT version carry a hash of its choosing", async () => {
    const FAKE = "f".repeat(64);
    const r = runtime();
    // Version A patches the realm's Map#set: an engine entry for version B is
    // stored claiming FAKE — say, the version the host just superseded.
    await r.load(
      "h",
      `if (!__patched) {
         __patched = true;
         const set = Map.prototype.set;
         Map.prototype.set = function (k, v) {
           return set.call(this, k, v && typeof v === "object" && "draw" in v && v.sourceHash === "${HASH_B}" ? { ...v, sourceHash: "${FAKE}" } : v);
         };
       }`,
    );
    g.__patched = false;
    r.render("h");
    await settle();
    await r.load("h", "__t.setTimeout(() => {}, 5);", HASH_B);
    r.render("h");
    await vi.waitFor(() => expect(r.wire.some((m) => m.t === "asyncDone")).toBe(true));
    Map.prototype.set = realSet;
    const windows = r.wire.filter((m) => m.t === "async");
    expect(windows.length).toBe(1);
    expect(windows[0]).toEqual({ t: "async", nonce: "n1", id: "h", sourceHash: HASH_B });
  });
});
