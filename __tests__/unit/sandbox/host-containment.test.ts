/**
 * The final security review's containment findings, host side (I1, I2, I3):
 * every availability bound the sandbox relies on is enforced where the realm
 * is trusted — the studio's main thread — not in the worker a body shares.
 *  - I1: a port's message budget. A worker that floods the host (its own
 *    limiter defeated by a patched intrinsic, or an async-window storm that
 *    needs no patch at all) is restarted as a wedge, and what it sent past
 *    the budget is never even deserialized.
 *  - I2: a layer bitmap bigger than the host asked for is closed on arrival
 *    and reported, never composited or held — and its body is dropped after
 *    that one frame (R-M3); the worker refuses to transfer one at all.
 *  - I3: a supervisor frame that sends no `ready` and answers no `ping` is
 *    dead, and is replaced — a bounded number of times.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FRAME_BOOT_TIMEOUT_MS,
  FRAME_DIED_MESSAGE,
  FRAME_LOAD_TIMEOUT_MS,
  FRAME_LOST_MESSAGE,
  FRAME_STARTING_MESSAGE,
  FRAME_STARTING_NOTICE_MS,
  FRAME_REMOUNT_WINDOW_MS,
  MAX_FRAME_REMOUNTS,
  MAX_PORT_MESSAGE_CHARS,
  OverlaySandbox,
  PING_TIMEOUT_MS,
  PORT_ASYNC_SWITCHES_PER_SECOND,
  PORT_DIAGNOSTICS_FORWARDED_PER_SECOND,
  PORT_DIAGNOSTICS_PER_SECOND,
  PORT_MESSAGES_PER_SECOND,
  RENDER_TIMEOUT_MS,
  RESTART_READY_TIMEOUT_MS,
  expectedLayerSize,
  frameDiedMessage,
  workerNotRestartedMessage,
  type SandboxTransport,
} from "@/lib/sandbox/host";
import { ASYNC_REPORT_INTERVAL_MS, attachGlobalDiagnostics, errorMessage, type RuntimePort } from "@/lib/sandbox/runtime/serve";
import { OversizedLayerError } from "@/lib/sandbox/runtime/compile";
import { LayerEngine } from "@/lib/sandbox/runtime/layers";
import {
  DEFAULT_RESTART_WAIT_MS,
  EXPORT_SANDBOX_OPTIONS,
  ExportLayerSource,
  NOT_LOADED_MESSAGE,
  RESTARTED_MESSAGE,
} from "@/lib/sandbox/export-layers";
import { PROTOCOL_VERSION, type HostMessage, type RuntimeMessage, type SupervisorCommand } from "@/lib/sandbox/protocol";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NONCE = "nonce-1";
const timing = { frame: 0, time: 0, totalFrames: 30, duration: 1, progress: 0 };
const bitmap = (w = 2, h = w) => ({ width: w, height: h, close: vi.fn() });

/** A port whose incoming events count how often the host READ `data` —
 *  Chromium deserializes a port message on that read. */
function fakePort() {
  const posted: HostMessage[] = [];
  let closed = false;
  let reads = 0;
  const port = {
    postMessage: (msg: HostMessage) => {
      posted.push(msg);
    },
    start: vi.fn(),
    close: () => {
      closed = true;
    },
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onmessageerror: null as (() => void) | null,
  };
  return {
    port: port as unknown as MessagePort,
    posted,
    /** Deliver as the browser would: `data` is read lazily. */
    deliver(data: unknown) {
      port.onmessage?.({
        get data() {
          reads++;
          return data;
        },
      });
    },
    closed: () => closed,
    reads: () => reads,
  };
}

/** One supervisor frame per `createTransport` call; the test plays each. */
interface Frame {
  commands: SupervisorCommand[];
  reply(data: unknown): void;
  destroyed: () => boolean;
}
function sandbox(extra: Partial<ConstructorParameters<typeof OverlaySandbox>[0]> = {}) {
  const frames: Frame[] = [];
  const events = {
    onLayer: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
    onRestart: vi.fn(),
    onUnattributed: vi.fn(),
    onFrameLost: vi.fn(),
  };
  const sb = new OverlaySandbox({
    createTransport: (): SandboxTransport => {
      let handler: ((d: unknown, s: unknown) => void) | null = null;
      let destroyed = false;
      const peer = { frame: frames.length };
      const frame: Frame = {
        commands: [],
        reply: (data) => handler?.(data, peer),
        destroyed: () => destroyed,
      };
      frames.push(frame);
      return {
        command: (msg) => frame.commands.push(msg),
        onReply: (h) => {
          handler = h;
        },
        peer,
        destroy: () => {
          destroyed = true;
        },
      };
    },
    nonce: () => NONCE,
    cloneBitmap: async (b) => b,
    ...events,
    ...extra,
  });
  const frame = () => frames[frames.length - 1]!;
  const ready = (f = frame()) => {
    const p = fakePort();
    f.reply({ t: "ready", nonce: NONCE, version: PROTOCOL_VERSION, port: p.port });
    return p;
  };
  const restarts = () => frames.flatMap((f) => f.commands).filter((c) => c.t === "restart").length;
  return { sb, frames, frame, ready, events, restarts };
}

const loadInput = (id = "o1", sourceHash = HASH_A, kind: "code" | "three" | "tracked" = "code") => ({
  id,
  kind,
  source: `/* ${id} */`,
  sourceHash,
  width: 100,
  height: 50,
  ...(kind === "three" ? { three: { cameraPreset: "billboard" as const, pixelRatio: 1 as const } } : {}),
});
const renderInput = (id = "o1", extra: Record<string, unknown> = {}) => ({
  id,
  frame: 0,
  size: { width: 100, height: 50 },
  pixelRatio: 1,
  fps: 30,
  time: timing,
  ...extra,
});

