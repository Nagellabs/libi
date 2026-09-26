// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OverlaySandbox, LOAD_TIMEOUT_MS, PROBE_EXTRA_BUDGET_MS, RENDER_TIMEOUT_MS, RESTART_BACKOFF_MS, type SandboxTransport } from "@/lib/sandbox/host";
import { createIframeTransport } from "@/lib/sandbox/iframe-transport";
import {
  IDLE_LAYER_MS,
  MAX_LAYER_PIXEL_RATIO,
  MAX_LAYER_SIDE,
  PROTOCOL_VERSION,
  parseHostMessage,
  type HostMessage,
  type SupervisorCommand,
} from "@/lib/sandbox/protocol";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const timing = { frame: 0, time: 0, totalFrames: 30, duration: 1, progress: 0 };
const bitmap = (w = 2) => ({ width: w, height: w, close: vi.fn() });

/** A fake MessagePort: what the host posts is recorded; the test delivers
 *  worker replies by calling `deliver`. */
interface FakePort {
  port: MessagePort;
  posted: Array<{ msg: HostMessage; transfer: Transferable[] }>;
  deliver(data: unknown): void;
  deliverUncloneable(): void;
  closed: () => boolean;
}
function fakePort(): FakePort {
  const posted: FakePort["posted"] = [];
  let closed = false;
  const port = {
    postMessage: (msg: HostMessage, transfer: Transferable[] = []) => {
      posted.push({ msg, transfer });
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
    deliver: (data) => port.onmessage?.({ data }),
    deliverUncloneable: () => port.onmessageerror?.(),
    closed: () => closed,
  };
}

/** The iframe leg: records supervisor commands; the test plays the supervisor. */
interface Fake {
  transport: SandboxTransport;
  commands: SupervisorCommand[];
  reply(data: unknown, source?: unknown): void;
  nonce: string;
}
function fakeFactory() {
  const created: Fake[] = [];
  const createTransport = (nonce: string): SandboxTransport => {
    let handler: ((d: unknown, s: unknown) => void) | null = null;
    const peer = { tag: "frame" };
    const fake: Fake = {
      nonce,
      commands: [],
      transport: {
        command(msg) {
          fake.commands.push(msg);
        },
        onReply(h) {
          handler = h;
        },
        peer,
        destroy: vi.fn(),
      },
      reply(data, source = peer) {
        handler?.(data, source);
      },
    };
    created.push(fake);
    return fake.transport;
  };
  return { created, createTransport };
}

function makeSandbox() {
  const f = fakeFactory();
  const events = { onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onRestart: vi.fn() };
  const sb = new OverlaySandbox({
    createTransport: f.createTransport,
    nonce: () => "nonce-1",
    cloneBitmap: async (b) => ({ ...b, cloned: true }) as unknown as ImageBitmap,
    ...events,
  });
  const frame = () => f.created[0];
  /** The supervisor announces a (new) worker with a fresh port. */
  const ready = (): FakePort => {
    const p = fakePort();
    frame().reply({ t: "ready", nonce: frame().nonce, version: PROTOCOL_VERSION, port: p.port });
    return p;
  };
  return { sb, f, events, frame, ready };
}

const loadA = { id: "o1", kind: "code" as const, source: "ctx.fillRect(0,0,1,1)", sourceHash: HASH_A, width: 100, height: 50 };
const renderO1 = { id: "o1", frame: 0, size: { width: 100, height: 50 }, pixelRatio: 1, fps: 30, time: timing };
const loads = (p: FakePort) => p.posted.filter((x) => x.msg.t === "load").map((x) => (x.msg as { id: string }).id);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("OverlaySandbox — trust boundary", () => {
  it("ignores a ready from another source or with the wrong nonce", async () => {
    const { sb, frame } = makeSandbox();
    let resolved = false;
    void sb.ready.then(() => {
      resolved = true;
    });
    frame().reply({ t: "ready", nonce: frame().nonce, version: PROTOCOL_VERSION, port: fakePort().port }, { tag: "stranger" });
    frame().reply({ t: "ready", nonce: "forged", version: PROTOCOL_VERSION, port: fakePort().port });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    frame().reply({ t: "ready", nonce: frame().nonce, version: PROTOCOL_VERSION, port: fakePort().port });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    sb.destroy();
  });
  it("drops a malformed or wrong-nonce message on the port instead of throwing", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    expect(() => p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req: 1, bitmap: "nope" })).not.toThrow();
    const b = bitmap();
    p.deliver({ t: "layer", nonce: "forged", id: "o1", frame: 0, req: 1, bitmap: b });
    expect(events.onLayer).not.toHaveBeenCalled();
    sb.destroy();
  });
});

