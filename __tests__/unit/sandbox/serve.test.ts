import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ASYNC_REPORT_INTERVAL_MS,
  attachGlobalDiagnostics,
  attachRuntime,
  bindPrivatePort,
  errorMessage,
} from "@/lib/sandbox/runtime/serve";
import { BodyError } from "@/lib/sandbox/runtime/compile";
import type { RuntimeMessage } from "@/lib/sandbox/protocol";
import { LayerEngine } from "@/lib/sandbox/runtime/layers";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";
import { __resetImageCachesForTests } from "@/lib/engine/drawing";

const HASH = "c".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const timing = { frame: 0, time: 0, totalFrames: 1, duration: 1, progress: 0 };

/** `posted` is everything but the render brackets' `started`, which the
 *  tests about answers do not care about; `wire` is every message in order. */
function fakePort() {
  const posted: Array<{ msg: RuntimeMessage; transfer: Transferable[] }> = [];
  const wire: RuntimeMessage[] = [];
  let handler: ((d: unknown) => void) | null = null;
  return {
    port: {
      post: (msg: RuntimeMessage, transfer: Transferable[]) => {
        wire.push(msg);
        if (msg.t !== "started") posted.push({ msg, transfer });
      },
      onMessage: (h: typeof handler) => { handler = h; },
    },
    posted,
    wire,
    emit: (d: unknown) => handler?.(d),
  };
}

/** A render's answer goes out one macrotask after the body returns. */
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeEngine() {
  const bitmap = { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
  return {
    bitmap,
    engine: {
      load: vi.fn(async () => ({ fontFailures: [] })),
      render: vi.fn(() => bitmap),
      dispose: vi.fn(),
      sourceHashOf: () => null,
    } as unknown as LayerEngine,
  };
}

describe("attachRuntime (worker side of the port)", () => {
  it("acks load, transfers the layer bitmap, and disposes — nothing is posted until asked", async () => {
    const { port, posted, emit } = fakePort();
    const { engine, bitmap } = fakeEngine();
    attachRuntime(port, "n1", engine);
    expect(posted).toHaveLength(0); // no ready here: the SUPERVISOR announces the worker (A1 §3)

    emit({ t: "load", id: "o1", kind: "code", source: "1", sourceHash: HASH, width: 1, height: 1 });
    await Promise.resolve(); await Promise.resolve();
    expect(posted[0].msg).toEqual({ t: "loaded", nonce: "n1", id: "o1", sourceHash: HASH });

    emit({ t: "render", id: "o1", frame: 0, req: 4, size: { width: 1, height: 1 }, pixelRatio: 1, fps: 30, time: timing });
    await nextTask();
    expect(posted[1].msg).toEqual({ t: "layer", nonce: "n1", id: "o1", frame: 0, req: 4, bitmap });
    expect(posted[1].transfer).toEqual([bitmap]);

    emit({ t: "dispose", id: "o1" });
    expect(engine.dispose).toHaveBeenCalledWith("o1");
  });
  it("ignores malformed messages", async () => {
    const { port, posted, emit } = fakePort();
    const { engine } = fakeEngine();
    attachRuntime(port, "n1", engine);
    emit({ t: "load" });
    emit("render");
    emit(null);
    await Promise.resolve();
    expect(engine.load).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });
  it("turns a BodyError into an error message with line/column, and any other throw into a render error", async () => {
    const { port, posted, emit } = fakePort();
    const { engine } = fakeEngine();
    (engine.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new BodyError("compile", "bad", undefined, undefined));
    (engine.render as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new BodyError("render", "x is not defined", 3, 9, "stack"); });
    attachRuntime(port, "n1", engine);
    emit({ t: "load", id: "o1", kind: "code", source: "1", sourceHash: HASH, width: 1, height: 1 });
    await Promise.resolve(); await Promise.resolve();
    // A compile/build error names the load it belongs to (Task 5 ruling), so a
    // superseded load's error cannot reject its successor host-side.
    expect(posted[0].msg).toEqual({ t: "error", nonce: "n1", id: "o1", phase: "compile", message: "bad", sourceHash: HASH });
    emit({ t: "render", id: "o1", frame: 0, req: 1, size: { width: 1, height: 1 }, pixelRatio: 1, fps: 30, time: timing });
    await nextTask();
    // A render error names the request it answers, so the host clears THAT
    // flight and no other (review I3).
    expect(posted[1].msg).toEqual({ t: "error", nonce: "n1", id: "o1", phase: "render", message: "x is not defined", line: 3, column: 9, stack: "stack", req: 1 });
    expect(errorMessage("n", "z", new TypeError("plain")).phase).toBe("render");
  });
  it("truncates message and stack to the wire caps BEFORE posting, so the host's parser never nulls the diagnostic", () => {
    const err = new BodyError("render", "m".repeat(5000), 1, 1, "s".repeat(20000));
    const msg = errorMessage("n1", "o1", err);
    expect(msg.message).toHaveLength(2000);
    expect(msg.stack).toHaveLength(8000);
  });
});