async function loaded(s: ReturnType<typeof sandbox>, ids: Array<[string, string, ("code" | "three" | "tracked")?]>) {
  const p = s.ready();
  const done = ids.map(([id, hash, kind]) => s.sb.load(loadInput(id, hash, kind)));
  await vi.advanceTimersByTimeAsync(0);
  for (const [id, hash] of ids) p.deliver({ t: "loaded", nonce: NONCE, id, sourceHash: hash });
  await Promise.all(done);
  return p;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ── I1 ──────────────────────────────────────────────────────────────────────

describe("I1 — the host is the rate limiter", () => {
  it("a body that patches performance.now and Map.prototype.get/set, then floods, is contained — by the worker's captured primitives AND by the host", async () => {
    // Worker side: the diagnostics limiter reads a clock and a Map. Both were
    // looked up live, so a body that made the clock jump 5 s per call and the
    // Map forget opened the limiter for every uncaught error it could raise.
    const posted: RuntimeMessage[] = [];
    const port: RuntimePort = { post: (m) => posted.push(m), onMessage: () => {} };
    // A plain record: the test's own lookups must not go through the Map
    // operations the "body" patches below.
    const handlers: Record<string, (ev: unknown) => void> = {};
    attachGlobalDiagnostics(
      { addEventListener: (t: string, h: (ev: never) => void) => void (handlers[t] = h as (ev: unknown) => void) },
      port,
      NONCE,
      2,
    );
    const originalProtoNow = Performance.prototype.now;
    const ownNow = Object.getOwnPropertyDescriptor(performance, "now");
    const originalGet = Map.prototype.get;
    const originalSet = Map.prototype.set;
    let t = 0;
    const jump = () => (t += 5000);
    const fire = handlers.error!;
    const events = Array.from({ length: 10_000 }, (_, i) =>
      Object.defineProperty(Object.assign(new Event("error", { cancelable: true }), { error: new Error(`x${i}`) }), "isTrusted", {
        value: true,
      }),
    );
    try {
      Performance.prototype.now = jump;
      Object.defineProperty(performance, "now", { value: jump, configurable: true, writable: true });
      Map.prototype.get = function () {
        return undefined;
      };
      Map.prototype.set = function (this: Map<unknown, unknown>) {
        return this;
      };
      for (let i = 0; i < events.length; i++) fire(events[i]);
    } finally {
      Performance.prototype.now = originalProtoNow;
      if (ownNow) Object.defineProperty(performance, "now", ownNow);
      else delete (performance as unknown as { now?: unknown }).now;
      Map.prototype.get = originalGet;
      Map.prototype.set = originalSet;
    }
    // One report for the burst: the limiter ran on the captured clock and Map
    // (it keeps the rest back for the next slot, as it always did).
    expect(posted.length).toBeLessThanOrEqual(1);
    expect(ASYNC_REPORT_INTERVAL_MS).toBeGreaterThan(0);

    // Host side: a worker whose limiter was defeated anyway (the realm is the
    // body's) posts 50,000 unique unattributed reports. At most the forwarded
    // budget reaches the store; past the flood budget the port is closed, the
    // worker restarted, and nothing more is even deserialized.
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    const readsBefore = p.reads();
    for (let i = 0; i < 50_000; i++) p.deliver({ t: "unattributed", nonce: NONCE, message: `x${i} ${"…".repeat(1900)}` });
    const reports = s.events.onUnattributed.mock.calls.map((c) => (c[0] as { message: string }).message);
    const forwarded = reports.filter((m) => m.startsWith("x"));
    expect(forwarded).toHaveLength(PORT_DIAGNOSTICS_FORWARDED_PER_SECOND);
    expect(p.closed()).toBe(true);
    expect(p.reads() - readsBefore).toBe(PORT_DIAGNOSTICS_PER_SECOND + 1);
    expect(s.restarts()).toBe(1);
    // Nothing held the thread, so it is the unannounced-wedge path: reported
    // unattributed, and on a first offence nobody is dropped.
    expect(reports.at(-1)).toMatch(/flooded the overlay runtime's channel/);
    expect(s.sb.isDropped("o1")).toBe(false);
    s.sb.destroy();
  });

  it("a flood while a body holds the thread (its render started, not answered) drops THAT body, and says it flooded — not that it timed out", async () => {
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A], ["o2", HASH_B]]);
    const req = s.sb.render(renderInput("o1"));
    p.deliver({ t: "started", nonce: NONCE, id: "o1", req });
    const readsBefore = p.reads();
    for (let i = 0; i < PORT_MESSAGES_PER_SECOND + 5_000; i++) p.deliver({ t: "error", nonce: NONCE, id: "o2", phase: "render", message: `x${i}` });
    expect(p.closed()).toBe(true);
    expect(s.sb.isDropped("o1")).toBe(true);
    expect(s.sb.isDropped("o2")).toBe(false);
    expect(s.events.onTimeout).toHaveBeenCalledWith("o1", "render", expect.any(Number), expect.stringMatching(/flooded the overlay runtime's channel to the studio \(201 diagnostics in one second\)/));
    expect(p.reads() - readsBefore).toBe(PORT_DIAGNOSTICS_PER_SECOND + 1);
    expect(s.restarts()).toBe(1);
    s.sb.destroy();
  });

  it("an async/asyncDone storm (Scenario B: no patch needed) is contained — the first restarts and drops no one, the same suspect again within 60 s is dropped", async () => {
    const s = sandbox();
    let p = await loaded(s, [["o1", HASH_A], ["o2", HASH_B]]);
    const storm = (port: ReturnType<typeof fakePort>) => {
      const before = port.reads();
      for (let i = 0; i < 100_000; i++) {
        port.deliver(i % 2 === 0 ? { t: "async", nonce: NONCE, id: "o1", sourceHash: HASH_A } : { t: "asyncDone", nonce: NONCE, id: "o1" });
      }
      return port.reads() - before;
    };
    expect(storm(p)).toBe(PORT_ASYNC_SWITCHES_PER_SECOND + 1);
    expect(p.closed()).toBe(true);
    expect(s.restarts()).toBe(1);
    expect(s.sb.isDropped("o1")).toBe(false);
    expect(s.events.onUnattributed).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/async window switches/) }),
    );

    // The fresh worker replays both; the body storms again inside 60 s.
    await vi.advanceTimersByTimeAsync(1000);
    p = s.ready();
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    p.deliver({ t: "loaded", nonce: NONCE, id: "o2", sourceHash: HASH_B });
    storm(p);
    expect(s.restarts()).toBe(2);
    expect(s.sb.isDropped("o1")).toBe(true);
    expect(s.sb.isDropped("o2")).toBe(false);
    expect(s.events.onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "o1", phase: "render", message: expect.stringMatching(/flooded/) }),
    );
    s.sb.destroy();
  });

  it("legit traffic well inside the budget is untouched, and the window rolls over every second", async () => {
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    for (let second = 0; second < 3; second++) {
      for (let i = 0; i < PORT_ASYNC_SWITCHES_PER_SECOND / 2; i++) {
        p.deliver(i % 2 === 0 ? { t: "async", nonce: NONCE, id: "o1", sourceHash: HASH_A } : { t: "asyncDone", nonce: NONCE, id: "o1" });
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(p.closed()).toBe(false);
    expect(s.restarts()).toBe(0);
    s.sb.destroy();
  });

  it("a message whose text is past the per-message cap is dropped unparsed (a patched String.prototype.slice defeats the worker's own truncation)", async () => {
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    p.deliver({ t: "unattributed", nonce: NONCE, message: "y".repeat(MAX_PORT_MESSAGE_CHARS + 1) });
    expect(s.events.onUnattributed).not.toHaveBeenCalled();
    p.deliver({ t: "unattributed", nonce: NONCE, message: "fine" });
    expect(s.events.onUnattributed).toHaveBeenCalledTimes(1);
    s.sb.destroy();
  });
});

