import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KEEPS_BLOCKING_MESSAGE,
  LOAD_TIMEOUT_MS,
  OverlaySandbox,
  PREVIEW_KEPT_STALLING_MESSAGE,
  PREVIEW_KEPT_STALLING_UNNAMED_MESSAGE,
  REPEAT_WEDGE_WINDOW_MS,
  RENDER_TIMEOUT_MS,
  STALL_HALF_LIFE_MS,
  STALL_SCORE_LIMIT,
  decayStallScore,
  UNSTARTED_WEDGE_MESSAGE,
  type SandboxTransport,
} from "@/lib/sandbox/host";
import { PROTOCOL_VERSION, type HostMessage, type LoadMessage, type RenderMessage } from "@/lib/sandbox/protocol";
import { attachRuntime, type RuntimePort } from "@/lib/sandbox/runtime/serve";
import { createAsyncOwner, installOwnedTimers, type TimerScope } from "@/lib/sandbox/runtime/async-owner";
import { makeRuntimeHelpers } from "@/lib/sandbox/runtime/helpers";
import type { LayerEngine } from "@/lib/sandbox/runtime/layers";
import { __resetImageCachesForTests } from "@/lib/engine/drawing";

/**
 * Task 13 fix round 1, controller ruling on I2: a body that leaves work
 * running after it returns — a timer, a promise callback — and that work never
 * ends, wedges the worker BETWEEN renders. The watchdog then times whichever
 * render the host asked for next, a sibling's, and used to drop it.
 *
 * These tests wire the REAL host (`OverlaySandbox`) to the REAL runtime message
 * loop (`attachRuntime`) over an in-memory port, with a fake engine whose
 * "bodies" are callbacks. `freeze` stands in for `for (;;);`: from the moment it
 * runs, the worker thread runs nothing else — nothing it posts leaves, nothing
 * posted to it is read. Both legs deliver on a task (`setTimeout(…, 0)`, faked),
 * like a MessagePort, and the runtime's one-task yield is the same fake clock,
 * so a body's own `setTimeout(…, 0)` and the runtime's are ordered as in a
 * browser: first scheduled, first run.
 *
 * Fix round 2 (controller ruling: tag async work with its owner): the worker's
 * timers are the REAL wrappers (`installOwnedTimers`) over the fake clock, and
 * a body reaches them — and its own runtime helpers — through `api`. What it
 * reaches through `api.untagged` stands for an async source the runtime does
 * not wrap (an event listener, a browser promise): the fallback path.
 */

/** What a fake `load` gets: the worker's owner tracking, as a three build
 *  uses it, and the same `freeze`. */
type LoadHook = (freeze: () => void, enter: () => void) => void;

interface BodyApi {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  loadImage(src: string): Promise<unknown>;
  untagged: { setTimeout(fn: () => void, ms: number): unknown };
}
type Body = (freeze: () => void, api: BodyApi) => void;

const HASH = (c: string) => c.repeat(64);
const timing = { frame: 0, time: 0, totalFrames: 30, duration: 1, progress: 0 };
const bitmap = () => ({ width: 1, height: 1, close: vi.fn() }) as unknown as ImageBitmap;

/** `yieldMs`: how long the runtime's one-task yield takes on the fake clock.
 *  0 orders it like a browser's `setTimeout(…, 0)`; more opens room for a
 *  sibling's timer to fall due while a render waits for its answer. */