describe("OverlaySandbox — load", () => {
  it("posts load on the port once per sourceHash, fonts on the first load only, and clones images before transfer", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    sb.setFonts([{ family: "Inter", weight: 700, data: new ArrayBuffer(4) }]);
    const img = bitmap();
    const p1 = sb.load({ ...loadA, images: { f1: img as unknown as ImageBitmap } });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.posted).toHaveLength(1);
    const first = p.posted[0];
    expect(first.msg.t).toBe("load");
    if (first.msg.t !== "load") throw new Error("unreachable");
    expect(first.msg.fonts).toHaveLength(1);
    expect(first.msg.fonts![0].data).not.toBe(sb["fonts"][0].data); // a copy went over
    expect((first.msg.images!.f1 as unknown as { cloned: boolean }).cloned).toBe(true);
    expect(first.transfer).toContain(first.msg.images!.f1);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await p1;
    expect(sb.isLoaded("o1")).toBe(true);

    await sb.load(loadA); // same hash: nothing posted
    expect(p.posted).toHaveLength(1);

    const p3 = sb.load({ ...loadA, source: "x", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    expect(p.posted).toHaveLength(2);
    const second = p.posted[1].msg;
    expect(second.t === "load" && second.fonts).toBeUndefined();
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_B });
    await p3;
    sb.destroy();
  });
  it("posts a load called before the first ready exactly once — the parked caller and the replay join", async () => {
    const { sb, ready } = makeSandbox();
    const pr = sb.load(loadA);
    const p = ready(); // resolves the parked load AND replays the source cache
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p)).toEqual(["o1"]);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr; // the parked caller settles from the one post, not never
    expect(sb.isLoaded("o1")).toBe(true);
    sb.destroy();
  });
  it("closes every cloned bitmap it ends up not posting", async () => {
    const f = fakeFactory();
    const events = { onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onRestart: vi.fn() };
    let releaseClone: (() => void) | null = null;
    const clone = bitmap();
    const sb = new OverlaySandbox({
      createTransport: f.createTransport,
      nonce: () => "nonce-1",
      cloneBitmap: () =>
        new Promise<ImageBitmap>((resolve) => {
          releaseClone = () => resolve(clone as unknown as ImageBitmap);
        }),
      ...events,
    });
    const p = fakePort();
    f.created[0].reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: p.port });

    const withImages = sb.load({ ...loadA, images: { f1: bitmap() as unknown as ImageBitmap } });
    await vi.advanceTimersByTimeAsync(0); // parked inside cloneBitmap
    // A newer source lands while the clone is still in flight.
    const newer = sb.load({ ...loadA, source: "newer", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    releaseClone!();
    await withImages;
    expect(loads(p)).toEqual(["o1"]); // only the newer source was posted
    expect(clone.close).toHaveBeenCalledTimes(1); // the clone did not leak
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_B });
    await newer;
    sb.destroy();
  });
  it("a second load of the same source while the first is still cloning joins it — one post", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    const img = bitmap() as unknown as ImageBitmap;
    // The SAME object both times — what `adoptPort`'s replay of the source
    // cache passes, and the only shape the `sources.get(id) !== input` guard
    // does not already stop.
    const input = { ...loadA, images: { f1: img } };
    const a = sb.load(input);
    const b = sb.load(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p)).toEqual(["o1"]);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await Promise.all([a, b]);
    expect(sb.isLoaded("o1")).toBe(true);
    sb.destroy();
  });
  it("settles a superseded load by HASH, so a late loaded for the old source cannot pin loadedHashes", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    const first = sb.load(loadA);
    void first.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const second = sb.load({ ...loadA, source: "newer", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).rejects.toThrow("superseded");
    expect(loads(p)).toEqual(["o1", "o1"]);

    // The worker answers the SUPERSEDED load first. It must not settle the
    // newer one, and the newer hash must still be able to land.
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_B });
    await second;
    expect(sb.isLoaded("o1")).toBe(true);
    // The hash the host believes the worker holds is the NEW one: a render is
    // allowed and the next load of HASH_B is a no-op rather than a re-post.
    expect(sb.render(renderO1)).toBeGreaterThan(0);
    await sb.load({ ...loadA, source: "newer", sourceHash: HASH_B });
    expect(loads(p)).toEqual(["o1", "o1"]);
    sb.destroy();
  });
  it("rejects the load promise on a compile error and forwards it", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "compile", message: "Unexpected token" });
    await expect(pr).rejects.toThrow("Unexpected token");
    expect(events.onError).toHaveBeenCalledWith(expect.objectContaining({ phase: "compile", id: "o1" }));
    expect(sb.isLoaded("o1")).toBe(false);
    sb.destroy();
  });
  it("matches a compile error by sourceHash when the worker sends one: a superseded load's error never rejects its successor", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    const first = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    const second = sb.load({ ...loadA, source: "newer", sourceHash: HASH_B });
    await expect(first).rejects.toThrow("superseded");
    await vi.advanceTimersByTimeAsync(0);
    // The OLD load's compile error arrives late. It is reported, but it must
    // not settle the pending load for HASH_B.
    p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "compile", message: "stale", sourceHash: HASH_A });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stale" }));
    let settled = false;
    void second.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    // Its OWN error does reject it.
    p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "compile", message: "mine", sourceHash: HASH_B });
    await expect(second).rejects.toThrow("mine");
    sb.destroy();
  });
});

describe("OverlaySandbox — a font-only change (fix round 1, minor 4)", () => {
  const inter = { family: "Inter", weight: 700, data: new ArrayBuffer(4) };
  const custom = { family: "libifont-x", weight: 400, data: new ArrayBuffer(8) };

  it("posts a changed font set at once, riding a same-hash load of a body the worker holds — without its images", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    sb.setFonts([inter]);
    const pa = sb.load({ ...loadA, images: { f1: bitmap() as unknown as ImageBitmap } });
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pa;
    expect(p.posted).toHaveLength(1);

    sb.setFonts([inter, custom]); // a text overlay gained an uploaded font; no body changed
    expect(p.posted).toHaveLength(2);
    const ride = p.posted[1];
    if (ride.msg.t !== "load") throw new Error("expected a load");
    expect(ride.msg).toMatchObject({ id: "o1", sourceHash: HASH_A, kind: "code" });
    expect(ride.msg.fonts!.map((f) => f.family)).toEqual(["Inter", "libifont-x"]);
    expect(ride.msg.images).toBeUndefined(); // the worker keeps the bitmaps it holds
    expect(ride.transfer).toEqual(ride.msg.fonts!.map((f) => f.data));
    expect(ride.msg.fonts![1].data).not.toBe(custom.data); // a copy went over
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    expect(sb.isLoaded("o1")).toBe(true);

    // Sent once: the next real load carries no fonts.
    const pb = sb.load({ ...loadA, source: "y", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    const next = p.posted[2].msg;
    expect(next.t === "load" && next.fonts).toBeUndefined();
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_B });
    await pb;
    sb.destroy();
  });

  it("with only a pending load, the new fonts go out as soon as a body is loaded", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    const pa = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    sb.setFonts([custom]); // the load in flight was posted without them
    expect(p.posted).toHaveLength(1);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pa;
    expect(p.posted).toHaveLength(2);
    const ride = p.posted[1].msg;
    expect(ride.t === "load" && ride.fonts?.map((f) => f.family)).toEqual(["libifont-x"]);
    sb.destroy();
  });
});