// ── I2 ──────────────────────────────────────────────────────────────────────

/** A worker-shaped 2D canvas: what `LayerEngine` allocates, with the transfer
 *  counted — the worker must not hand an oversized layer over at all. */
function workerCanvases() {
  const transfers: Array<{ width: number; height: number }> = [];
  const makeCanvas = (w: number, h: number) => {
    const canvas = {
      width: w,
      height: h,
      getContext: () => ctx,
      transferToImageBitmap: () => {
        transfers.push({ width: canvas.width, height: canvas.height });
        return bitmap(canvas.width, canvas.height);
      },
    };
    const ctx = {
      canvas,
      save() {},
      restore() {},
      setTransform() {},
      clearRect() {},
      translate() {},
      scale() {},
      fillRect() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
    return canvas as unknown as OffscreenCanvas;
  };
  return { makeCanvas, transfers };
}

describe("I2 — a layer is held to the size the host asked for", () => {
  it("expectedLayerSize is the worker's allocation rule: box plus pad for 2D, box alone for three, ceiled, at least 1", () => {
    const g = { size: { width: 100.2, height: 50 }, pixelRatio: 2, pad: { left: 10, top: 5, right: 10, bottom: 5 } };
    expect(expectedLayerSize("tracked", g)).toEqual({ width: 241, height: 120 });
    expect(expectedLayerSize("code", { ...g, pad: undefined })).toEqual({ width: 201, height: 100 });
    expect(expectedLayerSize("three", g)).toEqual({ width: 201, height: 100 });
    expect(expectedLayerSize("code", { size: { width: 0.1, height: 0.1 }, pixelRatio: 1 })).toEqual({ width: 1, height: 1 });
  });

  it("R-M3: a body that resizes ctx.canvas is refused in the worker (nothing transferred), dropped by the host after that one frame, and never asked again", async () => {
    // The worker half, for real: the body reaches its layer through
    // `ctx.canvas` and makes it 16384 px square — 1 GiB of RGBA a frame.
    const { makeCanvas, transfers } = workerCanvases();
    const engine = new LayerEngine({ makeCanvas, now: () => 0, wrapperLineOffset: 2, measureContentBox: () => null });
    await engine.load({
      t: "load",
      id: "o1",
      kind: "code",
      source: "context.ctx.canvas.width = 16384; context.ctx.canvas.height = 16384; context.ctx.fillRect(0, 0, 1, 1);",
      sourceHash: HASH_A,
      width: 100,
      height: 50,
    });

    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    const input = renderInput("o1");
    const req = s.sb.render(input);
    let thrown: unknown;
    try {
      engine.render({ t: "render", req, ...input });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OversizedLayerError);
    expect(transfers).toEqual([]); // the gigabyte never left the worker
    const answer = errorMessage(NONCE, "o1", thrown, { req });
    expect(answer.layerSize).toEqual({ width: 16384, height: 16384 });
    p.deliver(answer);

    expect(s.events.onLayer).not.toHaveBeenCalled();
    expect(s.events.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "o1", phase: "render", req, message: expect.stringMatching(/resized its canvas: .*16384×16384.*100×50.*stopped until its source changes/) }),
    );
    expect(s.sb.isInFlight("o1")).toBe(false);
    // Dropped for its current source, as the watchdog drops one: the worker is
    // told to let it go (freeing the canvas it grew), and nothing restarts.
    expect(s.sb.isDropped("o1")).toBe(true);
    expect(p.posted.filter((m) => m.t === "dispose")).toEqual([{ t: "dispose", id: "o1" }]);
    // It does not re-send: every later frame asks nothing of the worker.
    for (let frame = 1; frame <= 5; frame++) expect(s.sb.render(renderInput("o1", { frame }))).toBe(-1);
    expect(p.posted.filter((m) => m.t === "render")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS * 3);
    expect(s.events.onTimeout).not.toHaveBeenCalled();
    expect(s.restarts()).toBe(0);
    // A new source is retried, as after any drop.
    const next = s.sb.load(loadInput("o1", HASH_B));
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_B });
    await next;
    expect(s.sb.isDropped("o1")).toBe(false);
    expect(s.sb.render(renderInput("o1", { frame: 6 }))).toBeGreaterThan(req);
    s.sb.destroy();
  });

  it("the host check stays authoritative: an oversized bitmap that crossed anyway is closed, never composited, and its body dropped after that one frame", async () => {
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    const req = s.sb.render(renderInput("o1"));
    const huge = bitmap(16384, 16384);
    p.deliver({ t: "layer", nonce: NONCE, id: "o1", frame: 0, req, bitmap: huge });
    expect(huge.close).toHaveBeenCalledTimes(1);
    expect(s.events.onLayer).not.toHaveBeenCalled();
    expect(s.events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o1", phase: "render", req, message: expect.stringMatching(/16384×16384.*100×50/) }),
    );
    expect(s.sb.isDropped("o1")).toBe(true);
    expect(s.sb.render(renderInput("o1", { frame: 1 }))).toBe(-1);
    expect(p.posted.filter((m) => m.t === "render")).toHaveLength(1);
    expect(s.restarts()).toBe(0);
    s.sb.destroy();
  });

  it("the worker's measurement is held to the host's own expectation: a claim within the asked size drops nothing", async () => {
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    const req = s.sb.render(renderInput("o1"));
    p.deliver({ t: "error", nonce: NONCE, id: "o1", phase: "render", message: "claimed", req, layerSize: { width: 100, height: 50 } });
    expect(s.events.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "claimed", req }));
    expect(s.sb.isDropped("o1")).toBe(false);
    expect(s.sb.render(renderInput("o1", { frame: 1 }))).toBeGreaterThan(req);
    s.sb.destroy();
  });

  it("an oversized answer from a body the host has since replaced is reported, and the new source is not dropped", async () => {
    const s = sandbox();
    const p = await loaded(s, [["o1", HASH_A]]);
    const req = s.sb.render(renderInput("o1"));
    void s.sb.load(loadInput("o1", HASH_B)).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const huge = bitmap(4096, 4096);
    p.deliver({ t: "layer", nonce: NONCE, id: "o1", frame: 0, req, bitmap: huge });
    expect(huge.close).toHaveBeenCalled();
    expect(s.events.onError).toHaveBeenCalledWith(expect.objectContaining({ id: "o1", req }));
    expect(s.sb.isDropped("o1")).toBe(false);
    expect(p.posted.filter((m) => m.t === "dispose")).toEqual([]);
    s.sb.destroy();
  });

  it("the same guard holds for a three body's canvas, and a layer exactly the asked size (or a pixel over, from ceiling) passes", async () => {
    const s = sandbox();
    const p = await loaded(s, [["t1", HASH_A, "three"], ["t2", HASH_A, "three"], ["k1", HASH_B, "tracked"]]);
    // A three body that resized its renderer's canvas after setSize.
    const threeReq = s.sb.render(renderInput("t1", { pixelRatio: 2 }));
    const big = bitmap(4096, 4096);
    p.deliver({ t: "layer", nonce: NONCE, id: "t1", frame: 0, req: threeReq, bitmap: big });
    expect(big.close).toHaveBeenCalled();
    expect(s.events.onError).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", req: threeReq, message: expect.stringMatching(/200×100 was asked for/) }));
    expect(s.sb.isDropped("t1")).toBe(true);
    // A three layer at the asked size (+1 px of ceiling) is a layer.
    const ok = s.sb.render(renderInput("t2", { pixelRatio: 2 }));
    const fine = bitmap(201, 101);
    p.deliver({ t: "layer", nonce: NONCE, id: "t2", frame: 0, req: ok, bitmap: fine });
    expect(fine.close).not.toHaveBeenCalled();
    expect(s.events.onLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "t2", req: ok }));
    // A tracked layer covers its pad: 100 + 2 × 50 by 50 + 2 × 25.
    const pad = { left: 50, top: 25, right: 50, bottom: 25 };
    const tracked = s.sb.render(renderInput("k1", { pad }));
    const padded = bitmap(200, 100);
    p.deliver({ t: "layer", nonce: NONCE, id: "k1", frame: 0, req: tracked, bitmap: padded });
    expect(padded.close).not.toHaveBeenCalled();
    expect(s.events.onLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "k1", req: tracked }));
    expect(s.sb.isDropped("k1")).toBe(false);
    s.sb.destroy();
  });
});