function liveSandbox(
  bodies: Record<string, Body>,
  { yieldMs = 0, loads = {} }: { yieldMs?: number; loads?: Record<string, LoadHook> } = {},
) {
  let handler: ((d: unknown, s: unknown) => void) | null = null;
  const peer = { tag: "frame" };
  const commands: unknown[] = [];
  const transport: SandboxTransport = {
    // The supervisor is alive throughout: it answers every ping (the host
    // pings a frame that is slow to say `ready` — final review I3), and the
    // test decides when a restart's fresh worker comes up (`boot`).
    command: (msg) => {
      if (msg.t === "ping") {
        setTimeout(() => handler?.({ t: "pong", nonce: "nonce-1", id: msg.id }, peer), 0);
        return;
      }
      commands.push(msg);
    },
    onReply: (h) => { handler = h; },
    peer,
    destroy: vi.fn(),
  };
  const events = { onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onRestart: vi.fn(), onUnattributed: vi.fn() };
  const sb = new OverlaySandbox({ createTransport: () => transport, nonce: () => "nonce-1", now: () => Date.now(), ...events });
  let generation = 0;

  /** The supervisor's fresh worker. */
  const boot = () => {
    const gen = ++generation;
    let frozen = false;
    /** A task of THIS worker: it never runs once the thread is wedged or the
     *  worker was replaced. */
    const task = (fn: () => void) => () => { if (!frozen && gen === generation) fn(); };
    let toWorker: (d: unknown) => void = () => {};
    const hostSide = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (msg: HostMessage) => {
        setTimeout(() => { if (!frozen && gen === generation) toWorker(msg); }, 0);
      },
      start: () => {},
      close: () => {},
    };
    const runtimePort: RuntimePort = {
      post: (msg) => {
        if (frozen || gen !== generation) return;
        setTimeout(() => hostSide.onmessage?.({ data: msg }), 0);
      },
      onMessage: (h) => { toWorker = h; },
    };
    const yieldTask = (fn: () => void) => { setTimeout(task(fn), yieldMs); };
    const owner = createAsyncOwner(runtimePort, "nonce-1", yieldTask);
    const scope: TimerScope & Record<string, unknown> = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(task(fn), ms),
      setInterval: (fn: () => void, ms: number) => setInterval(task(fn), ms),
    };
    installOwnedTimers(scope, owner);
    const apiFor = (id: string): BodyApi => ({
      setTimeout: scope.setTimeout as BodyApi["setTimeout"],
      setInterval: scope.setInterval as BodyApi["setInterval"],
      loadImage: makeRuntimeHelpers(() => ({}), id, owner).loadImage as BodyApi["loadImage"],
      untagged: { setTimeout: (fn, ms) => setTimeout(task(fn), ms) },
    });
    /** id → the body installed, as the real engine keeps it. Marked as the
     *  WORKER realm's: this test runs host and worker in one realm, and a
     *  body's prototype patch must reach only what it would reach live. */
    const installed = new Map<string, string>();
    (installed as unknown as { workerRealm: boolean }).workerRealm = true;
    const engine = {
      load: vi.fn(async (m: LoadMessage) => {
        installed.set(m.id, m.sourceHash);
        loads[m.id]?.(() => { frozen = true; }, () => owner.enter({ id: m.id, sourceHash: m.sourceHash }));
        return { fontFailures: [] };
      }),
      render: vi.fn((m: RenderMessage) => {
        bodies[m.id]?.(() => { frozen = true; }, apiFor(m.id));
        return bitmap();
      }),
      dispose: vi.fn(),
      sourceHashOf: (id: string) => installed.get(id) ?? null,
    };
    attachRuntime(runtimePort, "nonce-1", engine as unknown as LayerEngine, { yieldTask, owner });
    handler?.({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: hostSide }, peer);
  };

  const load = async (ids: string[]) => {
    const done = Promise.all(ids.map((id, i) => sb.load({ id, kind: "code", source: `/*${id}*/`, sourceHash: HASH("abcdef"[i]), width: 10, height: 10 })));
    await vi.advanceTimersByTimeAsync(10);
    await done;
  };
  /** A new source for `id` (the agent rewrote it): a dropped body is retried. */
  const reload = async (id: string, sourceHash: string) => {
    const done = sb.load({ id, kind: "code", source: `/*${id} ${sourceHash}*/`, sourceHash, width: 10, height: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await done;
  };
  /** Ask for a render and let the fake clock deliver whatever answers it. */
  const render = async (id: string, frame = 0) => {
    const req = sb.render({ id, frame, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing });
    await vi.advanceTimersByTimeAsync(10);
    return req;
  };
  const restarts = () => commands.length;
  return { sb, events, boot, load, reload, render, restarts };
}

/** Restarts that drop nobody, in quick succession, that trip the stall
 *  breaker: 1 + ~1 + ~1 reaches STALL_SCORE_LIMIT (2.5); two never can. */
const QUICK_RESTARTS_TO_TRIP = 3;

/** Work nothing announces: the fallback path. */
const wedgedUntaggedAfterMs = (ms: number): Body => (freeze, api) => { api.untagged.setTimeout(freeze, ms); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetImageCachesForTests();
});

