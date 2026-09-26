import { describe, it, expect } from "vitest";
import { hardenWorkerGlobals, lockWorkerPostMessage, HARDENED_GLOBALS, HARDENED_STATICS, DELETED_GLOBALS, DELETED_NAVIGATOR } from "@/lib/sandbox/runtime/harden";

/** A stand-in for WorkerGlobalScope, laid out as Chromium lays it out
 *  (measured in the sandbox worker, Task 13): `fetch` both on the global and
 *  on the prototype, `indexedDB` as a prototype accessor, `close` and the
 *  constructors on the global. */
function fakeWorkerGlobal() {
  const realFetch = () => Promise.resolve("reached the network");
  const proto: Record<string, unknown> = { fetch: realFetch, importScripts: () => {} };
  Object.defineProperty(proto, "indexedDB", { get: () => ({ open() {} }), configurable: true });
  const g = Object.create(proto) as Record<string, unknown>;
  g.fetch = realFetch;
  g.XMLHttpRequest = class {};
  g.EventSource = class {};
  g.Worker = class {};
  g.WebSocket = class {};
  g.close = () => {};
  // Task 13 fix round 3 (N1): the task sources the owner tagging cannot see.
  g.MessageChannel = class {};
  g.BroadcastChannel = class {};
  g.PerformanceObserver = class {};
  g.ReportingObserver = class {};
  // `scheduler` is a WorkerGlobalScope.prototype accessor only (measured).
  Object.defineProperty(proto, "scheduler", { get: () => ({ postTask: (fn: () => void) => fn() }), configurable: true });
  class FakeAbortSignal {
    aborted = false;
    static abort() { const s = new FakeAbortSignal(); s.aborted = true; return s; }
    static any(signals: FakeAbortSignal[]) { return signals[0]; }
    static timeout() { return new FakeAbortSignal(); }
  }
  g.AbortSignal = FakeAbortSignal;
  return { g, proto };
}