// ── I3 ──────────────────────────────────────────────────────────────────────

const pings = (f: Frame) => f.commands.filter((c): c is Extract<SupervisorCommand, { t: "ping" }> => c.t === "ping");
/** A frame dies, as the host sees it: a ping, then the confirming ping, both
 *  unanswered (R-M5). */
const DEATH_MS = 2 * PING_TIMEOUT_MS;

describe("I3 — a dead supervisor frame is replaced", () => {
  it("a frame that never sends ready is pinged, the silence confirmed, and it is torn down and a fresh one mounted — whose ready replays the cached sources", async () => {
    const s = sandbox();
    const load = s.sb.load(loadInput("o1", HASH_A));
    const first = s.frame();
    await vi.advanceTimersByTimeAsync(FRAME_BOOT_TIMEOUT_MS - 1);
    expect(first.commands).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.commands).toEqual([{ t: "ping", nonce: NONCE, id: 1 }]);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    // One miss is not death: the host confirms before it tears anything down.
    expect(first.destroyed()).toBe(false);
    expect(first.commands).toEqual([{ t: "ping", nonce: NONCE, id: 1 }, { t: "ping", nonce: NONCE, id: 2 }]);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(first.destroyed()).toBe(true);
    expect(s.frames).toHaveLength(2);

    // A late word from the dead frame is not trusted.
    first.reply({ t: "ready", nonce: NONCE, version: PROTOCOL_VERSION, port: fakePort().port });
    expect(s.sb.generation()).toBe(0);

    const p = s.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.posted.filter((m) => m.t === "load").map((m) => (m as { id: string }).id)).toEqual(["o1"]);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    await load;
    expect(s.sb.isLoaded("o1")).toBe(true);
    s.sb.destroy();
  });

  it("a frame that dies after a watchdog restart (no ready, no pong) is replaced, and the fresh worker gets every body but the one that was dropped", async () => {
    const s = sandbox();
    const p1 = await loaded(s, [["o1", HASH_A], ["o2", HASH_B]]);
    // o1's body OOMs its worker — and with it the frame's renderer process.
    const req = s.sb.render(renderInput("o1"));
    p1.deliver({ t: "started", nonce: NONCE, id: "o1", req });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.sb.isDropped("o1")).toBe(true);
    expect(s.restarts()).toBe(1);
    const dead = s.frame();
    await vi.advanceTimersByTimeAsync(RESTART_READY_TIMEOUT_MS);
    expect(dead.commands.at(-1)).toMatchObject({ t: "ping", nonce: NONCE });
    await vi.advanceTimersByTimeAsync(DEATH_MS);
    expect(dead.destroyed()).toBe(true);
    const p2 = s.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(p2.posted.filter((m) => m.t === "load").map((m) => (m as { id: string }).id)).toEqual(["o2"]);
    expect(s.events.onRestart).toHaveBeenCalledTimes(1);
    s.sb.destroy();
  });

  it("a frame that is slow but alive (it answers the ping) is NOT replaced", async () => {
    const s = sandbox();
    const f = s.frame();
    await vi.advanceTimersByTimeAsync(FRAME_BOOT_TIMEOUT_MS);
    expect(pings(f)).toHaveLength(1);
    f.reply({ t: "pong", nonce: NONCE, id: pings(f)[0]!.id });
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS * 2);
    expect(f.destroyed()).toBe(false);
    expect(s.frames).toHaveLength(1);
    s.ready(f);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.frames).toHaveLength(1);
    s.sb.destroy();
  });

  it("ping() has a deadline: an unanswered ping resolves -1, and once a confirming ping also goes unanswered the frame is replaced", async () => {
    const s = sandbox();
    s.ready();
    const first = s.frame();
    const ping = s.sb.ping();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(ping).resolves.toBe(-1);
    expect(first.destroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect(first.destroyed()).toBe(true);
    expect(s.frames).toHaveLength(2);
    // The new frame answers pings as usual.
    s.ready();
    const again = s.sb.ping();
    s.frame().reply({ t: "pong", nonce: NONCE, id: pings(s.frame()).at(-1)!.id });
    await expect(again).resolves.toBeGreaterThanOrEqual(0);
    s.sb.destroy();
  });

  it(`remounts are bounded: after ${MAX_FRAME_REMOUNTS} inside the window the next death is final, and the host says so exactly once — with the count that happened`, async () => {
    const s = sandbox();
    void s.sb.load(loadInput("o1", HASH_A)).catch(() => {});
    for (let i = 0; i < MAX_FRAME_REMOUNTS; i++) {
      await vi.advanceTimersByTimeAsync(FRAME_BOOT_TIMEOUT_MS + DEATH_MS);
      expect(s.frames).toHaveLength(i + 2);
    }
    expect(s.events.onFrameLost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FRAME_BOOT_TIMEOUT_MS + DEATH_MS);
    // MAX_FRAME_REMOUNTS + 1 frames died; the message says exactly that.
    expect(s.frames).toHaveLength(MAX_FRAME_REMOUNTS + 1);
    expect(s.frames.every((f) => f.destroyed())).toBe(true);
    expect(FRAME_LOST_MESSAGE).toContain(`${MAX_FRAME_REMOUNTS + 1} times within 5 minutes`);
    expect(FRAME_LOST_MESSAGE).toContain(`the first ${MAX_FRAME_REMOUNTS}`);
    expect(s.sb.isFrameLost()).toBe(true);
    expect(s.events.onFrameLost).toHaveBeenCalledExactlyOnceWith(FRAME_LOST_MESSAGE);
    expect(s.events.onUnattributed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: FRAME_LOST_MESSAGE }));
    // It stays stopped: no more frames, no renders, pings answer -1 at once.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.frames).toHaveLength(MAX_FRAME_REMOUNTS + 1);
    expect(s.sb.render(renderInput("o1"))).toBe(-1);
    await expect(s.sb.ping()).resolves.toBe(-1);
    s.sb.destroy();
  });

  it("the export fails loudly when the frame is lost — it never finishes with every body overlay silently missing", async () => {
    const post = vi.fn(() => 1);
    const src = new ExportLayerSource(post);
    const frameRequest = {
      overlayId: "o1",
      kind: "code" as const,
      frame: 3,
      size: { width: 10, height: 10 },
      pixelRatio: 1,
      fps: 30,
      time: timing,
    };
    const settling = src.settle([frameRequest], { frame: 3, time: 0.1 });
    src.onFrameLost(FRAME_LOST_MESSAGE);
    await expect(settling).rejects.toThrow(FRAME_LOST_MESSAGE);
    await expect(src.settle([frameRequest], { frame: 4, time: 0.13 })).rejects.toThrow(FRAME_LOST_MESSAGE);
    src.dispose();
  });
});