describe("OverlaySandbox — render and request ids", () => {
  async function loaded() {
    const s = makeSandbox();
    const p = s.ready();
    const pr = s.sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr;
    return { ...s, p };
  }
  it("returns -1 for an unloaded id and for a second render while one is in flight", async () => {
    const s = await loaded();
    expect(s.sb.render({ ...renderO1, id: "nope" })).toBe(-1);
    const req = s.sb.render(renderO1);
    expect(req).toBeGreaterThan(0);
    expect(s.sb.isInFlight("o1")).toBe(true);
    expect(s.sb.render({ ...renderO1, frame: 1 })).toBe(-1);
    s.sb.destroy();
  });
  it("delivers the matching layer, closes and ignores a stale one", async () => {
    const s = await loaded();
    const req = s.sb.render(renderO1);
    const stale = bitmap();
    s.p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req: req - 1, bitmap: stale });
    expect(stale.close).toHaveBeenCalled();
    expect(s.events.onLayer).not.toHaveBeenCalled();
    const fresh = bitmap();
    s.p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req, bitmap: fresh });
    expect(s.events.onLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "o1", req }));
    expect(s.sb.isInFlight("o1")).toBe(false);
    s.sb.destroy();
  });
  it("a render error clears the in-flight slot and is forwarded", async () => {
    const s = await loaded();
    const req = s.sb.render(renderO1);
    s.p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "render", message: "x is not defined", line: 2, column: 5, req });
    expect(s.events.onError).toHaveBeenCalledWith(expect.objectContaining({ line: 2, column: 5 }));
    expect(s.sb.isInFlight("o1")).toBe(false);
    s.sb.destroy();
  });
  it("an error that answers no render (an async escape) is forwarded but leaves the in-flight render alone", async () => {
    // Review I3: an escape from an earlier frame's promise lands while this
    // overlay's NEXT render is in flight. Clearing that flight closed the real
    // layer on arrival and froze the overlay on hold-last-good.
    const s = await loaded();
    const req = s.sb.render(renderO1);
    s.p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "render", message: "late escape" });
    expect(s.events.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "late escape" }));
    expect(s.sb.isInFlight("o1")).toBe(true);
    const fresh = bitmap();
    s.p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req, bitmap: fresh });
    expect(s.events.onLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "o1", req }));
    expect(fresh.close).not.toHaveBeenCalled();
    s.sb.destroy();
  });
  it("an error for an OLDER render request does not clear the newer one in flight", async () => {
    const s = await loaded();
    const req = s.sb.render(renderO1);
    s.p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "render", message: "old frame", req: req - 1 });
    expect(s.sb.isInFlight("o1")).toBe(true);
    s.sb.destroy();
  });
  it("a superseded load's build error does not clear the render in flight (review minor 8)", async () => {
    const s = await loaded();
    s.sb.render(renderO1);
    s.p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "build", message: "stale", sourceHash: HASH_B });
    expect(s.events.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stale" }));
    expect(s.sb.isInFlight("o1")).toBe(true);
    s.sb.destroy();
  });
  it("an unattributed runtime diagnostic goes to onUnattributed, never to an overlay's onError", async () => {
    const f = fakeFactory();
    const onUnattributed = vi.fn();
    const events = { onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() };
    const sb = new OverlaySandbox({ createTransport: f.createTransport, nonce: () => "nonce-1", onUnattributed, ...events });
    const p = fakePort();
    f.created[0].reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: p.port });
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "unattributed", nonce: "nonce-1", message: "boom", line: 3, column: 1 });
    p.deliver({ t: "unattributed", nonce: "wrong", message: "forged" });
    expect(onUnattributed).toHaveBeenCalledTimes(1);
    expect(onUnattributed).toHaveBeenCalledWith(expect.objectContaining({ message: "boom", line: 3 }));
    expect(events.onError).not.toHaveBeenCalled();
    sb.destroy();
  });
});

describe("OverlaySandbox — watchdog (spec §4.7 as amended by A1)", () => {
  it("a render unanswered for 2000 ms drops the overlay and asks the SUPERVISOR to restart; the next ready replays the others", async () => {
    const { sb, frame, ready, events } = makeSandbox();
    const p1 = ready();
    const pa = sb.load(loadA);
    const pb = sb.load({ ...loadA, id: "o2", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    p1.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    p1.deliver({ t: "loaded", nonce: "nonce-1", id: "o2", sourceHash: HASH_B });
    await Promise.all([pa, pb]);
    // One answered render first: a body's first render gets the load budget
    // (fix round 1, ruling 2), and this is about the 2 s one.
    const warm = sb.render(renderO1);
    p1.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req: warm, bitmap: bitmap() });

    const wedged = sb.render(renderO1);
    expect(wedged).toBeGreaterThan(0);
    p1.deliver({ t: "started", nonce: "nonce-1", id: "o1", req: wedged }); // it entered its body…
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // …and never came back
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    expect(frame().transport.destroy).not.toHaveBeenCalled(); // the iframe stays
    expect(sb.isDropped("o1")).toBe(true);
    expect(sb.render(renderO1)).toBe(-1);
    expect(sb.render({ ...renderO1, id: "o2" })).toBe(-1); // no port until the new ready

    // The supervisor answers with a fresh worker: the old port is closed and
    // only the surviving source is replayed, fonts first.
    const p2 = ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(p1.closed()).toBe(true);
    expect(sb.generation()).toBe(2);
    expect(events.onRestart).toHaveBeenCalledTimes(1);
    expect(loads(p2)).toEqual(["o2"]);
    expect(sb.isLoaded("o2")).toBe(false);
    p2.deliver({ t: "loaded", nonce: "nonce-1", id: "o2", sourceHash: HASH_B });
    expect(sb.isLoaded("o2")).toBe(true);
    expect(sb.render({ ...renderO1, id: "o2" })).toBeGreaterThan(0);

    // Same hash again: still dropped. A new hash: retried.
    await sb.load(loadA);
    expect(sb.isDropped("o1")).toBe(true);
    const retry = sb.load({ ...loadA, source: "fixed", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p2)).toEqual(["o2", "o1"]);
    p2.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_B });
    await retry;
    expect(sb.isDropped("o1")).toBe(false);
    sb.destroy();
  });
  it("a load unanswered for 5000 ms is dropped the same way", async () => {
    const { sb, frame, ready, events } = makeSandbox();
    ready();
    const p = sb.load(loadA);
    // The rejection lands INSIDE advanceTimers; attach a handler first or the
    // run reports a spurious unhandled rejection.
    void p.catch(() => {});
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await expect(p).rejects.toThrow("timed out after 5 s");
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "load", LOAD_TIMEOUT_MS);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    sb.destroy();
  });
  it("ping round-trips through the supervisor and resolves with the latency", async () => {
    const { sb, frame, ready } = makeSandbox();
    ready();
    const p = sb.ping();
    expect(frame().commands.at(-1)).toEqual({ t: "ping", nonce: "nonce-1", id: 1 });
    await vi.advanceTimersByTimeAsync(3);
    frame().reply({ t: "pong", nonce: "nonce-1", id: 1 });
    await expect(p).resolves.toBeGreaterThanOrEqual(0);
    sb.destroy();
  });
  it("destroy closes the port, tears down the iframe and stops the timers", async () => {
    const { sb, frame, ready, events } = makeSandbox();
    const p = ready();
    void sb.load(loadA).catch(() => {});
    sb.destroy();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1);
    expect(events.onTimeout).not.toHaveBeenCalled();
    expect(p.closed()).toBe(true);
    expect(frame().transport.destroy).toHaveBeenCalled();
  });
});