describe("the render bracket: a wedge left behind by a body never gets its sibling dropped", () => {
  it("a genuinely wedged body in its OWN render (while(true)) is still dropped by the normal path, at once", async () => {
    const w = liveSandbox({ h: (freeze) => freeze() });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    expect(await w.render("h")).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // h's first render: the load budget
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", LOAD_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onUnattributed).not.toHaveBeenCalled();
    expect(w.restarts()).toBe(1);
  });

  it("Promise.resolve().then(() => { for (;;); }) is blamed on the body at once: the answer waits one task, the microtask runs first", async () => {
    const w = liveSandbox({ h: (freeze) => { void Promise.resolve().then(freeze); } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h");
    expect(w.events.onLayer.mock.calls.map(([m]) => m.id)).toEqual(["s"]); // h's layer never left
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", LOAD_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onError).not.toHaveBeenCalled();
  });

  it("setTimeout(() => { for (;;); }, 0) is blamed on the body at once too: its timer was queued before the runtime's answer", async () => {
    const w = liveSandbox({ h: (freeze, api) => { api.setTimeout(freeze, 0); } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h");
    await w.render("s", 1); // the sibling asks next — it never starts
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", LOAD_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
  });

  it("FALLBACK — work nothing announces fires AFTER the body's answer: the sibling timed next is NOT dropped, and the last-answered suspect is dropped by its second offence", async () => {
    const w = liveSandbox({ h: wedgedUntaggedAfterMs(50) });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h"); // answers; its timer is still pending
    await vi.advanceTimersByTimeAsync(100); // …and fires: the worker is wedged
    await w.render("s", 1); // posted to a wedged worker: never started

    // Offence 1: restart, report, drop no one.
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.restarts()).toBe(1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.events.onError).not.toHaveBeenCalled();
    expect(w.events.onUnattributed).toHaveBeenCalledWith(expect.objectContaining({ t: "unattributed", message: UNSTARTED_WEDGE_MESSAGE }));
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.sb.isDropped("h")).toBe(false);

    // The fresh worker reloads both; the body does it again.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.sb.isLoaded("s") && w.sb.isLoaded("h")).toBe(true);
    await w.render("s");
    await w.render("h");
    await vi.advanceTimersByTimeAsync(100);
    await w.render("s", 1);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // s's first render on this worker

    // Offence 2, same suspect within 60 s: the body is dropped, named alone.
    expect(w.restarts()).toBe(2);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onError).toHaveBeenCalledTimes(1);
    const [diag] = w.events.onError.mock.calls[0];
    expect(diag).toMatchObject({ t: "error", id: "h", phase: "render", message: KEEPS_BLOCKING_MESSAGE });
    expect(diag.req).toBeUndefined(); // it answers no render
    // Its message is a fixed text: it names no overlay, the sibling least of all;
    // and the wedge reports themselves name none either.
    for (const [m] of w.events.onUnattributed.mock.calls) expect(m.message).toBe(UNSTARTED_WEDGE_MESSAGE);

    // The next worker gets the sibling only, and it renders.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.sb.render({ id: "h", frame: 2, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing })).toBe(-1);
    const before = w.events.onLayer.mock.calls.length;
    await w.render("s", 2);
    expect(w.events.onLayer.mock.calls.slice(before).map(([m]) => m.id)).toEqual(["s"]);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
    expect(w.restarts()).toBe(2);
  });

  it("FALLBACK — two unannounced wedges with DIFFERENT suspects drop no one, and neither do two with the same suspect more than 60 s apart", async () => {
    // a wedges after its answer on worker 1, b on worker 2; then a again, late.
    const armed: Record<string, boolean> = { a: true, b: false };
    const arm = (id: string): Body => (freeze, api) => { if (armed[id]) api.untagged.setTimeout(freeze, 50); };
    const w = liveSandbox({ a: arm("a"), b: arm("b") });
    const wedgeRound = async (last: string, first: string) => {
      await w.render(first);
      await w.render(last);
      await vi.advanceTimersByTimeAsync(100);
      await w.render(first, 1);
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    };
    w.boot();
    await w.load(["a", "b"]);
    await wedgeRound("a", "b"); // suspect a
    expect(w.restarts()).toBe(1);
    armed.a = false;
    armed.b = true;
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    await wedgeRound("b", "a"); // suspect b: not a repeat
    expect(w.restarts()).toBe(2);
    // (Spaced one half-life out: a THIRD no-drop restart in quick succession
    // is the endless loop the breaker ends — tested on its own below.)
    await vi.advanceTimersByTimeAsync(STALL_HALF_LIFE_MS);
    armed.a = true;
    armed.b = false;
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    await wedgeRound("a", "b"); // suspect a, but the last suspect was b
    expect(w.restarts()).toBe(3);
    expect(w.sb.isDropped("a") || w.sb.isDropped("b")).toBe(false);

    // Same suspect again, but outside the window.
    await vi.advanceTimersByTimeAsync(REPEAT_WEDGE_WINDOW_MS);
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    await wedgeRound("a", "b");
    expect(w.restarts()).toBe(4);
    expect(w.sb.isDropped("a") || w.sb.isDropped("b")).toBe(false);
    expect(w.events.onError).not.toHaveBeenCalled();
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.events.onUnattributed).toHaveBeenCalledTimes(4);
  });
});