// ── R-M4: a frame still loading is not a dead one ──────────────────────────

function iframeLikeSandbox(extra: Partial<ConstructorParameters<typeof OverlaySandbox>[0]> = {}) {
  const frames: Array<Frame & { load(): void }> = [];
  const events = {
    onLayer: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
    onRestart: vi.fn(),
    onUnattributed: vi.fn(),
    onFrameLost: vi.fn(),
  };
  const sb = new OverlaySandbox({
    createTransport: (): SandboxTransport => {
      let handler: ((d: unknown, s: unknown) => void) | null = null;
      let onLoad: (() => void) | null = null;
      let destroyed = false;
      const peer = { frame: frames.length };
      const frame = {
        commands: [] as SupervisorCommand[],
        reply: (data: unknown) => handler?.(data, peer),
        destroyed: () => destroyed,
        load: () => onLoad?.(),
      };
      frames.push(frame);
      return {
        // A document still loading hears nothing: its script has not run.
        command: (msg) => frame.commands.push(msg),
        onReply: (h) => {
          handler = h;
        },
        onLoad: (h) => {
          onLoad = h;
        },
        peer,
        destroy: () => {
          destroyed = true;
        },
      };
    },
    nonce: () => NONCE,
    cloneBitmap: async (b) => b,
    ...events,
    ...extra,
  });
  const frame = () => frames[frames.length - 1]!;
  const ready = (f = frame()) => {
    const p = fakePort();
    f.reply({ t: "ready", nonce: NONCE, version: PROTOCOL_VERSION, port: p.port });
    return p;
  };
  return { sb, frames, frame, ready, events };
}

describe("R-M4 — at boot, still loading is told apart from dead", () => {
  it("a slow cold compile is neither probed nor remounted while the frame is loading, and spends nothing of the remount bound", async () => {
    const s = iframeLikeSandbox();
    const load = s.sb.load(loadInput("o1", HASH_A));
    // 50 s of cold `next dev` compile plus esbuild: far past the old 17 s.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(s.frames).toHaveLength(1);
    expect(s.frame().commands).toEqual([]);
    // The document loads; its supervisor says ready from the same script.
    s.frame().load();
    const p = s.ready();
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    await load;
    expect(s.sb.isLoaded("o1")).toBe(true);
    await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS * 2);
    expect(s.frames).toHaveLength(1);
    // The bound is whole: every one of the next MAX_FRAME_REMOUNTS deaths —
    // each followed by another slow boot — is still remounted.
    for (let i = 0; i < MAX_FRAME_REMOUNTS; i++) {
      void s.sb.ping();
      await vi.advanceTimersByTimeAsync(DEATH_MS);
      expect(s.frames).toHaveLength(i + 2);
      await vi.advanceTimersByTimeAsync(40_000);
      s.frame().load();
      s.ready();
    }
    expect(s.sb.isFrameLost()).toBe(false);
    expect(s.events.onFrameLost).not.toHaveBeenCalled();
    s.sb.destroy();
  });

  it("a frame that loaded but never said ready is held to the boot deadline from its load", async () => {
    const s = iframeLikeSandbox();
    await vi.advanceTimersByTimeAsync(1_000);
    s.frame().load();
    await vi.advanceTimersByTimeAsync(FRAME_BOOT_TIMEOUT_MS - 1);
    expect(pings(s.frame())).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(s.frame())).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEATH_MS);
    expect(s.frames).toHaveLength(2);
    s.sb.destroy();
  });

  it("a frame that never loads at all is still caught, at the generous outer deadline — and given up on within the remount window", async () => {
    const s = iframeLikeSandbox();
    await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS - 1);
    expect(s.frame().commands).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(s.frame())).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEATH_MS);
    expect(s.frames[0]!.destroyed()).toBe(true);
    expect(s.frames).toHaveLength(2);
    // Every remount loads nothing either: it dies each FRAME_LOAD_TIMEOUT_MS
    // + DEATH_MS, which fits MAX_FRAME_REMOUNTS + 1 deaths into the window.
    expect((MAX_FRAME_REMOUNTS + 1) * (FRAME_LOAD_TIMEOUT_MS + DEATH_MS)).toBeLessThan(FRAME_REMOUNT_WINDOW_MS);
    for (let i = 0; i < MAX_FRAME_REMOUNTS; i++) await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS + DEATH_MS);
    expect(s.sb.isFrameLost()).toBe(true);
    expect(s.frames).toHaveLength(MAX_FRAME_REMOUNTS + 1);
    expect(s.events.onFrameLost).toHaveBeenCalledExactlyOnceWith(FRAME_LOST_MESSAGE);
    s.sb.destroy();
  });

  it("a load reported by a frame already replaced does not re-arm anything for the new one", async () => {
    const s = iframeLikeSandbox();
    await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS + DEATH_MS);
    const [old, fresh] = s.frames;
    expect(old!.destroyed()).toBe(true);
    old!.load(); // late
    await vi.advanceTimersByTimeAsync(FRAME_BOOT_TIMEOUT_MS + DEATH_MS);
    // Had the stale load re-armed the boot deadline, the new frame would be
    // probed (and gone) by now; it is still inside its own load wait.
    expect(fresh!.commands).toEqual([]);
    expect(s.frames).toHaveLength(2);
    s.sb.destroy();
  });
});