/** Microtasks, one macrotask (a render's answer), and microtasks again. */
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await nextTask();
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** A real LayerEngine on fake canvases: node has no OffscreenCanvas, and the
 *  bodies these tests run only need a 2D context that records calls. */
function realEngine(extra: Partial<ConstructorParameters<typeof LayerEngine>[0]> = {}) {
  const makeCanvas = (w: number, h: number) => {
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : (t[k as string] = vi.fn())),
      set: (t, k, v) => { t[k as string] = v; return true; },
    });
    const canvas = { width: w, height: h, getContext: () => ctx, transferToImageBitmap: () => new ArrayBuffer(8) };
    return canvas as unknown as OffscreenCanvas;
  };
  return new LayerEngine({ makeCanvas, now: () => 0, wrapperLineOffset: 2, installFont: vi.fn(async () => {}), measureContentBox: () => null, ...extra });
}
const loadMsg = (over: Record<string, unknown> = {}) => ({ t: "load", id: "o1", kind: "code", source: "1;", sourceHash: HASH_A, width: 10, height: 10, ...over });
const renderMsg = (over: Record<string, unknown> = {}) => ({ t: "render", id: "o1", frame: 0, req: 1, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing, ...over });
const g = globalThis as unknown as Record<string, unknown>;

describe("attachRuntime — the render bracket (Task 13 fix round 1, I2)", () => {
  const load = () => ({ t: "load", id: "o1", kind: "code", source: "1", sourceHash: HASH, width: 1, height: 1 });
  const render = (req = 1) => ({ t: "render", id: "o1", frame: 0, req, size: { width: 1, height: 1 }, pixelRatio: 1, fps: 30, time: timing });

  it("says `started` BEFORE the body is called, and answers only one macrotask after it returns", async () => {
    const { port, wire, emit } = fakePort();
    const { engine, bitmap } = fakeEngine();
    const atCall: string[][] = [];
    (engine.render as ReturnType<typeof vi.fn>).mockImplementation(() => { atCall.push(wire.map((m) => m.t)); return bitmap; });
    attachRuntime(port, "n1", engine);
    emit(load());
    await flush();
    emit(render(7));
    expect(atCall).toEqual([["loaded", "started"]]);
    expect(wire.at(-1)).toEqual({ t: "started", nonce: "n1", id: "o1", req: 7 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(wire.map((m) => m.t)).toEqual(["loaded", "started"]); // no answer while only microtasks ran
    await nextTask();
    expect(wire.at(-1)).toEqual({ t: "layer", nonce: "n1", id: "o1", frame: 0, req: 7, bitmap });
  });

  it("an error answer waits the same task", async () => {
    const { port, wire, emit } = fakePort();
    const { engine } = fakeEngine();
    (engine.render as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new BodyError("render", "boom", 1, 1); });
    attachRuntime(port, "n1", engine);
    emit(load());
    await flush();
    emit(render(3));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(wire.map((m) => m.t)).toEqual(["loaded", "started"]);
    await nextTask();
    expect(wire.at(-1)).toMatchObject({ t: "error", id: "o1", phase: "render", message: "boom", req: 3 });
  });

  it("a promise callback AND a setTimeout(…, 0) the body left behind both run before the answer is posted — a wedge in either lands while the host times this render", async () => {
    const { port, wire, emit } = fakePort();
    const { engine, bitmap } = fakeEngine();
    const seen: Record<string, string[]> = {};
    (engine.render as ReturnType<typeof vi.fn>).mockImplementation(() => {
      void Promise.resolve().then(() => { seen.microtask = wire.map((m) => m.t); });
      setTimeout(() => { seen.timer = wire.map((m) => m.t); }, 0);
      return bitmap;
    });
    attachRuntime(port, "n1", engine);
    emit(load());
    await flush();
    emit(render());
    await flush();
    expect(seen).toEqual({ microtask: ["loaded", "started"], timer: ["loaded", "started"] });
    expect(wire.map((m) => m.t)).toEqual(["loaded", "started", "layer"]);
  });

  it("uses the setTimeout captured at module load: a body that replaces the global's cannot hold its answer back", async () => {
    const { port, posted, emit } = fakePort();
    const { engine } = fakeEngine();
    attachRuntime(port, "n1", engine);
    emit(load());
    await flush();
    const real = globalThis.setTimeout;
    const hostile = vi.fn();
    globalThis.setTimeout = hostile as unknown as typeof setTimeout;
    try {
      emit(render());
    } finally {
      globalThis.setTimeout = real;
    }
    expect(hostile).not.toHaveBeenCalled();
    await nextTask();
    expect(posted.map((p) => p.msg.t)).toEqual(["loaded", "layer"]);
  });
});

describe("attachRuntime — a load that fails outside the body (review I1)", () => {
  it("maps any non-BodyError out of load to a BUILD error carrying the load's sourceHash, so the host settles that load", async () => {
    // e.g. the WebGL renderer will not come up. As a `render` error without a
    // hash the host could not settle the load, and its 5 s watchdog restarted
    // the worker and dropped a body that compiled fine.
    const { port, posted, emit } = fakePort();
    const { engine } = fakeEngine();
    (engine.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Error creating WebGL context."));
    attachRuntime(port, "n1", engine);
    emit(loadMsg());
    await flush();
    expect(posted[0].msg).toEqual({ t: "error", nonce: "n1", id: "o1", phase: "build", message: "Error creating WebGL context.", sourceHash: HASH_A });
  });
  it("a font that would not install still acks the load, and is reported without blaming the overlay", async () => {
    const { port, posted, emit } = fakePort();
    const engine = realEngine({ installFont: vi.fn(async () => { throw new Error("OTS parsing error: invalid sfntVersion"); }) });
    attachRuntime(port, "n1", engine);
    emit(loadMsg({ fonts: [{ family: "Broken Sans", weight: 700, data: new ArrayBuffer(4) }] }));
    await flush();
    expect(posted.map((p) => p.msg.t)).toEqual(["loaded", "unattributed"]);
    expect(posted[1].msg).toMatchObject({ t: "unattributed", nonce: "n1", message: expect.stringMatching(/Broken Sans.*700.*OTS parsing error/) });
  });
});

describe("attachRuntime — loads for one overlay never interleave (review I2)", () => {
  afterEach(() => { delete g.__drawn; });
  it("an older load parked on a font cannot overwrite a newer one: acks arrive in install order and the newest body renders", async () => {
    const { port, posted, emit } = fakePort();
    let releaseFont!: () => void;
    const installFont = vi.fn(() => new Promise<void>((r) => { releaseFont = r; }));
    const drawn: string[] = [];
    g.__drawn = drawn;
    attachRuntime(port, "n1", realEngine({ installFont }));
    emit(loadMsg({ source: "__drawn.push('A');", sourceHash: HASH_A, fonts: [{ family: "Inter", weight: 400, data: new ArrayBuffer(4) }] }));
    await flush();
    emit(loadMsg({ source: "__drawn.push('B');", sourceHash: HASH_B }));
    await flush();
    releaseFont();
    await flush();
    const acks = posted.filter((p) => p.msg.t === "loaded").map((p) => (p.msg as { sourceHash: string }).sourceHash);
    expect(acks).toEqual([HASH_A, HASH_B]); // the host's last word is the body that is live
    emit(renderMsg());
    expect(drawn).toEqual(["B"]);
  });
  it("two overlapping three loads: the superseded instance is disposed and its renderer released before the newer one builds", async () => {
    const { port, posted, emit } = fakePort();
    const inst = (tag: string): ThreeOverlayInstance => ({
      update: vi.fn(),
      applyTransform: vi.fn(),
      render: vi.fn(() => ({ transferToImageBitmap: () => ({ tag }) }) as unknown as OffscreenCanvas),
      dispose: vi.fn(),
      ready: Promise.resolve(),
    });
    const instA = inst("A");
    const instB = inst("B");
    let releaseAcquire!: () => void;
    const three = {
      acquire: vi.fn()
        .mockImplementationOnce(() => new Promise((r) => { releaseAcquire = () => r({} as never); }))
        .mockImplementation(async () => ({}) as never),
      release: vi.fn(),
      build: vi.fn(async (body: string) => (body.includes("B") ? instB : instA)),
    };
    attachRuntime(port, "n1", realEngine({ three }));
    emit(loadMsg({ kind: "three", source: "return () => 'A';", sourceHash: HASH_A }));
    await flush();
    emit(loadMsg({ kind: "three", source: "return () => 'B';", sourceHash: HASH_B }));
    await flush();
    expect(three.build).toHaveBeenCalledTimes(0); // B waits for A instead of sharing the per-id renderer
    releaseAcquire();
    await flush(20);
    expect(instA.dispose).toHaveBeenCalledTimes(1);
    expect(instB.dispose).not.toHaveBeenCalled();
    expect(three.release).toHaveBeenCalledTimes(1);
    expect(three.release.mock.invocationCallOrder[0]).toBeLessThan(three.acquire.mock.invocationCallOrder[1]);
    expect(posted.filter((p) => p.msg.t === "loaded").map((p) => (p.msg as { sourceHash: string }).sourceHash)).toEqual([HASH_A, HASH_B]);
    emit(renderMsg());
    await nextTask();
    expect((posted.at(-1)!.msg as unknown as { bitmap: { tag: string } }).bitmap.tag).toBe("B");
  });
  it("a dispose that arrives while a load is still installing lands AFTER it — no orphaned entry", async () => {
    const { port, emit } = fakePort();
    let releaseFont!: () => void;
    const engine = realEngine({ installFont: () => new Promise<void>((r) => { releaseFont = r; }) });
    attachRuntime(port, "n1", engine);
    emit(loadMsg({ fonts: [{ family: "Inter", weight: 400, data: new ArrayBuffer(4) }] }));
    await flush();
    emit({ t: "dispose", id: "o1" });
    releaseFont();
    await flush();
    expect(engine.isLoaded("o1")).toBe(false);
  });
});

describe("attachGlobalDiagnostics (escapes the synchronous body call — Task 6 review ruling, review I3)", () => {
  function scope() {
    const handlers = new Map<string, (ev: unknown) => void>();
    return {
      scope: { addEventListener: (t: string, h: (ev: never) => void) => { handlers.set(t, h as (ev: unknown) => void); } },
      fire: (t: string, ev: unknown) => handlers.get(t)?.(ev),
      types: () => [...handlers.keys()].sort(),
    };
  }
  /** A real, cancelable Event carrying ErrorEvent's fields: `preventDefault`
   *  is captured from `Event.prototype` and refuses anything that is not one. */
  function errorEvent(type: "error" | "unhandledrejection", fields: Record<string, unknown>): Event {
    return trusted(Object.assign(new Event(type, { cancelable: true }), fields));
  }
  /** What the browser fires: `isTrusted` is an own, unforgeable property of
   *  a real event (node keeps it on the prototype, so it can be set here). */
  function trusted<T extends object>(ev: T): T {
    return Object.defineProperty(ev, "isTrusted", { value: true, enumerable: true });
  }
  /** A body's own throw, as V8 reports it from inside `new Function`. */
  function bodyError(message: string) {
    const err = new Error(message);
    err.stack = `Error: ${message}\n    at eval (eval at compile (/app/lib/x.ts:1:1), <anonymous>:7:3)`;
    return err;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetImageCachesForTests();
    delete g.__escaped;
  });

  it("drawSvg in a piece with two overlays: the escape is blamed on the overlay that called it, never on the sibling rendered after it", async () => {
    // The concrete failing scenario: the host renders A (drawSvg) then B in one
    // frame; A's rejection lands in a later task, by which time "the overlay
    // last worked on" is B. B was then told it was broken and its in-flight
    // render was cleared, freezing it on hold-last-good.
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("The source image could not be decoded."); }));
    const escaped: unknown[] = [];
    g.__escaped = escaped;
    const { port, posted, emit } = fakePort();
    let t = 0;
    attachRuntime(port, "n1", realEngine());
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2, { now: () => t });
    expect(s.types()).toEqual(["error", "securitypolicyviolation", "unhandledrejection"]);
    // The body leaves the promise unhandled in real life; here it hands the
    // SAME rejection object the worker's `unhandledrejection` would carry to
    // the test, so vitest does not see a real unhandled rejection.
    emit(loadMsg({ id: "A", source: "drawSvg(context.ctx, '<svg/>', 0, 0, 10, 10).catch((e) => { __escaped.push(e); });", sourceHash: HASH_A }));
    emit(loadMsg({ id: "B", source: "context.ctx.fillRect(0, 0, 1, 1);", sourceHash: HASH_B }));
    await flush();
    emit(renderMsg({ id: "A", req: 1 }));
    emit(renderMsg({ id: "B", req: 2 }));
    await flush();
    expect(posted.filter((p) => p.msg.t === "layer").map((p) => (p.msg as { id: string }).id)).toEqual(["A", "B"]);
    expect(escaped.length).toBeGreaterThan(0);
    const before = posted.length;
    s.fire("unhandledrejection", errorEvent("unhandledrejection", { reason: escaped[0] }));
    const report = posted[before].msg as { t: string; id: string; phase: string; message: string; req?: number };
    expect(report).toMatchObject({ t: "error", id: "A", phase: "render" });
    expect(report.message).toMatch(/does not rasterize SVG/);
    expect(report.req).toBeUndefined(); // answers no render: the host must not clear a flight on it
    expect(posted.slice(before).some((p) => (p.msg as { id?: string }).id === "B")).toBe(false);

    // Every frame repeats the failure; the reports are rate-limited per overlay.
    for (const reason of escaped) s.fire("unhandledrejection", errorEvent("unhandledrejection", { reason }));
    expect(posted.length).toBe(before + 1);
    t += ASYNC_REPORT_INTERVAL_MS;
    s.fire("unhandledrejection", errorEvent("unhandledrejection", { reason: escaped[1] }));
    expect(posted.length).toBe(before + 2);
  });
  it("an escape nothing ties to an overlay is reported UNATTRIBUTED, mapped onto the body's line, and blames no one", async () => {
    const { port, posted, emit } = fakePort();
    attachRuntime(port, "n1", realEngine());
    emit(loadMsg({ id: "o7" }));
    await flush();
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2);
    const before = posted.length;
    s.fire("error", errorEvent("error", { error: bodyError("boom"), message: "Uncaught Error: boom" }));
    s.fire("unhandledrejection", errorEvent("unhandledrejection", { reason: bodyError("late") })); // rate-limited: same bucket
    expect(posted.slice(before).map((p) => p.msg)).toEqual([
      expect.objectContaining({ t: "unattributed", nonce: "n1", message: "boom", line: 5, column: 3 }),
    ]);
    expect((posted[before].msg as { stack?: string }).stack).not.toContain("/app/lib/x.ts");
  });
  it("a hostile body's setTimeout(() => { throw }) loop cannot flood the host", () => {
    const { port, posted } = fakePort();
    let t = 0;
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2, { now: () => t });
    for (let i = 0; i < 250; i++) { t += 4; s.fire("error", errorEvent("error", { error: bodyError(`x${i}`) })); }
    // 250 escapes over 1 s: one report per interval.
    expect(posted.length).toBeLessThanOrEqual(2);
  });
  it("cancels every uncaught error it sees, reported or rate-limited, so none is re-fired at the supervisor thread (re-review N1)", () => {
    // An `error` the worker does not cancel is re-fired at the Worker object in
    // the supervisor (HTML "report an exception"). A body that throws from 2000
    // microtasks would put 2000 events on that thread; the rate limit only
    // decides whether WE report, so the cancel must come first, on every path.
    const { port, posted } = fakePort();
    let t = 0;
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2, { now: () => t });
    const events: Event[] = [];
    for (let i = 0; i < 50; i++) {
      const ev = errorEvent("error", { error: bodyError(`x${i}`), message: `Uncaught Error: x${i}` });
      events.push(ev);
      s.fire("error", ev);
    }
    const noError = errorEvent("error", { error: null, message: "" }); // a cross-origin-style bare event
    s.fire("error", noError);
    const rejection = errorEvent("unhandledrejection", { reason: bodyError("late") });
    s.fire("unhandledrejection", rejection);
    expect(posted.length).toBe(1); // 52 events in one interval: one report, 51 dropped…
    expect([...events, noError, rejection].every((ev) => ev.defaultPrevented)).toBe(true); // …and all 52 cancelled
    t += ASYNC_REPORT_INTERVAL_MS;
    const later = errorEvent("error", { error: bodyError("later") });
    s.fire("error", later);
    expect(posted.length).toBe(2);
    expect(later.defaultPrevented).toBe(true);
  });
  it("cancels through the preventDefault captured at module load, not one a body patched onto Event.prototype (re-review N1)", () => {
    const { port } = fakePort();
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2);
    const original = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function () {}; // a hostile body's no-op
    try {
      const ev = errorEvent("error", { error: bodyError("boom") });
      s.fire("error", ev);
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      Event.prototype.preventDefault = original;
    }
  });
  it("ignores UNTRUSTED events: a body cannot forge a policy report or take the unattributed slot with dispatchEvent", () => {
    const { port, posted } = fakePort();
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2, { setTimer: vi.fn() });
    // What `self.dispatchEvent(new SecurityPolicyViolationEvent(…))` and a
    // hand-made ErrorEvent look like: isTrusted is false.
    s.fire("securitypolicyviolation", { isTrusted: false, violatedDirective: "connect-src", blockedURI: "ws://forged" });
    const forgedError = Object.assign(new Event("error", { cancelable: true }), { error: bodyError("forged") });
    s.fire("error", forgedError);
    s.fire("unhandledrejection", Object.assign(new Event("unhandledrejection", { cancelable: true }), { reason: bodyError("forged") }));
    expect(posted).toEqual([]);
    // …so the slot is still free for what the browser really reports.
    s.fire("securitypolicyviolation", { isTrusted: true, violatedDirective: "connect-src", blockedURI: "ws://real" });
    expect(posted.map((p) => p.msg)).toEqual([expect.objectContaining({ t: "unattributed", message: "blocked by the sandbox policy: connect-src (ws://real)" })]);
  });
  it("the shared unattributed slot says what it swallowed: a count on its next report, or the newest swallowed report once it reopens", () => {
    const { port, posted } = fakePort();
    let t = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2, { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); } });
    const csp = (uri: string) => ({ isTrusted: true, violatedDirective: "connect-src", blockedURI: uri });
    s.fire("securitypolicyviolation", csp("ws://first"));
    t = 300;
    s.fire("securitypolicyviolation", csp("ws://second"));
    t = 400;
    s.fire("error", errorEvent("error", { error: bodyError("third") }));
    expect(posted.map((p) => (p.msg as { message: string }).message)).toEqual(["blocked by the sandbox policy: connect-src (ws://first)"]);
    // One flush, when the slot reopens (1000 ms after the first report).
    expect(timers.map((x) => x.ms)).toEqual([ASYNC_REPORT_INTERVAL_MS - 300]);
    t = ASYNC_REPORT_INTERVAL_MS;
    timers[0].fn();
    expect((posted[1].msg as { message: string }).message).toBe("third (+1 more unattributed report suppressed by the rate limit)");

    // Something new claims the reopened slot first: it carries the count, and
    // the flush has nothing left to say.
    t = 1100;
    s.fire("securitypolicyviolation", csp("ws://fourth"));
    s.fire("securitypolicyviolation", csp("ws://fifth"));
    expect(timers).toHaveLength(2);
    t = 2 * ASYNC_REPORT_INTERVAL_MS + 1;
    s.fire("securitypolicyviolation", csp("ws://sixth"));
    expect((posted[2].msg as { message: string }).message).toBe(
      "blocked by the sandbox policy: connect-src (ws://sixth) (+2 more unattributed reports suppressed by the rate limit)",
    );
    timers[1].fn();
    expect(posted).toHaveLength(3);
  });
  it("a flush timer that fires a hair before the slot reopens tries again instead of dropping what it holds", () => {
    // Timers and performance.now() are separate clocks: a timer set for the
    // remaining 700 ms can run when now() says 999.9 ms have passed. The
    // swallowed report must still go out — found live, a WebSocket refusal
    // that never reached the agent (e2e, 1 run in 9).
    const { port, posted } = fakePort();
    let t = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2, { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); } });
    const csp = (uri: string) => ({ isTrusted: true, violatedDirective: "connect-src", blockedURI: uri });
    s.fire("securitypolicyviolation", csp("ws://first"));
    t = 300;
    s.fire("securitypolicyviolation", csp("ws://second"));
    t = ASYNC_REPORT_INTERVAL_MS - 0.1; // early
    timers[0].fn();
    expect(posted).toHaveLength(1);
    expect(timers).toHaveLength(2); // rescheduled for what is left
    expect(timers[1].ms).toBeGreaterThan(0);
    t = ASYNC_REPORT_INTERVAL_MS;
    timers[1].fn();
    expect(posted.map((p) => (p.msg as { message: string }).message)).toEqual([
      "blocked by the sandbox policy: connect-src (ws://first)",
      "blocked by the sandbox policy: connect-src (ws://second)",
    ]);
  });
  it("relays a CSP refusal as an unattributed diagnostic (a WebSocket constructor does not throw — A1)", () => {
    const { port, posted } = fakePort();
    const s = scope();
    attachGlobalDiagnostics(s.scope, port, "n1", 2);
    s.fire("securitypolicyviolation", { violatedDirective: "connect-src", blockedURI: "" });
    expect(posted[0].msg).toMatchObject({ t: "unattributed", message: "blocked by the sandbox policy: connect-src (no URI)" });
  });
});