describe("owner tagging (fix round 2): work a body left behind announces itself, and a wedge in it is blamed on that body at once", () => {
  /** Nothing but the hostile body is ever blamed. */
  const onlyBlamed = (w: ReturnType<typeof liveSandbox>, id: string) => {
    for (const [who] of w.events.onTimeout.mock.calls) expect(who).toBe(id);
    for (const [m] of w.events.onError.mock.calls) expect(m.id).toBe(id);
    expect(w.events.onUnattributed).not.toHaveBeenCalled();
  };

  it("a delayed timer that wedges while the sibling's render waits, never started: the owner is dropped at the first offence, the sibling untouched", async () => {
    const w = liveSandbox({ h: (freeze, api) => { api.setTimeout(freeze, 50); } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h"); // answered; its timer is pending
    await vi.advanceTimersByTimeAsync(100); // …fires, announces h, wedges
    await w.render("s", 1); // never starts
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    onlyBlamed(w, "h");
    expect(w.restarts()).toBe(1);

    // The fresh worker gets the sibling only, and it renders.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    const before = w.events.onLayer.mock.calls.length;
    await w.render("s", 2);
    expect(w.events.onLayer.mock.calls.slice(before).map(([m]) => m.id)).toEqual(["s"]);
  });

  it("a delayed timer that falls due INSIDE the sibling's started render, while its answer waits out the yield: the owner is blamed, not the render the host saw start (round 1, concern 1)", async () => {
    const w = liveSandbox({ h: (freeze, api) => { api.setTimeout(freeze, 50); } }, { yieldMs: 5 });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h"); // h's timer is due 50 ms after its render ran
    await vi.advanceTimersByTimeAsync(37); // 47 ms after it
    w.sb.render({ id: "s", frame: 1, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing });
    await vi.advanceTimersByTimeAsync(10); // s starts; h's timer fires inside s's 5 ms yield
    expect(w.events.onLayer.mock.calls.filter(([m]) => m.id === "s")).toHaveLength(1); // s's second answer never left
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 10);
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.sb.isDropped("h")).toBe(true);
    onlyBlamed(w, "h");
  });

  it("setInterval: the tick that wedges is blamed on the body that set the interval", async () => {
    const w = liveSandbox({
      h: (freeze, api) => {
        let n = 0;
        api.setInterval(() => { if (++n === 3) freeze(); }, 40);
      },
    });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h");
    await vi.advanceTimersByTimeAsync(80); // two healthy ticks
    await w.render("s", 1); // answered: the thread is free between ticks
    expect(w.events.onLayer.mock.calls.filter(([m]) => m.id === "s")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50); // the third tick wedges
    await w.render("s", 2);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    onlyBlamed(w, "h");
  });

  it("a loadImage(...).then that never returns is blamed on the body that chained it, though the decode landed in a task of its own", async () => {
    // The decode resolves 50 ms later, in a task nothing tags — a browser's.
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise((res) => { setTimeout(() => res(bitmap()), 50); })));
    const w = liveSandbox({ h: (freeze, api) => { void api.loadImage("data:image/png;base64,AAAA").then(freeze); } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h");
    await vi.advanceTimersByTimeAsync(100);
    await w.render("s", 1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    onlyBlamed(w, "h");
  });

  it("an innocent sibling is never dropped across 5 cycles of a hostile body, whichever way it wedges", async () => {
    type Mode = "timer in the sibling's yield" | "interval" | "loadImage then" | "microtask" | "setTimeout 0";
    const modes: Mode[] = ["timer in the sibling's yield", "interval", "loadImage then", "microtask", "setTimeout 0"];
    let mode: Mode = modes[0]!;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise((res) => { setTimeout(() => res(bitmap()), 50); })));
    const w = liveSandbox(
      {
        h: (freeze, api) => {
          if (mode === "timer in the sibling's yield") api.setTimeout(freeze, 50);
          else if (mode === "interval") { let n = 0; api.setInterval(() => { if (++n === 2) freeze(); }, 30); }
          else if (mode === "loadImage then") void api.loadImage("data:image/png;base64,AAAA").then(freeze);
          else if (mode === "microtask") void Promise.resolve().then(freeze);
          else api.setTimeout(freeze, 0);
        },
      },
      { yieldMs: 5 },
    );
    w.boot();
    await w.load(["s", "h"]);
    for (let cycle = 0; cycle < modes.length; cycle++) {
      mode = modes[cycle]!;
      if (cycle > 0) {
        w.boot(); // the restart the last cycle asked for; replays s only
        await vi.advanceTimersByTimeAsync(10);
        await w.reload("h", HASH("0123456789"[cycle]!)); // the agent rewrote it
      }
      expect(w.sb.isLoaded("s") && w.sb.isLoaded("h")).toBe(true);
      await w.render("s", 10 * cycle);
      await w.render("h", 10 * cycle);
      if (mode === "timer in the sibling's yield") await vi.advanceTimersByTimeAsync(37);
      else await vi.advanceTimersByTimeAsync(100);
      w.sb.render({ id: "s", frame: 10 * cycle + 1, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing });
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 10);

      expect({ cycle, mode, h: w.sb.isDropped("h"), s: w.sb.isDropped("s") }).toEqual({ cycle, mode, h: true, s: false });
      expect(w.restarts()).toBe(cycle + 1);
      onlyBlamed(w, "h");
    }
    expect(w.events.onTimeout).toHaveBeenCalledTimes(modes.length);

    // After all of it, the sibling still paints.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    const before = w.events.onLayer.mock.calls.length;
    await w.render("s", 99);
    expect(w.events.onLayer.mock.calls.slice(before).map(([m]) => m.id)).toEqual(["s"]);
  });
});