// ── R2-M1: a frame lost mid-export, and a preview frame slow to load ───────

describe("R2-M1 — the export fails on a lost frame; the preview says a frame is still starting", () => {
  /** The export's sandbox, wired to its layer source exactly as
   *  render-entry.ts wires them. */
  function exportRig(bodies: Array<[string, string]> = [["o1", HASH_A]]) {
    let src: ExportLayerSource | null = null;
    const s = iframeLikeSandbox({
      ...EXPORT_SANDBOX_OPTIONS,
      onLayer: (m) => (src ? src.onLayer(m) : m.bitmap.close()),
      onError: (m) => src?.onError(m),
      onUnattributed: (m) => src?.onUnattributed(m),
      onTimeout: (id, phase, afterMs, reason) => src?.onTimeout(id, phase, afterMs, reason),
      onRestart: () => src?.onRestart(),
      onFrameLost: (message) => src?.onFrameLost(message),
    });
    // As render-entry.ts does: every body, joining the host's own replay.
    const loadAll = () =>
      Promise.all(bodies.map(([id, hash]) => s.sb.load(loadInput(id, hash)).catch(() => {}))).then(() => {});
    src = new ExportLayerSource((input) => s.sb.render(input), { reloadAll: loadAll });
    return { ...s, src };
  }
  const request = (frame: number) => ({
    overlayId: "o1",
    kind: "code" as const,
    frame,
    size: { width: 100, height: 50 },
    pixelRatio: 1,
    fps: 30,
    time: { ...timing, frame },
  });

  it("a frame that dies mid-export — its replacement would never load — FAILS the export loudly, and nothing is listed as dropped", async () => {
    const r = exportRig();
    r.frame().load();
    const p = r.ready();
    const load = r.sb.load(loadInput("o1", HASH_A));
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    await load;

    // Frame 0 renders.
    const first = r.src.settle([request(0)], { frame: 0, time: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const req0 = (p.posted.filter((m) => m.t === "render").at(-1) as { req: number }).req;
    p.deliver({ t: "layer", nonce: NONCE, id: "o1", frame: 0, req: req0, bitmap: bitmap(100, 50) });
    await first;
    expect(r.src.get("o1", 0)).not.toBeNull();

    // Frame 1: the body exhausts memory and takes the frame's renderer process
    // down with it. Nothing answers again — not the render, not the restart,
    // not a ping — and a replacement, were one mounted, would hang loading.
    let outcome: unknown = "pending";
    const second = r.src.settle([request(1)], { frame: 1, time: 1 / 30 }).then(
      () => (outcome = "completed"),
      (e: Error) => (outcome = e),
    );
    // Watchdog (first render at this size: the load budget) + restart wait +
    // the ping and its confirmation: well inside the export's own restart
    // wait, so no retry ever reads "not loaded" or "restarted".
    await vi.advanceTimersByTimeAsync(5_000 + RESTART_READY_TIMEOUT_MS + DEATH_MS);
    // The frame died while the worker was restarting for o1: that is the
    // overlay named (R3-M2).
    const died = frameDiedMessage({ id: "o1", kind: "code" });
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe(died);
    expect(r.sb.isFrameLost()).toBe(true);
    expect(r.sb.frameLostMessage).toBe(died);
    // No replacement was mounted to hang, and the next frame fails the same way.
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]!.destroyed()).toBe(true);
    await expect(r.src.settle([request(2)], { frame: 2, time: 2 / 30 })).rejects.toThrow(died);
    // Nothing reads as a body that merely failed to load or kept restarting.
    for (const f of r.src.failures.values()) expect([NOT_LOADED_MESSAGE, RESTARTED_MESSAGE]).not.toContain(f.message);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.frames).toHaveLength(1);
    await second;
    r.src.dispose();
    r.sb.destroy();
  });

  it("the lost-frame text of a sandbox that replaces nothing does not claim remounts that never happened", () => {
    expect(FRAME_DIED_MESSAGE).not.toMatch(/times within|replaced after/);
    expect(frameDiedMessage({ id: "o1" })).not.toMatch(/times within|replaced after/);
    expect(FRAME_LOST_MESSAGE).toContain(`${MAX_FRAME_REMOUNTS + 1} times`);
  });

  // ── R3-M2: an out-of-memory export names the overlay, and does not say "export again" ──

  it("with a suspect, the export's failure names that overlay, says why, and says to fix or remove its code — never to export again", () => {
    const text = frameDiedMessage({ id: "ov-7", kind: "tracked" });
    expect(text).toContain('the tracked-code overlay "ov-7"');
    expect(text).toMatch(/used too much memory or crashed/);
    expect(text).toMatch(/Fix or remove that overlay's code/);
    expect(text).not.toMatch(/export again/i);
    // Only the no-suspect text still suggests running it again.
    expect(FRAME_DIED_MESSAGE).toMatch(/Export again to retry/);
  });

  it("a frame that dies with no restart an overlay caused (at boot) keeps the plain \"export again\" text", async () => {
    const r = exportRig();
    // The frame never loads, so no worker ever ran a body.
    await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS + DEATH_MS);
    expect(r.sb.isFrameLost()).toBe(true);
    expect(r.sb.frameLostMessage).toBe(FRAME_DIED_MESSAGE);
    expect(r.src.unattributed.map((u) => u.message)).toEqual([FRAME_DIED_MESSAGE]);
    r.src.dispose();
    r.sb.destroy();
  });

  it("a suspect is forgotten once a fresh worker comes up: a later death with no suspect of its own names nobody", async () => {
    const r = exportRig();
    r.frame().load();
    const p = r.ready();
    const load = r.sb.load(loadInput("o1", HASH_A));
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    await load;
    // o1's first render wedges: it is dropped and the worker restarted …
    const req = r.sb.render(renderInput("o1"));
    expect(req).toBeGreaterThan(0);
    p.deliver({ t: "started", nonce: NONCE, id: "o1", req });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.sb.isDropped("o1")).toBe(true);
    expect(r.sb.frameLostMessage).toBe(frameDiedMessage({ id: "o1", kind: "code" }));
    // … and a fresh worker says ready: that restart is over, o1 did not kill the frame.
    r.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.sb.frameLostMessage).toBe(FRAME_DIED_MESSAGE);
    r.src.dispose();
    r.sb.destroy();
  });

  it(`a preview frame still loading after ${FRAME_STARTING_NOTICE_MS / 1000} s is said so once, unattributed — and withdrawn when it loads`, async () => {
    const onFrameStarting = vi.fn();
    const s = iframeLikeSandbox({ onFrameStarting });
    await vi.advanceTimersByTimeAsync(FRAME_STARTING_NOTICE_MS - 1);
    expect(onFrameStarting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFrameStarting).toHaveBeenCalledExactlyOnceWith(FRAME_STARTING_MESSAGE);
    // Blames no overlay, and is not the dead-frame path: nothing was probed.
    expect(s.events.onError).not.toHaveBeenCalled();
    expect(s.frame().commands).toEqual([]);
    s.frame().load();
    expect(onFrameStarting).toHaveBeenLastCalledWith(null);
    s.ready();
    await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS);
    expect(onFrameStarting).toHaveBeenCalledTimes(2);
    s.sb.destroy();
    expect(onFrameStarting).toHaveBeenCalledTimes(2);
  });

  it("a frame that loads in time says nothing, and the 60 s load deadline is unchanged by the notice", async () => {
    const onFrameStarting = vi.fn();
    const s = iframeLikeSandbox({ onFrameStarting });
    await vi.advanceTimersByTimeAsync(FRAME_STARTING_NOTICE_MS - 1_000);
    s.frame().load();
    s.ready();
    await vi.advanceTimersByTimeAsync(FRAME_STARTING_NOTICE_MS * 5);
    expect(onFrameStarting).not.toHaveBeenCalled();
    s.sb.destroy();

    const slow = iframeLikeSandbox({ onFrameStarting });
    await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS - 1);
    expect(pings(slow.frame())).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(slow.frame())).toHaveLength(1);
    slow.sb.destroy();
  });

  it("the notice stays up, posted once, across remounts of frames that never load — and gives way to the lost-frame report", async () => {
    const onFrameStarting = vi.fn();
    const s = iframeLikeSandbox({ onFrameStarting });
    for (let i = 0; i <= MAX_FRAME_REMOUNTS; i++) await vi.advanceTimersByTimeAsync(FRAME_LOAD_TIMEOUT_MS + DEATH_MS);
    expect(s.sb.isFrameLost()).toBe(true);
    expect(onFrameStarting.mock.calls).toEqual([[FRAME_STARTING_MESSAGE], [null]]);
    expect(s.events.onFrameLost).toHaveBeenCalledExactlyOnceWith(FRAME_LOST_MESSAGE);
    s.sb.destroy();
  });

  it("a remounted frame that is slow to load is said so again, after a clean start was withdrawn", async () => {
    const onFrameStarting = vi.fn();
    const s = iframeLikeSandbox({ onFrameStarting });
    s.frame().load();
    s.ready();
    void s.sb.ping();
    await vi.advanceTimersByTimeAsync(DEATH_MS);
    expect(s.frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(FRAME_STARTING_NOTICE_MS);
    expect(onFrameStarting).toHaveBeenCalledExactlyOnceWith(FRAME_STARTING_MESSAGE);
    s.frame().load();
    expect(onFrameStarting).toHaveBeenLastCalledWith(null);
    s.sb.destroy();
  });

  // ── R3-M3: a frame that stays up while its worker never comes back ──────

  /** Past `ms` of fake time, answering every ping the frame is sent: the
   *  supervisor is alive, it just never produces a worker. */
  async function aliveFor(r: ReturnType<typeof exportRig>, ms: number, step = 250) {
    const answered = new Set<number | undefined>();
    for (let t = 0; t < ms; t += step) {
      await vi.advanceTimersByTimeAsync(step);
      for (const ping of pings(r.frame())) {
        if (answered.has(ping.id)) continue;
        answered.add(ping.id);
        r.frame().reply({ t: "pong", nonce: NONCE, id: ping.id });
      }
    }
  }

  const requestFor = (overlayId: string, frame: number) => ({ ...request(frame), overlayId });

  /** o1 and o2 loaded and frame 0 rendered; frame 1's render wedges in o1's
   *  body, which the watchdog drops ~`RENDER_TIMEOUT_MS` later and restarts
   *  the worker. The export loop then asks for frame 2 at once, as it does. */
  async function wedgedMidExport() {
    const r = exportRig([
      ["o1", HASH_A],
      ["o2", HASH_B],
    ]);
    r.frame().load();
    const p = r.ready();
    const loads = [r.sb.load(loadInput("o1", HASH_A)), r.sb.load(loadInput("o2", HASH_B))];
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    p.deliver({ t: "loaded", nonce: NONCE, id: "o2", sourceHash: HASH_B });
    await Promise.all(loads);
    const answerNext = async (id: string, frame: number) => {
      await vi.advanceTimersByTimeAsync(0);
      const req = (p.posted.filter((m) => m.t === "render").at(-1) as { req: number }).req;
      p.deliver({ t: "layer", nonce: NONCE, id, frame, req, bitmap: bitmap(100, 50) });
    };
    const first = r.src.settle([requestFor("o1", 0), requestFor("o2", 0)], { frame: 0, time: 0 });
    await answerNext("o1", 0);
    await answerNext("o2", 0);
    await first;
    const second = r.src.settle([requestFor("o1", 1)], { frame: 1, time: 1 / 30 });
    await vi.advanceTimersByTimeAsync(0);
    const req1 = (p.posted.filter((m) => m.t === "render").at(-1) as { req: number }).req;
    p.deliver({ t: "started", nonce: NONCE, id: "o1", req: req1 });
    await aliveFor(r, RENDER_TIMEOUT_MS);
    expect(r.sb.isDropped("o1")).toBe(true);
    // Frame 1 is o1's own failure, as it always was.
    await second;
    let outcome: unknown = "pending";
    const third = r.src
      .settle([requestFor("o1", 2), requestFor("o2", 2)], { frame: 2, time: 2 / 30 })
      .then(
        () => (outcome = "completed"),
        (e: Error) => (outcome = e),
      );
    return { r, third, outcome: () => outcome };
  }

  it("the export's worker-restart deadline sits between a frame death's confirmation and the export's restart wait", () => {
    const deadline = EXPORT_SANDBOX_OPTIONS.workerRestartTimeoutMs;
    // Above it: a dead frame is confirmed first, and reported as one.
    expect(deadline).toBeGreaterThan(RESTART_READY_TIMEOUT_MS + DEATH_MS);
    // Below it: no abandoned render is retried on no worker (read "not loaded").
    expect(deadline).toBeLessThan(DEFAULT_RESTART_WAIT_MS);
  });

  it("a frame that answers every ping while no fresh worker ever says ready FAILS the export loudly, naming the overlay — nothing is listed as dropped", async () => {
    const { r, third, outcome } = await wedgedMidExport();
    // The supervisor, alive, never delivers a worker after the watchdog's
    // restart. It even says why, again and again: the restart is rescheduled.
    r.frame().reply({ t: "supervisorError", nonce: NONCE, message: "could not create a worker" });
    await aliveFor(r, DEFAULT_RESTART_WAIT_MS + 5_000);
    const text = workerNotRestartedMessage(EXPORT_SANDBOX_OPTIONS.workerRestartTimeoutMs, { id: "o1", kind: "code" });
    expect(outcome()).toBeInstanceOf(Error);
    expect((outcome() as Error).message).toBe(text);
    expect(r.sb.isFrameLost()).toBe(true);
    expect(r.sb.frameLostMessage).toBe(text);
    expect(text).toMatch(/Fix or remove that overlay's code/);
    await expect(r.src.settle([request(2)], { frame: 2, time: 2 / 30 })).rejects.toThrow(text);
    // Nothing is listed as a body that merely failed to load or kept
    // restarting: before R3-M3 the restart wait ran out, frame 2 went on with
    // no worker, and the export completed without o1 or o2. (o2 carries the
    // supervisor's own reason, which the host reports for every body the
    // worker it could not create would have run.)
    for (const f of r.src.failures.values()) expect([NOT_LOADED_MESSAGE, RESTARTED_MESSAGE]).not.toContain(f.message);
    // No replacement frame either: the export replaces nothing.
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]!.destroyed()).toBe(true);
    await third;
    r.src.dispose();
    r.sb.destroy();
  });

  it("a worker that comes back inside the deadline does not fail the export", async () => {
    const { r, third, outcome } = await wedgedMidExport();
    await aliveFor(r, EXPORT_SANDBOX_OPTIONS.workerRestartTimeoutMs - RENDER_TIMEOUT_MS - 1_000);
    const p = r.ready();
    // The export's reload, then frame 2's o2 render on the fresh worker.
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o2", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    const render = p.posted.filter((m) => m.t === "render").at(-1) as { req: number; id: string };
    expect(render.id).toBe("o2");
    p.deliver({ t: "layer", nonce: NONCE, id: "o2", frame: 2, req: render.req, bitmap: bitmap(100, 50) });
    await aliveFor(r, 30_000);
    expect(r.sb.isFrameLost()).toBe(false);
    // o1 stays dropped for its source; frame 2 completes with o2 drawn.
    expect(outcome()).toBe("completed");
    expect(r.src.get("o2", 2)).not.toBeNull();
    await third;
    r.src.dispose();
    r.sb.destroy();
  });

  it("the preview sets no deadline: its live frame keeps waiting for a worker, and is never given up on", async () => {
    const s = iframeLikeSandbox();
    s.frame().load();
    const p = s.ready();
    const load = s.sb.load(loadInput("o1", HASH_A));
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: NONCE, id: "o1", sourceHash: HASH_A });
    await load;
    const req = s.sb.render(renderInput("o1"));
    p.deliver({ t: "started", nonce: NONCE, id: "o1", req });
    const answered = new Set<number | undefined>();
    for (let t = 0; t < 120_000; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      for (const ping of pings(s.frame())) {
        if (answered.has(ping.id)) continue;
        answered.add(ping.id);
        s.frame().reply({ t: "pong", nonce: NONCE, id: ping.id });
      }
    }
    expect(s.sb.isDropped("o1")).toBe(true);
    expect(s.sb.isFrameLost()).toBe(false);
    expect(s.events.onFrameLost).not.toHaveBeenCalled();
    s.sb.destroy();
  });
});

