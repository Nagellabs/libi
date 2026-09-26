/**
 * Strip the worker of every primitive a body could use to talk to anything,
 * BEFORE any body runs. The strict CSP (`connect-src 'none'`, `script-src`
 * naming only the bundle) is the boundary; this makes the attempt FAIL
 * SYNCHRONOUSLY with a message the agent can read in the diagnostic. Same idea
 * as the storyboard render worker's in-process strip
 * (lib/storyboard/render/worker-entry.ts).
 *
 * Deliberately NOT stubbed (spec A1, measured): `WebSocket` — its constructor
 * does not throw and the CSP refuses the connection, which the runtime relays
 * from the `securitypolicyviolation` event; `importScripts` — the CSP makes it
 * throw a NetworkError itself. Stubbing them would hide the boundary the
 * Playwright test proves.
 *
 * `indexedDB` exists in a worker (opaque-origin-partitioned, of no use to a
 * body): it becomes `undefined`.
 *
 * Every name is replaced on the global AND on each prototype of its chain that
 * owns it. Chromium keeps the real `fetch` on `WorkerGlobalScope.prototype`
 * beside the global's own property, and `indexedDB` as an accessor there
 * (measured, Task 13): a stub on the global alone left
 * `Object.getOwnPropertyDescriptor(WorkerGlobalScope.prototype, "fetch").value`
 * one prototype walk away — the CSP still refused the request, but nothing
 * failed synchronously and the diagnostic named no overlay.
 *
 * `close` is here because it ends the worker: a body that called it left every
 * later render unanswered, and the watchdog dropped whichever SIBLING it was
 * timing — the body that did it was never blamed (Task 13).
 *
 * The rest are TASK SOURCES the owner tagging does not wrap (async-owner.ts,
 * Task 13 fix round 3): a callback they run announces no owner, so a body that
 * wedged the worker through one fell to the host's two-offence fallback instead
 * of being blamed at once. All of them are exposed in a dedicated worker
 * (measured in Chromium 147):
 *  - `MessageChannel`, `BroadcastChannel` — a message the body posts to itself
 *    runs `onmessage` as a task of its own. The runtime's own channels are made
 *    on the supervisor and main threads; the worker only RECEIVES its port;
 *  - `scheduler` — `postTask` is a timer with a priority. It is a
 *    `WorkerGlobalScope.prototype` accessor only, and becomes `undefined`.
 *    three.js reads it in `yieldToMain` (three.core.js), reached only from the
 *    WebGPU build libi never imports, and falls back to `requestAnimationFrame`,
 *    which is wrapped;
 *  - `AbortSignal.timeout` — fires `abort` as its own task, past the wrapped
 *    `setTimeout`. Only that static goes: `AbortSignal` and `AbortController`
 *    stay (three's loaders call `AbortSignal.any`, dead anyway without
 *    `fetch`), and Chromium's `TaskSignal` inherits the stub;
 *  - `PerformanceObserver`, `ReportingObserver` — their callbacks are tasks.
 * No bundled skill tells a body to use any of these.
 *
 * `navigator.gpu` (WebGPU, exposed in dedicated workers) goes too (final
 * security review, M4): every promise it hands out settles untagged, and a
 * compute shader that never ends hangs the GPU process for the whole app.
 * libi imports three's WebGL build only, which never reads it.
 */
export const HARDENED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "EventSource",
  "Worker",
  "close",
  "MessageChannel",
  "BroadcastChannel",
  "PerformanceObserver",
  "ReportingObserver",
] as const;
export const DELETED_GLOBALS = ["indexedDB", "scheduler"] as const;
/** Deleted from `navigator` (and every owner on its chain): see above. */
export const DELETED_NAVIGATOR = ["gpu"] as const;
/** `[constructor, static method]`: the method is stubbed on the constructor
 *  and on every object of its chain that owns a copy. */
export const HARDENED_STATICS = [["AbortSignal", "timeout"]] as const;

function blocked(name: string): () => never {
  return function blockedInSandbox(): never {
    throw new Error(`${name} is not available inside an overlay body`);
  };
}

/** `g`, plus every object on its prototype chain that owns `name`. */
function ownersOf(g: object, name: string): object[] {
  const owners: object[] = [g];
  for (let o = Object.getPrototypeOf(g) as object | null; o; o = Object.getPrototypeOf(o) as object | null) {
    if (Object.prototype.hasOwnProperty.call(o, name)) owners.push(o);
  }
  return owners;
}

function pin(g: object, name: string, value: unknown): void {
  for (const target of ownersOf(g, name)) {
    Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
  }
}

export function hardenWorkerGlobals(g: typeof globalThis): void {
  for (const name of HARDENED_GLOBALS) pin(g, name, blocked(name));
  for (const name of DELETED_GLOBALS) pin(g, name, undefined);
  const nav = (g as unknown as { navigator?: unknown }).navigator;
  if (typeof nav === "object" && nav !== null) for (const name of DELETED_NAVIGATOR) pin(nav, name, undefined);
  for (const [ctor, method] of HARDENED_STATICS) {
    const target = (g as unknown as Record<string, unknown>)[ctor];
    if (typeof target === "function") pin(target, method, blocked(`${ctor}.${method}`));
  }
}

/**
 * After the worker announced itself (`WORKER_BOOTED`), nothing in it has any
 * business talking to the supervisor thread: every later message rides the
 * private port. Without this a body could flood the thread that must never be
 * busy — `self["post" + "Message"]` walks straight past the denylist (Task 7
 * review I4). Chromium keeps the method on the global itself — WebIDL puts a
 * [Global] interface's operations there, and no prototype of the chain owns a
 * copy (measured, Task 13 fix round 1) — but every own `postMessage` on the
 * chain is replaced, non-writable and non-configurable, so a layout that moved
 * one onto `DedicatedWorkerGlobalScope.prototype` would leave no
 * `Object.getPrototypeOf(self).postMessage.call(self, …)` either.
 */
export function lockWorkerPostMessage(g: typeof globalThis): void {
  pin(g, "postMessage", blocked("postMessage"));
}