describe("bindPrivatePort (review I4 — a body cannot reach the runtime's port through a prototype)", () => {
  it("a body that patches MessagePort.prototype.postMessage and MessageEvent.prototype.data cannot forge a frame, a load ack or an error", async () => {
    const portProto = MessagePort.prototype as unknown as Record<string, unknown>;
    const originalPost = portProto.postMessage as MessagePort["postMessage"];
    const originalData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!;
    const stolen: unknown[] = [];
    g.__stolen = stolen;
    const { port1, port2 } = new MessageChannel();
    // port2 plays the HOST, which lives in another realm in production: its
    // side of the test must not go through the prototypes the body patches.
    const hostPost = (m: unknown) => originalPost.call(port2, m);
    const received: Array<Record<string, unknown>> = [];
    port2.onmessage = (ev) => received.push(originalData.get!.call(ev) as Record<string, unknown>);
    try {
      attachRuntime(bindPrivatePort(port1), "n1", realEngine());
      // Written the way a body must be to pass the denylist.
      const hostile = [
        "const P = MessagePort.prototype;",
        "const orig = P['post' + 'Message'];",
        "P['post' + 'Message'] = function (m, t) {",
        "  __stolen.push(this);",
        "  const forged = { nonce: m && m.nonce, id: 'victim', sourceHash: 'f'.repeat(64) };",
        "  orig.call(this, Object.assign({ t: 'loaded' }, forged));",
        "  orig.call(this, Object.assign({ t: 'error', phase: 'build', message: 'forged' }, forged));",
        "  orig.call(this, Object.assign({ t: 'layer', frame: 0, req: 99, bitmap: new ArrayBuffer(1) }, forged));",
        "  return orig.call(this, m, t);",
        "};",
        "const d = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');",
        "Object.defineProperty(MessageEvent.prototype, 'data', { configurable: true, get() { __stolen.push(this); return d.get.call(this); } });",
        "context.ctx.fillRect(0, 0, 1, 1);",
      ].join("\n");
      hostPost(loadMsg({ source: hostile }));
      await vi.waitFor(() => expect(received).toHaveLength(1));
      hostPost(renderMsg()); // the body runs, and patches both prototypes
      await vi.waitFor(() => expect(received).toHaveLength(3));
      hostPost(loadMsg({ id: "o2" })); // read and answered AFTER the patch
      hostPost(renderMsg({ req: 2 }));
      await vi.waitFor(() => expect(received).toHaveLength(6));
      await new Promise((r) => setTimeout(r, 20));
      expect(received.map((m) => [m.t, m.id])).toEqual([
        ["loaded", "o1"], ["started", "o1"], ["layer", "o1"], ["loaded", "o2"], ["started", "o1"], ["layer", "o1"],
      ]);
      expect(received.some((m) => m.id === "victim")).toBe(false);
      expect(stolen).toEqual([]);
    } finally {
      portProto.postMessage = originalPost;
      Object.defineProperty(MessageEvent.prototype, "data", originalData);
      port1.close();
      port2.close();
      delete g.__stolen;
    }
  });
});