// ── R-M5: host stalls, and pongs matched by id ─────────────────────────────

describe("R-M5 — a stall on the HOST is not a dead frame, and a pong answers its own ping", () => {
  it("a ping deadline that runs ahead of a pong already queued (the host's main thread was blocked) does not remount a live frame", async () => {
    const s = sandbox();
    s.ready();
    const f = s.frame();
    const first = s.sb.ping();
    // The host is blocked past the deadline; when it gets its thread back the
    // timer task runs before the pong the frame had already sent.
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(first).resolves.toBe(-1);
    expect(f.destroyed()).toBe(false);
    expect(pings(f)).toHaveLength(2); // the confirming ping
    f.reply({ t: "pong", nonce: NONCE, id: pings(f)[0]!.id }); // the queued answer
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS * 5);
    expect(f.destroyed()).toBe(false);
    expect(s.frames).toHaveLength(1);
    s.sb.destroy();
  });

  it("pongs are correlated by id: answers out of order resolve their own pings, and a lost ping leaves later ones in step", async () => {
    const s = sandbox();
    s.ready();
    const f = s.frame();
    const a = s.sb.ping();
    await vi.advanceTimersByTimeAsync(5);
    const b = s.sb.ping();
    const [pa, pb] = pings(f);
    f.reply({ t: "pong", nonce: NONCE, id: pb!.id });
    await expect(b).resolves.toBe(0);
    let aDone = false;
    void a.then(() => (aDone = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(aDone).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    f.reply({ t: "pong", nonce: NONCE, id: pa!.id });
    await expect(a).resolves.toBe(15);

    // A ping the frame never saw (the old FIFO kept it forever and paired
    // every later pong one behind): the next ping still gets its own answer.
    const lost = s.sb.ping();
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    await expect(lost).resolves.toBe(-1);
    const confirming = pings(f).at(-1)!;
    f.reply({ t: "pong", nonce: NONCE, id: confirming.id });
    const next = s.sb.ping();
    await vi.advanceTimersByTimeAsync(7);
    f.reply({ t: "pong", nonce: NONCE, id: pings(f).at(-1)!.id });
    await expect(next).resolves.toBe(7);
    // A stray pong (no id, or one nobody waits for) resolves nothing.
    const pending = s.sb.ping();
    f.reply({ t: "pong", nonce: NONCE });
    f.reply({ t: "pong", nonce: NONCE, id: 9999 });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    s.sb.destroy();
    await expect(pending).resolves.toBe(-1);
  });
});