describe("OverlaySandbox — who holds the thread (Task 13 fix round 2)", () => {
  /** Two overlays loaded and warm (one answered render each), so the next
   *  render of either gets the 2 s budget. */
  async function twoWarm() {
    const s = makeSandbox();
    const p = s.ready();
    const pa = s.sb.load(loadA);
    const pb = s.sb.load({ ...loadA, id: "o2", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o2", sourceHash: HASH_B });
    await Promise.all([pa, pb]);
    for (const id of ["o1", "o2"]) {
      const req = s.sb.render({ ...renderO1, id });
      p.deliver({ t: "started", nonce: "nonce-1", id, req });
      p.deliver({ t: "layer", nonce: "nonce-1", id, frame: 0, req, bitmap: bitmap() });
    }
    return { ...s, p };
  }

  it("an open async window blames its owner, not the render the watchdog was timing — which never started", async () => {
    const { sb, p, events, frame } = await twoWarm();
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" }); // o2's timer took the thread…
    sb.render(renderO1); // …so o1's render never starts
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(events.onTimeout).toHaveBeenCalledTimes(1);
    expect(events.onTimeout).toHaveBeenCalledWith("o2", "render", RENDER_TIMEOUT_MS);
    expect(sb.isDropped("o2")).toBe(true);
    expect(sb.isDropped("o1")).toBe(false);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
  });

  it("…and over a render that DID start, when the window opened after it (a sibling's timer inside that render's yield)", async () => {
    const { sb, p, events } = await twoWarm();
    const req = sb.render(renderO1);
    p.deliver({ t: "started", nonce: "nonce-1", id: "o1", req });
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(events.onTimeout).toHaveBeenCalledWith("o2", "render", RENDER_TIMEOUT_MS);
    expect(sb.isDropped("o1")).toBe(false);
  });

  it("a callback that took the thread a moment before the head ran out gets the rest of its 2 s — and one that returns in time costs nobody anything", async () => {
    const { sb, p, events } = await twoWarm();
    const req = sb.render(renderO1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 100);
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" }); // 100 ms before o1's budget ends
    await vi.advanceTimersByTimeAsync(100);
    expect(events.onTimeout).not.toHaveBeenCalled(); // o2 has held it 100 ms, not 2 s
    await vi.advanceTimersByTimeAsync(500);
    p.deliver({ t: "asyncDone", nonce: "nonce-1", id: "o2" });
    p.deliver({ t: "started", nonce: "nonce-1", id: "o1", req });
    p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req, bitmap: bitmap() });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS * 2);
    expect(events.onTimeout).not.toHaveBeenCalled();
    expect(events.onLayer.mock.calls.at(-1)?.[0]).toMatchObject({ id: "o1", req });
  });

  it("…while one that is still running when its 2 s are up is blamed then", async () => {
    const { sb, p, events } = await twoWarm();
    sb.render(renderO1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 100);
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onTimeout).toHaveBeenCalledWith("o2", "render", RENDER_TIMEOUT_MS);
    expect(sb.isDropped("o1")).toBe(false);
  });

  it("a render that started AFTER the head and never answered is blamed, not the older head waiting on its yield", async () => {
    const { sb, p, events } = await twoWarm();
    const r1 = sb.render(renderO1);
    const r2 = sb.render({ ...renderO1, id: "o2" });
    p.deliver({ t: "started", nonce: "nonce-1", id: "o1", req: r1 });
    await vi.advanceTimersByTimeAsync(1);
    p.deliver({ t: "started", nonce: "nonce-1", id: "o2", req: r2 }); // o1's answer is still a task away
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(events.onTimeout).toHaveBeenCalledTimes(1);
    expect(events.onTimeout).toHaveBeenCalledWith("o2", "render", RENDER_TIMEOUT_MS);
    expect(sb.isDropped("o1")).toBe(false);
  });

  it("asyncDone closes the window: a wedge after it, with nothing announced, takes the fallback (no one dropped)", async () => {
    const { sb, p, events, frame } = await twoWarm();
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" });
    p.deliver({ t: "asyncDone", nonce: "nonce-1", id: "o2" });
    sb.render(renderO1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(events.onTimeout).not.toHaveBeenCalled();
    expect(sb.isDropped("o1") || sb.isDropped("o2")).toBe(false);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
  });

  it("a window owned by an overlay the host no longer holds restarts the worker and drops nobody", async () => {
    const { sb, p, events, frame } = await twoWarm();
    sb.dispose("o2");
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" });
    sb.render(renderO1);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(events.onTimeout).not.toHaveBeenCalled();
    expect(sb.isDropped("o1")).toBe(false);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
  });

  it("a three build that wedges inside its own load is that load's timeout, as before", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    const pending = sb.load({ ...loadA, kind: "three" });
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "async", nonce: "nonce-1", id: "o1" }); // the build announced its factory
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    await expect(pending).rejects.toThrow("timed out after 5 s");
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "load", LOAD_TIMEOUT_MS);
  });

  it("a fresh worker starts with no window open", async () => {
    const { sb, p, events, ready } = await twoWarm();
    p.deliver({ t: "async", nonce: "nonce-1", id: "o2" });
    const p2 = ready();
    await vi.advanceTimersByTimeAsync(0);
    for (const id of ["o1", "o2"]) p2.deliver({ t: "loaded", nonce: "nonce-1", id, sourceHash: id === "o1" ? HASH_A : HASH_B });
    sb.render(renderO1);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(events.onTimeout).not.toHaveBeenCalled(); // an unstarted head, nothing announced: the fallback
    expect(sb.isDropped("o2")).toBe(false);
  });
});

describe("OverlaySandbox — supervisorError (Task 4 review ruling)", () => {
  it("after a ready, a supervisorError is a body diagnostic for the in-flight overlay — not a restart", async () => {
    const { sb, frame, ready, events } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr;
    const r = sb.render(renderO1);
    p.deliver({ t: "started", nonce: "nonce-1", id: "o1", req: r });

    frame().reply({ t: "supervisorError", nonce: "nonce-1", message: "worker error: boom" });
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o1", phase: "render", message: "worker error: boom" }),
    );
    expect(events.onTimeout).not.toHaveBeenCalled();
    expect(frame().commands).toEqual([]); // no restart from the error itself

    // Recovery stays with the watchdog — exactly one restart, on its own clock
    // (the load budget: this is o1's first render).
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS);
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "render", LOAD_TIMEOUT_MS);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    sb.destroy();
  });
  it("before any ready, a supervisorError is a boot failure: it restarts, but never faster than once per 2 s", async () => {
    const { sb, frame, events } = makeSandbox();
    const pr = sb.load(loadA);
    void pr.catch(() => {});

    frame().reply({ t: "supervisorError", nonce: "nonce-1", message: "SecurityError: worker refused" });
    // The overlay that will never render is named, with the supervisor's text.
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "load", LOAD_TIMEOUT_MS);
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o1", phase: "build", message: "SecurityError: worker refused" }),
    );
    expect(frame().commands).toEqual([]); // backed off, not immediate
    await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS - 1);
    expect(frame().commands).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);

    // Two more boot failures in a row still only ever buy one more restart.
    frame().reply({ t: "supervisorError", nonce: "nonce-1", message: "SecurityError: worker refused" });
    frame().reply({ t: "supervisorError", nonce: "nonce-1", message: "SecurityError: worker refused" });
    await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS);
    expect(frame().commands).toHaveLength(2);

    // The source is NOT blacklisted — a boot failure is not the body's fault,
    // so the next working generation replays it.
    expect(sb.isDropped("o1")).toBe(false);
    const p = fakePort();
    frame().reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: p.port });
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p)).toEqual(["o1"]);
    sb.destroy();
  });
  it("ignores a supervisorError whose nonce or source is wrong", async () => {
    const { sb, frame, events } = makeSandbox();
    frame().reply({ t: "supervisorError", nonce: "forged", message: "boom" });
    frame().reply({ t: "supervisorError", nonce: "nonce-1", message: "boom" }, { tag: "stranger" });
    await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS * 2);
    expect(frame().commands).toEqual([]);
    expect(events.onError).not.toHaveBeenCalled();
    sb.destroy();
  });
});