describe("attachRuntime — custom effect sampling (`sample` → `curve`)", () => {
  const sample = (source: string, extra: Record<string, unknown> = {}) => ({
    t: "sample",
    id: "fx-1",
    source,
    sourceHash: HASH,
    params: { amount: 10 },
    samples: 5,
    ...extra,
  });

  it("samples the body at i/(n-1) with a fresh params copy, answers one task later with the table transferred", async () => {
    const { port, posted, emit } = fakePort();
    const { engine } = fakeEngine();
    attachRuntime(port, "n1", engine);
    emit(sample("params.amount = params.amount + 1; return { dx: progress * params.amount };"));
    expect(posted).toHaveLength(0);
    await nextTask();
    expect(posted).toHaveLength(1);
    const { msg, transfer } = posted[0]!;
    expect(msg).toMatchObject({ t: "curve", nonce: "n1", id: "fx-1", samples: 5 });
    const data = new Float64Array((msg as { data: ArrayBuffer }).data);
    // dx column: progress × 11 at each sample — the mutation never carried over.
    expect(Array.from(data.slice(0, 5))).toEqual([0, 2.75, 5.5, 8.25, 11]);
    expect(transfer).toEqual([(msg as { data: ArrayBuffer }).data]);
  });

  it("a body that does not compile answers a compile error for that request", async () => {
    const { port, posted, emit } = fakePort();
    attachRuntime(port, "n1", fakeEngine().engine);
    emit(sample("return { dx: "));
    await nextTask();
    expect(posted[0]!.msg).toMatchObject({ t: "error", id: "fx-1", phase: "compile" });
  });

  it("a body that throws at some progress contributes identity there, not a failure", async () => {
    const { port, posted, emit } = fakePort();
    attachRuntime(port, "n1", fakeEngine().engine);
    emit(sample("if (progress > 0.5) throw new Error('boom'); return { dy: 1 };"));
    await nextTask();
    const data = new Float64Array((posted[0]!.msg as { data: ArrayBuffer }).data);
    const dy = Array.from(data.slice(5, 10));
    expect(dy.slice(0, 3)).toEqual([1, 1, 1]);
    expect(dy.slice(3).every((v) => Number.isNaN(v))).toBe(true);
  });

  it("refuses a request past the wire's bounds without running it", async () => {
    const { port, posted, emit } = fakePort();
    attachRuntime(port, "n1", fakeEngine().engine);
    emit(sample("return {};", { samples: 100_000 }));
    emit(sample("return {};", { sourceHash: "not-a-hash" }));
    await nextTask();
    expect(posted).toHaveLength(0);
  });
});