describe("hardenWorkerGlobals (defense in depth under the CSP — spec §4.3 + A1)", () => {
  it("removes navigator.gpu on the navigator and on the prototype that owns its accessor (final review M4)", () => {
    const { g } = fakeWorkerGlobal();
    const navProto = {};
    Object.defineProperty(navProto, "gpu", { get: () => ({ requestAdapter: async () => ({}) }), configurable: true });
    g.navigator = Object.create(navProto);
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    expect(DELETED_NAVIGATOR).toEqual(["gpu"]);
    expect((g.navigator as { gpu?: unknown }).gpu).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(navProto, "gpu")?.get).toBeUndefined();
    expect(() => Object.defineProperty(navProto, "gpu", { get: () => 1 })).toThrow();
  });
  it("turns fetch / XMLHttpRequest / EventSource / Worker / close and the unattributable task sources into throwing, non-writable stubs", () => {
    const { g } = fakeWorkerGlobal();
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    expect(HARDENED_GLOBALS).toEqual([
      "fetch", "XMLHttpRequest", "EventSource", "Worker", "close",
      "MessageChannel", "BroadcastChannel", "PerformanceObserver", "ReportingObserver",
    ]);
    for (const name of HARDENED_GLOBALS) {
      expect(() => (g[name] as () => unknown)(), name).toThrow(/is not available inside an overlay body/);
      expect(() => { g[name] = () => 1; }, name).toThrow(); // frozen: a body cannot restore it
    }
  });
  it("replaces the prototype's copy too: the real fetch is not one prototype walk away", () => {
    const { g, proto } = fakeWorkerGlobal();
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    const fromProto = Object.getOwnPropertyDescriptor(proto, "fetch")?.value as () => unknown;
    expect(() => fromProto.call(g)).toThrow(/fetch is not available inside an overlay body/);
    expect(() => Object.defineProperty(proto, "fetch", { value: () => 1 })).toThrow();
  });
  it("the constructors are stubbed for `new` too, which is how a body reaches them", () => {
    const { g } = fakeWorkerGlobal();
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    for (const name of ["MessageChannel", "BroadcastChannel", "PerformanceObserver", "ReportingObserver"]) {
      const Ctor = g[name] as new (...a: unknown[]) => unknown;
      expect(() => new Ctor(() => {}), name).toThrow(`${name} is not available inside an overlay body`);
    }
  });
  it("makes scheduler unreachable: undefined on the global, and the prototype accessor is gone", () => {
    const { g, proto } = fakeWorkerGlobal();
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    expect(g.scheduler).toBeUndefined();
    const d = Object.getOwnPropertyDescriptor(proto, "scheduler");
    expect(d?.get).toBeUndefined();
    expect(d?.value).toBeUndefined();
    expect(() => Object.defineProperty(proto, "scheduler", { get: () => ({}) })).toThrow();
  });
  it("removes AbortSignal.timeout — a timer the owner tagging never sees — and keeps AbortSignal itself usable", () => {
    const { g } = fakeWorkerGlobal();
    const Signal = g.AbortSignal as { timeout(ms: number): unknown; abort(): { aborted: boolean }; any(s: unknown[]): unknown };
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    expect(g.AbortSignal).toBe(Signal);
    expect(HARDENED_STATICS).toEqual([["AbortSignal", "timeout"]]);
    expect(() => Signal.timeout(1000)).toThrow("AbortSignal.timeout is not available inside an overlay body");
    expect(() => { Signal.timeout = () => ({}); }).toThrow();
    // A subclass inherits the stub (Chromium's TaskSignal extends AbortSignal).
    class Sub extends (Signal as unknown as new () => object) {}
    expect(() => (Sub as unknown as typeof Signal).timeout(1)).toThrow(/not available/);
    expect(Signal.abort().aborted).toBe(true);
    expect(typeof Signal.any).toBe("function");
  });
  it("makes indexedDB undefined, and removes the prototype accessor a real worker defines", () => {
    const { g, proto } = fakeWorkerGlobal();
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    expect(DELETED_GLOBALS).toEqual(["indexedDB", "scheduler"]);
    expect(g.indexedDB).toBeUndefined();
    expect(() => { g.indexedDB = {}; }).toThrow();
    const d = Object.getOwnPropertyDescriptor(proto, "indexedDB");
    expect(d?.get).toBeUndefined();
    expect(d?.value).toBeUndefined();
  });
  it("leaves WebSocket and importScripts to the CSP (A1: assert on the connection failure / NetworkError)", () => {
    const { g } = fakeWorkerGlobal();
    const ws = g.WebSocket;
    const is = g.importScripts;
    hardenWorkerGlobals(g as unknown as typeof globalThis);
    expect(g.WebSocket).toBe(ws);
    expect(g.importScripts).toBe(is);
  });
});

describe("lockWorkerPostMessage (review I4 — after WORKER_BOOTED nothing may post to the supervisor thread)", () => {
  /** A real DedicatedWorkerGlobalScope has `postMessage` on its PROTOTYPE, so
   *  shadowing it on the global alone leaves `Object.getPrototypeOf(self).postMessage.call(self, …)`. */
  function scopeWithProtoPost() {
    const sent: unknown[] = [];
    const proto = { postMessage(this: unknown, m: unknown) { sent.push(m); } };
    const g = Object.create(proto) as Record<string, unknown>;
    return { g, proto, sent };
  }
  it("makes self.postMessage a throwing, non-writable, non-configurable stub, on the global AND its prototype", () => {
    const { g, proto, sent } = scopeWithProtoPost();
    const original = proto.postMessage;
    lockWorkerPostMessage(g as unknown as typeof globalThis);
    expect(() => (g.postMessage as (m: unknown) => void)({ t: "x" })).toThrow(/not available inside an overlay body/);
    expect(() => (Object.getPrototypeOf(g).postMessage as (m: unknown) => void).call(g, { t: "x" })).toThrow(/not available/);
    expect(() => { g.postMessage = original; }).toThrow();
    expect(() => Object.defineProperty(g, "postMessage", { value: original })).toThrow();
    expect(() => Object.defineProperty(proto, "postMessage", { value: original })).toThrow();
    expect(sent).toEqual([]);
  });
});