describe("OverlaySandbox — dispose and destroy", () => {
  it("posts dispose for a loaded id, forgets it, and stops replaying it", async () => {
    const { sb, ready, frame } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr;

    sb.dispose("o1");
    expect(p.posted.at(-1)?.msg).toEqual({ t: "dispose", id: "o1" });
    expect(sb.isLoaded("o1")).toBe(false);
    expect(sb.render(renderO1)).toBe(-1);

    // The source left the cache, so a restart does not bring it back.
    frame().reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: fakePort().port });
    await vi.advanceTimersByTimeAsync(0);
    expect(sb.isLoaded("o1")).toBe(false);
    sb.destroy();
  });
  it("rejects a still-pending load and posts nothing — the worker never acknowledged it", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p)).toEqual(["o1"]);

    sb.dispose("o1");
    await expect(pr).rejects.toThrow("disposed");
    expect(p.posted.filter((x) => x.msg.t === "dispose")).toHaveLength(0);
    sb.destroy();
  });
  it("abandons a render in flight: its timer is cleared and its late layer is closed", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr;
    const req = sb.render(renderO1);

    sb.dispose("o1");
    expect(sb.isInFlight("o1")).toBe(false);
    const late = bitmap();
    p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req, bitmap: late });
    expect(late.close).toHaveBeenCalled();
    expect(events.onLayer).not.toHaveBeenCalled();
    // No overlay is blamed for a render nobody is waiting on any more.
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 1);
    expect(events.onTimeout).not.toHaveBeenCalled();
    sb.destroy();
  });
  it("destroy settles a load parked before the first ready and drains pending pings", async () => {
    const { sb } = makeSandbox();
    const parked = sb.load(loadA);
    const ping = sb.ping();
    sb.destroy();
    await expect(parked).resolves.toBeUndefined();
    await expect(sb.ready).resolves.toBeUndefined();
    await expect(ping).resolves.toBe(-1);
  });
  it("routes an uncloneable message on the port to the overlay in flight", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr;
    sb.render(renderO1);

    p.deliverUncloneable();
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o1", phase: "render", message: expect.stringContaining("could not be deserialized") }),
    );
    sb.destroy();
  });
});

/**
 * Task 12b: the worker has one thread, so a request's watchdog starts when the
 * one before it has answered. The fake worker here is STRICTLY serial, which
 * the real one is not: it runs a render the moment it arrives, so a render can
 * be answered ahead of a load still awaiting fonts or a three build
 * (`attachRuntime`). These tests pin the common, synchronous path; the
 * out-of-order answer is covered on its own ("M3" below). Each load / render
 * takes the time the test gives its overlay, and a "wedged" overlay never
 * answers.
 */
