/**
 * The WORKER body of the sandboxed overlay runtime (esbuild bundle root; see
 * lib/sandbox/runtime-bundle.ts). Spawned by the supervisor as a CLASSIC
 * worker from a blob: URL inside <iframe sandbox="allow-scripts">, so it runs
 * at the frame's opaque origin under the strict CSP (spec A1 §2). In the
 * dev-only in-origin mode the same script runs as a same-origin blob worker.
 *
 * Order matters: harden the globals BEFORE anything else, so no body can ever
 * observe the originals. The first message is the supervisor's `init` with
 * the port; everything after that happens on the port. The primitives the port
 * itself relies on were captured when `./runtime/serve` was evaluated — before
 * this line, and so before any body (Task 7 review I4).
 */
import { parseWorkerInit, WORKER_BOOTED } from "@/lib/sandbox/protocol";
import { probeWrapperLineOffset } from "./runtime/compile";
import { hardenWorkerGlobals, lockWorkerPostMessage } from "./runtime/harden";
import { IDLE_LAYER_MS, LayerEngine } from "./runtime/layers";
import { createAsyncOwner, installOwnedTimers, type TimerScope } from "./runtime/async-owner";
import { attachGlobalDiagnostics, attachRuntime, bindPrivatePort, yieldOneTask } from "./runtime/serve";
import { makeThreeRuntimeDeps } from "./runtime/three";

hardenWorkerGlobals(self as unknown as typeof globalThis);

/** How often idle layers are swept. The 60 s in `IDLE_LAYER_MS` is the age
 *  that counts; this is only how finely it is noticed. */
const EVICT_INTERVAL_MS = 15_000;

function boot(nonce: string, port: MessagePort): void {
  const wrapperLineOffset = probeWrapperLineOffset();
  const runtimePort = bindPrivatePort(port);
  // Every callback a body can schedule is tagged with its owner from here on
  // (Task 13 fix round 2): no body has run yet, so the timers wrapped here are
  // the worker's own. The runtime's own scheduling uses copies captured at
  // module evaluation (serve.ts), which these wrappers never see.
  const asyncOwner = createAsyncOwner(runtimePort, nonce, yieldOneTask);
  const ownedTimers = installOwnedTimers(self as unknown as TimerScope, asyncOwner);
  const engine = new LayerEngine({
    makeCanvas: (w, h) => new OffscreenCanvas(w, h),
    now: () => performance.now(),
    wrapperLineOffset,
    three: makeThreeRuntimeDeps(),
    asyncOwner,
    ownedTimers,
  });
  attachRuntime(runtimePort, nonce, engine, { owner: asyncOwner });

  // A CSP refusal, and any throw that escapes the synchronous body call (a
  // `.then()` callback, a timer the body set), reach the worker's global
  // events instead of the call site: they are mapped onto the body's own line
  // and delivered as an `error` for the overlay whose helper rejected, or as
  // `unattributed` when nothing ties them to one — never as a
  // `supervisorError`, and never blamed on whichever overlay ran last.
  attachGlobalDiagnostics(
    self as unknown as { addEventListener(type: string, handler: (ev: never) => void): void },
    runtimePort,
    nonce,
    wrapperLineOffset,
  );

  // The supervisor's boot-failure relay closes here: from now on the worker's
  // own handlers own its diagnostics (lib/sandbox/supervisor.ts#createBootGate).
  self.postMessage({ t: WORKER_BOOTED });
  // …and this was the last message this thread may ever post to the
  // supervisor. No body has run yet: the first `load` is still to come.
  lockWorkerPostMessage(self as unknown as typeof globalThis);

  setInterval(() => engine.evictIdle(IDLE_LAYER_MS), EVICT_INTERVAL_MS);
}

self.onmessage = (ev: MessageEvent) => {
  const init = parseWorkerInit(ev.data);
  if (!init) return;
  // Exactly one init per worker: after it, nothing else is accepted on the
  // global scope — every later message rides the private transferred port.
  self.onmessage = null;
  boot(init.nonce, init.port);
};