describe("fix round 3: the window is charged to the body that scheduled it, with the budget of the phase it runs in", () => {
  it("N3 — a superseded version's leftover timer that wedges after the reload does not get the NEW source dropped", async () => {
    let armed = true;
    const w = liveSandbox({ h: (freeze, api) => { if (armed) { armed = false; api.setTimeout(freeze, 500); } } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h"); // the old body (HASH("b")) leaves a timer due in 500 ms
    await w.reload("h", HASH("9")); // the agent rewrote it; the fixed body is installed
    expect(w.sb.isLoaded("h")).toBe(true);
    await vi.advanceTimersByTimeAsync(600); // the OLD body's timer fires and wedges
    await w.render("s", 1); // never starts
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    // The worker is restarted — it is wedged — but the body that did it is no
    // longer on screen, and the new one did nothing: nobody is dropped.
    expect(w.restarts()).toBe(1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.events.onError).not.toHaveBeenCalled();
    expect(w.sb.isDropped("h")).toBe(false);
    expect(w.sb.isDropped("s")).toBe(false);

    // The fresh worker gets both, and both render.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    const before = w.events.onLayer.mock.calls.length;
    await w.render("h", 2);
    await w.render("s", 2);
    expect(w.events.onLayer.mock.calls.slice(before).map(([m]) => m.id)).toEqual(["h", "s"]);
  });

  it("N3 — the same timer from the CURRENT body is still blamed on it at once", async () => {
    const w = liveSandbox({ h: (freeze, api) => { api.setTimeout(freeze, 500); } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h");
    await vi.advanceTimersByTimeAsync(600);
    await w.render("s", 1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
  });

  it("N4 — a three build that holds the thread while a sibling's render is the head gets the LOAD budget, and is reported as its load", async () => {
    const w = liveSandbox({}, { loads: { t: (freeze, enter) => { enter(); freeze(); } } });
    w.boot();
    await w.load(["s"]);
    await w.render("s"); // warm: s's next render at this size has the 2 s budget
    // The sibling's render is posted first, so it is the head the watchdog
    // times; the three load behind it builds (its factory never returns)
    // before the render's answer can leave.
    w.sb.render({ id: "s", frame: 1, size: { width: 10, height: 10 }, pixelRatio: 1, fps: 30, time: timing });
    const loading = w.sb.load({ id: "t", kind: "three", source: "/*t*/", sourceHash: HASH("7"), width: 10, height: 10 });
    const outcome = loading.then(() => "loaded", (err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 500); // well past a render's 2 s
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.restarts()).toBe(0);

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("t", "load", LOAD_TIMEOUT_MS);
    expect(await outcome).toBe("timed out after 5 s");
    expect(w.sb.isDropped("t")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onUnattributed).not.toHaveBeenCalled();
    expect(w.restarts()).toBe(1);
  });
});

describe("fix round 4 (NEW-1): the host decides what it superseded, and the worker never restarts forever", () => {
  const realGet = Map.prototype.get;
  afterEach(() => {
    Map.prototype.get = realGet;
  });

  it("a body that patches Map.prototype.get to fake a superseded hash is still dropped", async () => {
    const FAKE = HASH("f");
    let patched = false;
    const w = liveSandbox({
      h: (freeze, api) => {
        if (!patched) {
          // Every lookup of the worker's that yields this body's hash now
          // yields FAKE — so its NEXT render, and the timer set in it, are
          // charged to a version the host might take for one it superseded.
          patched = true;
          Map.prototype.get = function (this: Map<unknown, unknown>, k: unknown) {
            const v = realGet.call(this, k);
            return (this as unknown as { workerRealm?: boolean }).workerRealm && v === HASH("b") ? FAKE : v;
          };
          return;
        }
        api.setTimeout(freeze, 500);
      },
    });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h"); // patches
    await w.render("h", 1); // read through the patch; leaves the timer
    await vi.advanceTimersByTimeAsync(600); // the timer fires and wedges
    await w.render("s", 1); // never starts
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    Map.prototype.get = realGet;
    // FAKE was never posted, so nothing superseded it: the window is charged
    // to h's current source, which is dropped at once.
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.restarts()).toBe(1);
  });

  it("an undo re-posts an older version: a window of it is the CURRENT body's again, and is blamed", async () => {
    let armed = true;
    const w = liveSandbox({ h: (freeze, api) => { if (armed) { armed = false; api.setTimeout(freeze, 500); } } });
    w.boot();
    await w.load(["s", "h"]);
    await w.render("s");
    await w.render("h"); // version b leaves a timer
    await w.reload("h", HASH("9")); // superseded…
    await w.reload("h", HASH("b")); // …and back: the agent undid its edit
    await vi.advanceTimersByTimeAsync(600); // b's timer wedges
    await w.render("s", 1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("h", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("h")).toBe(true);
    expect(w.sb.isDropped("s")).toBe(false);
  });

  it("the stall breaker ends an endless-restart loop: wedges whose suspects alternate are stopped, and the preview recovers", async () => {
    // Two bodies take turns wedging the worker through work nothing
    // announces, each right after its own answer — so the fallback suspect
    // alternates and its two-strike rule never fires. Before the breaker this
    // restarted the worker forever, dropping no one.
    const armed: Record<string, boolean> = { a: false, b: false };
    const arm = (id: string): Body => (freeze, api) => { if (armed[id]) api.untagged.setTimeout(freeze, 50); };
    const w = liveSandbox({ a: arm("a"), b: arm("b") });
    w.boot();
    await w.load(["a", "b"]);
    const restartsAt: number[] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      const last = cycle % 2 === 0 ? "a" : "b";
      const first = last === "a" ? "b" : "a";
      armed.a = last === "a";
      armed.b = last === "b";
      const before = w.restarts();
      await w.render(first, cycle * 10);
      await w.render(last, cycle * 10);
      await vi.advanceTimersByTimeAsync(100);
      // Ask both again: whichever is still held is posted to the wedged
      // worker, never starts, and times out.
      await w.render(first, cycle * 10 + 1);
      await w.render(last, cycle * 10 + 1);
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
      if (w.restarts() > before) {
        restartsAt.push(cycle);
        w.boot();
        await vi.advanceTimersByTimeAsync(10);
      }
    }
    // Restarts 1 and 2 drop no one; the third, seconds later, trips the
    // breaker, which drops that wedge's fallback suspect (a). b then wedges
    // alone, and its own second offence is the two-strike rule's. Then it is
    // over.
    expect(restartsAt).toEqual([0, 1, 2, 3, 5]);
    expect(w.sb.isDropped("a")).toBe(true);
    expect(w.sb.isDropped("b")).toBe(true);
    const errors = w.events.onError.mock.calls.map(([m]) => [m.id, m.message]);
    expect(errors).toEqual([
      ["a", PREVIEW_KEPT_STALLING_MESSAGE],
      ["b", KEEPS_BLOCKING_MESSAGE],
    ]);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
  });

  it("with no fallback suspect, the breaker drops the overlay whose window was open at those restarts — not the sibling", async () => {
    // Each version of h leaves a timer that wedges the worker only after the
    // agent has rewritten h: every restart is a superseded body's, which
    // drops no one. Three in quick succession, and h (its current source) is
    // stopped.
    let arm = false;
    let version = 0;
    const w = liveSandbox({ h: (freeze, api) => { if (arm) { arm = false; api.setTimeout(freeze, 500); } } });
    w.boot();
    await w.load(["s", "h"]);
    for (let cycle = 0; cycle < QUICK_RESTARTS_TO_TRIP; cycle++) {
      if (cycle > 0) {
        w.boot();
        await vi.advanceTimersByTimeAsync(10);
      }
      await w.render("s", cycle * 10);
      arm = true;
      await w.render("h", cycle * 10);
      await w.reload("h", HASH("0123456789"[++version]!));
      await vi.advanceTimersByTimeAsync(600); // the superseded body's timer wedges
      await w.render("s", cycle * 10 + 1);
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
      expect(w.restarts()).toBe(cycle + 1);
      expect(w.sb.isDropped("h")).toBe(cycle === QUICK_RESTARTS_TO_TRIP - 1);
    }
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onError.mock.calls.map(([m]) => [m.id, m.message])).toEqual([["h", PREVIEW_KEPT_STALLING_MESSAGE]]);
    expect(w.events.onTimeout).not.toHaveBeenCalled();

    // The next worker gets s only, and it renders; h comes back with its
    // next source.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    const before = w.events.onLayer.mock.calls.length;
    await w.render("s", 99);
    expect(w.events.onLayer.mock.calls.slice(before).map(([m]) => m.id)).toEqual(["s"]);
    await w.reload("h", HASH("e"));
    expect(w.sb.isDropped("h")).toBe(false);
  });

  /** One no-drop restart: a version of h leaves a timer that wedges the
   *  worker after the agent has rewritten h (see the test above). */
  async function supersededStall(w: ReturnType<typeof liveSandbox>, cycle: number, next: () => string, arm: () => void) {
    await w.render("s", cycle * 10);
    arm();
    await w.render("h", cycle * 10);
    await w.reload("h", next());
    await vi.advanceTimersByTimeAsync(600);
    await w.render("s", cycle * 10 + 1);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
  }

  it("M4 — the score decays with a half-life: a restart adds 1, and it halves every STALL_HALF_LIFE_MS", () => {
    expect(STALL_HALF_LIFE_MS).toBe(120_000);
    expect(STALL_SCORE_LIMIT).toBe(2.5);
    expect(decayStallScore(2, 0)).toBe(2);
    expect(decayStallScore(2, STALL_HALF_LIFE_MS)).toBeCloseTo(1, 10);
    expect(decayStallScore(3, 2 * STALL_HALF_LIFE_MS)).toBeCloseTo(0.75, 10);
    // Two restarts can never trip it, however close: 1 + (at most) 1 < 2.5.
    expect(1 + decayStallScore(1, 0)).toBeLessThan(STALL_SCORE_LIMIT);
    // A steady loop with period P settles at 1 / (1 - 2^(-P/H)): it trips for
    // every P up to H * log2(1 / (1 - 1/2.5)) ≈ 0.737 H — 88 s at H = 120 s.
    const ceiling = STALL_HALF_LIFE_MS * Math.log2(1 / (1 - 1 / STALL_SCORE_LIMIT));
    expect(Math.round(ceiling / 1000)).toBe(88);
  });

  it("M4 — a slow periodic loop, one restart every ~80 s (far outside the old 30 s window), trips the breaker eventually", async () => {
    let armed = false;
    let version = 0;
    const w = liveSandbox({ h: (freeze, api) => { if (armed) { armed = false; api.setTimeout(freeze, 500); } } });
    w.boot();
    await w.load(["s", "h"]);
    const restartTimes: number[] = [];
    let droppedAt = -1;
    for (let cycle = 0; cycle < 20 && droppedAt < 0; cycle++) {
      if (cycle > 0) {
        await vi.advanceTimersByTimeAsync(75_000);
        w.boot();
        await vi.advanceTimersByTimeAsync(10);
      }
      await supersededStall(w, cycle, () => HASH("0123456789abcdef"[++version % 16]!), () => { armed = true; });
      expect(w.restarts()).toBe(cycle + 1);
      restartTimes.push(Date.now());
      if (w.sb.isDropped("h")) droppedAt = cycle;
    }
    // The cycle the score model says trips it, from the restarts' real times.
    let score = 0;
    let expected = -1;
    for (let i = 0; i < restartTimes.length && expected < 0; i++) {
      score = (i === 0 ? 0 : decayStallScore(score, restartTimes[i]! - restartTimes[i - 1]!)) + 1;
      if (score >= STALL_SCORE_LIMIT) expected = i;
    }
    expect(expected).toBeGreaterThan(2); // not a quick-succession trip
    expect(droppedAt).toBe(expected);
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onError.mock.calls.map(([m]) => [m.id, m.message])).toEqual([["h", PREVIEW_KEPT_STALLING_MESSAGE]]);
  });

  it("M4 — isolated no-drop restarts far apart never trip it", async () => {
    let armed = false;
    let version = 0;
    const w = liveSandbox({ h: (freeze, api) => { if (armed) { armed = false; api.setTimeout(freeze, 500); } } });
    w.boot();
    await w.load(["s", "h"]);
    for (let cycle = 0; cycle < 8; cycle++) {
      if (cycle > 0) {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        w.boot();
        await vi.advanceTimersByTimeAsync(10);
      }
      await supersededStall(w, cycle, () => HASH("0123456789"[++version % 10]!), () => { armed = true; });
    }
    expect(w.restarts()).toBe(8);
    expect(w.sb.isDropped("h") || w.sb.isDropped("s")).toBe(false);
    expect(w.events.onError).not.toHaveBeenCalled();
  });

});

describe("Task 13 re-review 3, M1: a stall whose holder the host KNOWS is gone is not evidence against the sibling it was timing", () => {
  it("three removed overlays wedge the worker in turn: the breaker trips, and drops nothing on screen", async () => {
    let armed = false;
    const leaves: Body = (freeze, api) => { if (armed) { armed = false; api.setTimeout(freeze, 500); } };
    const w = liveSandbox({ r0: leaves, r1: leaves, r2: leaves });
    w.boot();
    await w.load(["s"]);
    for (let cycle = 0; cycle < QUICK_RESTARTS_TO_TRIP; cycle++) {
      if (cycle > 0) {
        w.boot();
        await vi.advanceTimersByTimeAsync(10);
      }
      const id = `r${cycle}`;
      await w.reload(id, HASH(String(cycle + 1)));
      await w.render("s", cycle * 10);
      armed = true;
      await w.render(id, cycle * 10); // leaves a timer…
      w.sb.dispose(id); // …and the agent removes the overlay before it fires
      await vi.advanceTimersByTimeAsync(600); // the removed body's timer wedges
      await w.render("s", cycle * 10 + 1); // s is the head the watchdog times
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
      expect(w.restarts()).toBe(cycle + 1);
    }
    // The host knew every time who held the thread — a removed overlay — so s,
    // whose render merely waited behind it, is not the likeliest cause.
    expect(w.sb.isDropped("s")).toBe(false);
    expect(w.events.onError).not.toHaveBeenCalled();
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.events.onUnattributed).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: PREVIEW_KEPT_STALLING_UNNAMED_MESSAGE }),
    );
  });
});