describe("OverlaySandbox — the port queue: only the oldest unanswered request is timed (Task 12b)", () => {
  const HASH = (c: string) => c.repeat(64);

  function serialWorker(cost: { load?: Record<string, number>; render?: Record<string, number> }, wedged = new Set<string>()) {
    const f = fakeFactory();
    const events = { onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onRestart: vi.fn(), onFontsInstalled: vi.fn() };
    const sb = new OverlaySandbox({ createTransport: f.createTransport, nonce: () => "nonce-1", now: () => Date.now(), ...events });
    const answered: string[] = [];
    let generation = 0;
    const boot = () => {
      const gen = ++generation;
      const p = fakePort();
      const queue: HostMessage[] = [];
      let busy = false;
      const pump = () => {
        if (busy || gen !== generation) return;
        const msg = queue.shift();
        if (!msg) return;
        if (msg.t === "dispose") return pump();
        // The real runtime says so the moment before it calls the body.
        if (msg.t === "render") p.deliver({ t: "started", nonce: "nonce-1", id: msg.id, req: msg.req });
        if (wedged.has(msg.id)) {
          busy = true; // an infinite loop: nothing after it is ever answered
          return;
        }
        busy = true;
        const ms = (msg.t === "load" ? cost.load?.[msg.id] : cost.render?.[msg.id]) ?? 0;
        setTimeout(() => {
          busy = false;
          if (gen !== generation) return;
          answered.push(`${msg.id}:${msg.t}`);
          if (msg.t === "load") p.deliver({ t: "loaded", nonce: "nonce-1", id: msg.id, sourceHash: msg.sourceHash });
          else if (msg.t === "render") p.deliver({ t: "layer", nonce: "nonce-1", id: msg.id, frame: msg.frame, req: msg.req, bitmap: bitmap() });
          pump();
        }, ms);
      };
      const post = p.port.postMessage.bind(p.port) as (msg: HostMessage, transfer: Transferable[]) => void;
      (p.port as unknown as { postMessage: typeof post }).postMessage = (msg: HostMessage, transfer: Transferable[] = []) => {
        post(msg, transfer);
        queue.push(msg);
        pump();
      };
      f.created[0].reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: p.port });
      return p;
    };
    return { sb, f, events, answered, boot, commands: () => f.created[0].commands };
  }
  const load = (id: string, c: string) => ({ id, kind: "code" as const, source: `/*${id}*/`, sourceHash: HASH(c), width: 10, height: 10 });
  const render = (id: string) => ({ ...renderO1, id });
  /** Render each once and let it answer, so the next render is timed at 2 s:
   *  a body's first render gets the load budget (fix round 1, ruling 2). */
  async function warmAll(sb: OverlaySandbox, ids: string[], ms = 10) {
    for (const id of ids) sb.render(render(id));
    await vi.advanceTimersByTimeAsync(ms * ids.length + 10);
  }
  /** Load and let the fake worker answer (it answers on a timer). */
  async function loadAll(sb: OverlaySandbox, ids: string[]) {
    const done = Promise.all(ids.map((id, i) => sb.load(load(id, "abcdefgh"[i]))));
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }

  it("three ~900 ms renders posted at once all answer: no timeout, no restart", async () => {
    const ids = ["o1", "o2", "o3"];
    const w = serialWorker({ render: { o1: 900, o2: 900, o3: 900 } });
    w.boot();
    await loadAll(w.sb, ids);
    for (const id of ids) expect(w.sb.render(render(id))).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3 * 900 + 10);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.commands()).toEqual([]);
    expect(w.events.onLayer.mock.calls.map(([m]) => m.id)).toEqual(ids);
    for (const id of ids) expect(w.sb.isDropped(id)).toBe(false);
    w.sb.destroy();
  });

  it("a genuinely wedged head still times out at 2 s, and the renders queued behind it go through after the restart", async () => {
    const wedged = new Set<string>();
    const w = serialWorker({ render: { o2: 100, o3: 100 } }, wedged);
    w.boot();
    await loadAll(w.sb, ["o1", "o2", "o3"]);
    await warmAll(w.sb, ["o1", "o2", "o3"], 100);
    wedged.add("o1");
    for (const id of ["o1", "o2", "o3"]) w.sb.render(render(id));
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS); // the head, not a sibling behind it
    expect(w.commands()).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    expect(w.sb.isDropped("o1")).toBe(true);

    // The supervisor's fresh worker: the survivors are replayed and render.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.sb.isLoaded("o2") && w.sb.isLoaded("o3")).toBe(true);
    expect(w.sb.render(render("o1"))).toBe(-1);
    expect(w.sb.render(render("o2"))).toBeGreaterThan(0);
    expect(w.sb.render(render("o3"))).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(w.events.onLayer.mock.calls.slice(3).map(([m]) => m.id)).toEqual(["o2", "o3"]);
    expect(w.events.onTimeout).toHaveBeenCalledTimes(1);
    w.sb.destroy();
  });

  it("N bodies loading ~1.5 s each at startup, and again in the restart replay, never time out a load", async () => {
    const ids = ["o1", "o2", "o3", "o4", "o5"];
    const cost = Object.fromEntries(ids.map((id) => [id, 1500]));
    const w = serialWorker({ load: cost });
    // Issued before the first ready, as the preview does on mount.
    const loadsDone = Promise.all(ids.map((id, i) => w.sb.load(load(id, "abcde"[i]))));
    w.boot();
    await vi.advanceTimersByTimeAsync(ids.length * 1500 + 10); // 7.5 s: the 5th would have timed out at 5 s
    await loadsDone;
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    for (const id of ids) expect(w.sb.isLoaded(id)).toBe(true);

    // A restart (a supervisor-side respawn) replays all five the same way.
    w.boot();
    await vi.advanceTimersByTimeAsync(ids.length * 1500 + 10);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.commands()).toEqual([]);
    for (const id of ids) expect(w.sb.isLoaded(id)).toBe(true);
    w.sb.destroy();
  });

  it("a queued request's clock starts only when the one before it answers — a wedge right behind a slow sibling is caught 2 s later, not sooner", async () => {
    const wedged = new Set<string>();
    const w = serialWorker({ render: { o1: 1900 } }, wedged);
    w.boot();
    await loadAll(w.sb, ["o1", "o2"]);
    await warmAll(w.sb, ["o1", "o2"], 1900);
    wedged.add("o2");
    w.sb.render(render("o1"));
    w.sb.render(render("o2"));
    await vi.advanceTimersByTimeAsync(1900 + RENDER_TIMEOUT_MS - 1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o2", "render", RENDER_TIMEOUT_MS);
    expect(w.sb.isDropped("o1")).toBe(false);
    w.sb.destroy();
  });

  it("a wedge on a request nobody waits for any more (its overlay removed) restarts the worker but blames and drops no one", async () => {
    const wedged = new Set<string>();
    const w = serialWorker({}, wedged);
    w.boot();
    await loadAll(w.sb, ["o1", "o2"]);
    wedged.add("o1");
    w.sb.render(render("o1"));
    w.sb.dispose("o1");
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // o1's first render: the load budget
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.commands()).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    expect(w.sb.isDropped("o2")).toBe(false);
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.sb.isLoaded("o2")).toBe(true);
    w.sb.destroy();
  });

  // ── Fix round 1, ruling 2: the first render gets the load budget ──────────
  // A body's first render after a load warms the fresh worker up (~1.6 s on
  // SwiftShader, measured) and its first render at a new size or timeline also
  // runs the content-fit probe — the body up to PROBE_SAMPLE_COUNT more times
  // across its timeline. Both used to be timed at
  // 2 s; they get the 5 s load budget, and every later render keeps 2 s.

  it("the first render after a load gets the 5 s load budget: a 3 s warm-up render does not time out", async () => {
    const cost = { render: { o1: 3000 } };
    const w = serialWorker(cost);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    expect(w.sb.render(render("o1"))).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.commands()).toEqual([]);
    expect(w.events.onLayer).toHaveBeenCalledTimes(1);

    // The next render at the same size is warm: 2 s again.
    cost.render.o1 = 2500;
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS);
    w.sb.destroy();
  });

  it("the first render at a NEW size gets the load budget (the content-fit probe runs the body again); a new pixel ratio alone does not", async () => {
    const cost = { render: { o1: 100 } };
    const w = serialWorker(cost);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(110); // warm at 100 × 50

    cost.render.o1 = 3000;
    w.sb.render({ ...render("o1"), size: { width: 200, height: 50 } });
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.events.onLayer).toHaveBeenCalledTimes(2);

    // Same size, sharper backing store: the worker's fit is keyed on the box
    // size and the timeline, not the pixel ratio, so the probe does not run
    // and the render is warm.
    w.sb.render({ ...render("o1"), size: { width: 200, height: 50 }, pixelRatio: 2 });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS);
    w.sb.destroy();
  });

  it("the first render on a NEW timeline (a trim or retime) gets the load budget — the worker re-probes the fit over it", async () => {
    const cost = { render: { o1: 100 } };
    const w = serialWorker(cost);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(110); // warm on the 1 s timeline

    // Another frame of the same timeline: warm, 2 s.
    cost.render.o1 = 100;
    w.sb.render({ ...render("o1"), frame: 12, time: { ...timing, frame: 12, time: 0.4, progress: 0.4 } });
    await vi.advanceTimersByTimeAsync(110);

    // Trimmed to 4 s: the worker's fit key changed, so the probe runs again.
    cost.render.o1 = 3000;
    const retimed = { ...render("o1"), time: { ...timing, totalFrames: 120, duration: 4 } };
    w.sb.render(retimed);
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.events.onLayer).toHaveBeenCalledTimes(3);

    // …and the next render on that timeline is warm again.
    w.sb.render(retimed);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS);
    w.sb.destroy();
  });

  it("a keyframed-size segment: its first frame is budgeted for every fit it may measure (ends + midpoints), the rest of it is warm", async () => {
    const cost = { render: { o1: 100 } };
    const w = serialWorker(cost);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    const fitSegment = { from: { width: 100, height: 50 }, to: { width: 200, height: 50 } };
    // At 100 × 50 the path is 100, 200, 150, 125, 113 — five fits the worker
    // may measure (it stops halving once a midpoint agrees): 5 s + 4 × 3 s.
    const budget = LOAD_TIMEOUT_MS + 4 * PROBE_EXTRA_BUDGET_MS;
    cost.render.o1 = budget - 500;
    w.sb.render({ ...render("o1"), size: { width: 100, height: 50 }, fitSegment });
    await vi.advanceTimersByTimeAsync(budget - 490);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    // The static hold at the segment's end size reuses the `to` fit: warm.
    cost.render.o1 = 100;
    w.sb.render({ ...render("o1"), size: { width: 200, height: 50 } });
    await vi.advanceTimersByTimeAsync(110);
    // Back into the segment on the same path (113 × 50 halves the same way): warm, 2 s.
    cost.render.o1 = 2500;
    w.sb.render({ ...render("o1"), size: { width: 113, height: 50 }, fitSegment });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS);
    w.sb.destroy();
  });

  it("new caption words are a first render: the worker re-probes the fit with them", async () => {
    const cost = { render: { o1: 100 } };
    const w = serialWorker(cost);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    w.sb.render({ ...render("o1"), words: [{ text: "a", start: 0, end: 0.2 }] });
    await vi.advanceTimersByTimeAsync(110);
    cost.render.o1 = 3000;
    w.sb.render({ ...render("o1"), words: [{ text: "a", start: 0, end: 0.2 }, { text: "b", start: 0.2, end: 0.4 }] });
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    w.sb.destroy();
  });

  it("a genuinely wedged body is still caught within 5 s on its first render", async () => {
    const wedged = new Set<string>();
    const w = serialWorker({}, wedged);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    wedged.add("o1");
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", LOAD_TIMEOUT_MS);
    expect(w.commands()).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    expect(w.sb.isDropped("o1")).toBe(true);
    w.sb.destroy();
  });

  it("a genuinely wedged body is caught at 2 s on any later render at a size it has rendered", async () => {
    const wedged = new Set<string>();
    const w = serialWorker({ render: { o1: 100 } }, wedged);
    w.boot();
    await loadAll(w.sb, ["o1"]);
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(110);
    wedged.add("o1");
    w.sb.render({ ...render("o1"), frame: 1 });
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.events.onTimeout).toHaveBeenCalledWith("o1", "render", RENDER_TIMEOUT_MS);
    w.sb.destroy();
  });

  it("a fresh worker, a new source, and a layer the worker idled out each make the next render a first render again", async () => {
    const cost = { render: { o1: 100, o2: 100 } };
    const w = serialWorker(cost);
    w.boot();
    await loadAll(w.sb, ["o1", "o2"]);
    w.sb.render(render("o1"));
    w.sb.render(render("o2"));
    await vi.advanceTimersByTimeAsync(210); // both warm

    // A restart: the replayed body lands on a fresh worker.
    w.boot();
    await vi.advanceTimersByTimeAsync(10);
    cost.render.o1 = 3000;
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();

    // A new source for o1: the worker builds a new entry, with no fit cached.
    const pb = w.sb.load(load("o1", "f"));
    await vi.advanceTimersByTimeAsync(10);
    await pb;
    w.sb.render(render("o1"));
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();

    // o2 left unrendered for as long as the worker keeps a layer: its fit is
    // gone and the next render probes again.
    w.sb.render(render("o2"));
    await vi.advanceTimersByTimeAsync(110);
    await vi.advanceTimersByTimeAsync(IDLE_LAYER_MS);
    cost.render.o2 = 3000;
    w.sb.render(render("o2"));
    await vi.advanceTimersByTimeAsync(3010);
    expect(w.events.onTimeout).not.toHaveBeenCalled();
    expect(w.commands()).toEqual([]);
    w.sb.destroy();
  });
});

describe("OverlaySandbox — font ride follow-ups (Task 9 re-review, Task 12b)", () => {
  const inter = { family: "Inter", weight: 700, data: new ArrayBuffer(4) };
  async function loadedWithRide() {
    const s = makeSandbox();
    const p = s.ready();
    const pa = s.sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pa;
    s.sb.setFonts([inter]); // rides a same-hash load of o1
    expect(p.posted.at(-1)?.msg).toMatchObject({ t: "load", id: "o1", sourceHash: HASH_A });
    return { ...s, p };
  }

  it("a ride answered after its overlay was removed does not mark it loaded: an undo of the same source is posted again", async () => {
    const { sb, p } = await loadedWithRide();
    sb.dispose("o1");
    expect(p.posted.at(-1)?.msg).toEqual({ t: "dispose", id: "o1" });
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A }); // the ride's answer
    expect(sb.isLoaded("o1")).toBe(false);
    const undo = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p)).toEqual(["o1", "o1", "o1"]); // first load, ride, and the undo's re-post
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await undo;
    expect(sb.isLoaded("o1")).toBe(true);
    sb.destroy();
  });

  it("a ride's answer does not settle a same-hash re-post queued behind it", async () => {
    const { sb, p } = await loadedWithRide();
    sb.dispose("o1");
    const repost = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void repost.then(() => { settled = true; });
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A }); // the ride's
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(sb.isLoaded("o1")).toBe(false); // the worker is about to dispose it
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A }); // the re-post's
    await repost;
    expect(sb.isLoaded("o1")).toBe(true);
    sb.destroy();
  });

  it("says when a posted font set is installed — on the loaded of the load that carried it", async () => {
    const f = fakeFactory();
    const onFontsInstalled = vi.fn();
    const sb = new OverlaySandbox({
      createTransport: f.createTransport, nonce: () => "nonce-1", onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onFontsInstalled,
    });
    const p = fakePort();
    f.created[0].reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: p.port });
    sb.setFonts([inter]);
    const pa = sb.load(loadA); // carries the fonts
    await vi.advanceTimersByTimeAsync(0);
    const pb = sb.load({ ...loadA, id: "o2", sourceHash: HASH_B }); // does not
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o2", sourceHash: HASH_B });
    await pb;
    expect(onFontsInstalled).not.toHaveBeenCalled();
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pa;
    expect(onFontsInstalled).toHaveBeenCalledTimes(1);
    sb.setFonts([inter, { family: "x", weight: 400, data: new ArrayBuffer(2) }]); // a ride
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    expect(onFontsInstalled).toHaveBeenCalledTimes(2);
    sb.destroy();
  });
});

describe("OverlaySandbox — Task 12b review, fix round 2", () => {
  /** o1 loaded with body A and warm (one render answered). */
  async function warmA() {
    const s = makeSandbox();
    const p = s.ready();
    const pa = s.sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pa;
    const r = s.sb.render(renderO1);
    p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 0, req: r, bitmap: bitmap() });
    return { ...s, p };
  }

  it("I1: a render posted after a newer load but before its `loaded` is charged to the NEW body — its wedge drops it and says so", async () => {
    const { sb, p, events, frame, ready } = await warmA();
    const inFlight = sb.render({ ...renderO1, frame: 1 }); // A's render, still owed
    // The agent saves a looping body B. A 2D body with no fonts compiles
    // synchronously in the worker, so everything posted after this runs B.
    const pb = sb.load({ ...loadA, source: "while (true) {}", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    // A's render answers; the preview asks for the next frame before `loaded{B}`.
    p.deliver({ t: "layer", nonce: "nonce-1", id: "o1", frame: 1, req: inFlight, bitmap: bitmap() });
    const racing = sb.render({ ...renderO1, frame: 2 });
    expect(racing).toBeGreaterThan(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_B });
    await pb;
    p.deliver({ t: "started", nonce: "nonce-1", id: "o1", req: racing });
    // `racing` runs B, which never returns. Its budget is a first render's.
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
    expect(events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onTimeout).toHaveBeenCalledTimes(1);
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "render", LOAD_TIMEOUT_MS);
    expect(sb.isDropped("o1")).toBe(true); // B is dropped: the replay will not load it again
    expect(frame().commands).toEqual([{ t: "restart", nonce: "nonce-1" }]);
    // The fresh worker gets nothing for o1, so there is no second, silent restart.
    const p2 = ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(loads(p2)).toEqual([]);
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
    expect(frame().commands).toHaveLength(1);
    sb.destroy();
  });

  it("M2: a load that carried the fonts and failed to compile still says the fonts are installed (the worker installs before it compiles)", async () => {
    const f = fakeFactory();
    const onFontsInstalled = vi.fn();
    const sb = new OverlaySandbox({
      createTransport: f.createTransport, nonce: () => "nonce-1", onLayer: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onFontsInstalled,
    });
    const p = fakePort();
    f.created[0].reply({ t: "ready", nonce: "nonce-1", version: PROTOCOL_VERSION, port: p.port });
    sb.setFonts([{ family: "Inter", weight: 700, data: new ArrayBuffer(4) }]);
    const pa = sb.load({ ...loadA, source: "return (" }); // carries the fonts
    pa.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect((p.posted.at(-1)?.msg as { fonts?: unknown[] }).fonts).toHaveLength(1);
    p.deliver({ t: "error", nonce: "nonce-1", id: "o1", phase: "compile", message: "Unexpected end of input", sourceHash: HASH_A });
    await expect(pa).rejects.toThrow("Unexpected end of input");
    expect(onFontsInstalled).toHaveBeenCalledTimes(1);
    sb.destroy();
  });

  it("M3: the worker answers a render queued BEHIND an async load first (it renders while a load awaits fonts) — the render leaves the queue, the load's clock is untouched", async () => {
    const { sb, ready, events } = makeSandbox();
    const p = ready();
    const p2 = sb.load({ ...loadA, id: "o2", sourceHash: HASH_B });
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o2", sourceHash: HASH_B });
    await p2;
    const p1 = sb.load(loadA); // at the head, its 5 s clock running
    p1.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const r = sb.render({ ...renderO1, id: "o2" }); // behind it
    await vi.advanceTimersByTimeAsync(3000);
    p.deliver({ t: "layer", nonce: "nonce-1", id: "o2", frame: 0, req: r, bitmap: bitmap() }); // answered out of order
    expect(events.onLayer).toHaveBeenCalledTimes(1);
    // The head's clock was not re-armed by an answer behind it: o1's load
    // still times out 5 s after IT started, not 5 s after the layer.
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 3000 - 1);
    expect(events.onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onTimeout).toHaveBeenCalledWith("o1", "load", LOAD_TIMEOUT_MS);
    sb.destroy();
  });
});

describe("OverlaySandbox — render geometry caps (Task 12b)", () => {
  it("clamps an oversized render before posting, so the worker's parser never refuses it", async () => {
    const { sb, ready } = makeSandbox();
    const p = ready();
    const pr = sb.load(loadA);
    await vi.advanceTimersByTimeAsync(0);
    p.deliver({ t: "loaded", nonce: "nonce-1", id: "o1", sourceHash: HASH_A });
    await pr;
    const req = sb.render({ ...renderO1, size: { width: 20000, height: 100 }, pixelRatio: 16 });
    expect(req).toBeGreaterThan(0);
    const posted = p.posted.at(-1)!.msg;
    expect(parseHostMessage(posted)).not.toBeNull();
    expect(posted).toMatchObject({ t: "render", size: { width: MAX_LAYER_SIDE, height: 100 } });
    expect((posted as { pixelRatio: number }).pixelRatio).toBeLessThanOrEqual(MAX_LAYER_PIXEL_RATIO);
    sb.destroy();
  });
});

describe("createIframeTransport", () => {
  it("builds the iframe exactly as spec §4.1 says and posts commands to its window", () => {
    const mount = document.createElement("div");
    const t = createIframeTransport(mount, "abc");
    const iframe = mount.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("allow")).toBe("");
    expect(iframe.getAttribute("loading")).toBe("eager");
    expect(iframe.getAttribute("aria-hidden")).toBe("true");
    expect(iframe.getAttribute("src")).toBe("/sandbox/overlay-runtime#n=abc");
    expect(t.peer).toBe(iframe.contentWindow);
    t.destroy();
    expect(mount.querySelector("iframe")).toBeNull();
  });
  it("reports the frame's document load (R-M4) — to a handler set before or after it — and stops on destroy", () => {
    const mount = document.createElement("div");
    const t = createIframeTransport(mount, "abc");
    const iframe = mount.querySelector("iframe")!;
    const before = vi.fn();
    t.onLoad!(before);
    expect(before).not.toHaveBeenCalled();
    iframe.dispatchEvent(new Event("load"));
    expect(before).toHaveBeenCalledTimes(1);
    const after = vi.fn();
    t.onLoad!(after);
    expect(after).toHaveBeenCalledTimes(1);
    t.destroy();
    iframe.dispatchEvent(new Event("load"));
    expect(after).toHaveBeenCalledTimes(1);
  });
});
