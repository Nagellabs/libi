// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Composition, Overlay } from "@/lib/engine/types";
import type { LayerRequest } from "@/lib/engine/layer-source";
import { PROTOCOL_VERSION, type HostMessage } from "@/lib/sandbox/protocol";
import { FRAME_STARTING_MESSAGE, FRAME_STARTING_NOTICE_MS, RENDER_TIMEOUT_MS, type SandboxTransport } from "@/lib/sandbox/host";
import { createRenderDiagnosticsStore } from "@/lib/preview/render-diagnostics";

// One fake iframe leg per sandbox, reachable from the tests. `posted` fills
// from the fake MessagePorts the test hands over in `ready` (A1: load/render go
// on the port, not the iframe channel); `restart()` answers a second `ready`
// with a fresh port, as the supervisor does after respawning the worker.
interface FakePort {
  postMessage(m: HostMessage): void;
  start(): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
interface FakeTransport {
  posted: HostMessage[];
  reply(d: unknown): void;
  deliver(d: unknown): void;
  restart(): Promise<void>;
  nonce: string;
  port: FakePort;
  destroyed: boolean;
  /** The frame's document finished loading (only with `transportMode.withLoad`). */
  load(): void;
}
const transports: FakeTransport[] = [];
// Off: the frame is held to the boot deadline from mount, as the in-origin
// leg is. On: it reports its document's `load`, as the real iframe does.
const transportMode = vi.hoisted(() => ({ withLoad: false }));
vi.mock("@/lib/sandbox/iframe-transport", () => ({
  createIframeTransport: (_mount: HTMLElement, nonce: string): SandboxTransport => {
    let handler: ((d: unknown, s: unknown) => void) | null = null;
    let onLoad: (() => void) | null = null;
    const peer = {};
    const makePort = (): FakePort => ({
      postMessage: (m: HostMessage) => {
        t.posted.push(m);
      },
      start() {},
      close() {},
      onmessage: null,
    });
    const t: FakeTransport = {
      posted: [],
      reply: (d: unknown) => handler?.(d, peer),
      deliver: (d: unknown) => t.port.onmessage?.({ data: d }),
      restart: async () => {
        t.port = makePort();
        t.reply({ t: "ready", nonce, version: PROTOCOL_VERSION, port: t.port });
      },
      nonce,
      port: makePort(),
      destroyed: false,
      load: () => onLoad?.(),
    };
    transports.push(t);
    return {
      command: vi.fn(),
      onReply: (h) => {
        handler = h;
      },
      ...(transportMode.withLoad
        ? {
            onLoad: (h: () => void) => {
              onLoad = h;
            },
          }
        : {}),
      peer,
      destroy: () => {
        t.destroyed = true;
      },
    };
  },
}));
// What the next reconcile's font collection returns (or throws).
const fontState = vi.hoisted(() => ({ fonts: [] as Array<{ family: string; weight: number; data: ArrayBuffer }>, fail: null as Error | null }));
vi.mock("@/lib/sandbox/fonts", () => ({
  collectSandboxFonts: async () => {
    if (fontState.fail) throw fontState.fail;
    return fontState.fonts;
  },
}));

import { useOverlayLayers, type UseOverlayLayersOptions } from "@/hooks/preview/use-overlay-layers";
import { useOverlayImages } from "@/hooks/preview/use-overlay-images";
import { sha256Hex } from "@/lib/sandbox/hash";

function comp(overlays: Overlay[]): Composition {
  return { id: "c", name: "c", width: 100, height: 100, fps: 30, overlays } as unknown as Composition;
}
const code = (id: string, drawFunction: string): Overlay =>
  ({ id, kind: "code", drawFunction, startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 1, opacity: 1 }) as unknown as Overlay;
const three = (id: string, sceneFunction: string, cameraPreset = "billboard"): Overlay =>
  ({ id, kind: "three", sceneFunction, cameraPreset, startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 1, opacity: 1 }) as unknown as Overlay;
const image = (id: string, fileId: string): Overlay =>
  ({ id, kind: "image", fileId, startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 1, opacity: 1 }) as unknown as Overlay;
const text = (id: string): Overlay =>
  ({ id, kind: "text", content: "x", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 1, opacity: 1 }) as unknown as Overlay;

const layerReq = (frame: number, extra: Partial<LayerRequest> = {}): LayerRequest => ({
  overlayId: "o1",
  kind: "code",
  frame,
  size: { width: 100, height: 100 },
  pixelRatio: 1,
  fps: 30,
  time: { frame, time: frame / 30, totalFrames: 150, duration: 5, progress: frame / 150 },
  ...extra,
});

/** Lets the hook's async reconcile finish: `sha256Hex` goes through
 *  `crypto.subtle`, which settles on a macrotask, not a microtask. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function ready() {
  const t = transports.at(-1)!;
  await act(async () => {
    t.reply({ t: "ready", nonce: t.nonce, version: PROTOCOL_VERSION, port: t.port });
  });
}

type Props = { c: Composition | null; opts?: Partial<UseOverlayLayersOptions> };
function mount(c: Composition | null, opts: Partial<UseOverlayLayersOptions> = {}) {
  return renderHook<ReturnType<typeof useOverlayLayers>, Props>(({ c, opts }) => useOverlayLayers(c, { images: {}, ...opts }), {
    initialProps: { c, opts },
  });
}

/** Mounts with one loaded code overlay `o1` (source "1;"). */
async function mountLoaded(opts: Partial<UseOverlayLayersOptions> = {}) {
  const hook = mount(comp([code("o1", "1;")]), opts);
  await ready();
  await flush();
  const t = transports[0];
  await act(async () => {
    t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("1;") });
  });
  return { ...hook, t };
}

/** An `<img>` the preview has finished decoding. */
function decoded(img: HTMLImageElement = document.createElement("img")): HTMLImageElement {
  Object.defineProperty(img, "complete", { configurable: true, value: true });
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: 10 });
  return img;
}
type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };
/** Stubs createImageBitmap (jsdom has none). The hook's own decode comes
 *  first, then the host's per-load clone — `made` records both in order. */
function stubBitmaps(): FakeBitmap[] {
  const made: FakeBitmap[] = [];
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      const b = { width: 1, height: 1, close: vi.fn() };
      made.push(b);
      return b;
    }),
  );
  return made;
}
const loadsOf = (t: FakeTransport) => t.posted.filter((m): m is Extract<HostMessage, { t: "load" }> => m.t === "load");
const renders = (t: FakeTransport) => t.posted.filter((m): m is Extract<HostMessage, { t: "render" }> => m.t === "render");

beforeEach(() => {
  transports.length = 0;
  transportMode.withLoad = false;
  fontState.fonts = [];
  fontState.fail = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useOverlayLayers", () => {
  it("loads each body once per source hash and exposes a LayerSource", async () => {
    const { result, rerender } = mount(comp([code("o1", "1;")]));
    await ready();
    await flush();
    const t = transports[0];
    const loads = t.posted.filter((m) => m.t === "load");
    expect(loads).toHaveLength(1);
    expect((loads[0] as { sourceHash: string }).sourceHash).toBe(await sha256Hex("1;"));
    expect(result.current.layers).not.toBeNull();

    rerender({ c: comp([code("o1", "1;")]) }); // new identity, same source
    await flush();
    expect(t.posted.filter((m) => m.t === "load")).toHaveLength(1);

    rerender({ c: comp([code("o1", "2;")]) });
    await flush();
    expect(t.posted.filter((m) => m.t === "load")).toHaveLength(2);
  });

  it("boots no sandbox for a piece without body overlays, and one on the first body", async () => {
    const { result, rerender } = mount(comp([text("t1")]));
    await flush();
    expect(transports).toHaveLength(0);
    expect(result.current.layers).not.toBeNull(); // a stable source the player can subscribe to
    rerender({ c: comp([text("t1"), code("o1", "1;")]) });
    await flush();
    expect(transports).toHaveLength(1);
  });

  it("returns no source and boots nothing when disabled", async () => {
    const { result } = mount(comp([code("o1", "1;")]), { enabled: false });
    await flush();
    expect(result.current.layers).toBeNull();
    expect(transports).toHaveLength(0);
  });

  it("surfaces a compile error in `errors` and clears it when the source is fixed", async () => {
    const onDiagnostic = vi.fn();
    const onDiagnosticCleared = vi.fn();
    const { result, rerender } = mount(comp([code("o1", "bad (")]), { onDiagnostic, onDiagnosticCleared });
    await ready();
    await flush();
    const t = transports[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "compile", message: "Unexpected token" });
    });
    expect(result.current.errors.o1).toBe("Unexpected token");
    expect(result.current.loadedBodies.has("o1")).toBe(false);
    expect(onDiagnostic).toHaveBeenCalledWith({ overlayId: "o1", kind: "code", phase: "compile", message: "Unexpected token", line: undefined, column: undefined });
    rerender({ c: comp([code("o1", "1;")]), opts: { onDiagnostic, onDiagnosticCleared } });
    await flush();
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("1;") });
    });
    expect(result.current.errors.o1).toBeUndefined();
    expect(result.current.loadedBodies.has("o1")).toBe(true);
    expect(onDiagnosticCleared).toHaveBeenCalledWith("o1");
  });

  it("formats a mapped line and column into the badge message", async () => {
    const { result, t } = await mountLoaded();
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "nope is not defined", line: 1, column: 1 });
    });
    expect(result.current.errors.o1).toBe("nope is not defined (line 1:1)");
  });

  it("a body throwing on every frame does not republish an unchanged error map", async () => {
    const { result, t } = await mountLoaded();
    const deliver = () => t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom" });
    await act(async () => deliver());
    const first = result.current.errors;
    await act(async () => deliver());
    expect(result.current.errors).toBe(first);
  });

  it("ignores a late error from a load the host already superseded", async () => {
    const { result, rerender, t } = await mountLoaded();
    const staleHash = await sha256Hex("1;");
    rerender({ c: comp([code("o1", "2;")]) });
    await flush();
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "build", message: "old", sourceHash: staleHash });
    });
    expect(result.current.errors.o1).toBeUndefined();
  });

  it("a layer arrival notifies the source's subscribers (the player repaints)", async () => {
    const { result, t } = await mountLoaded();
    const listener = vi.fn();
    result.current.layers!.subscribe(listener);
    result.current.layers!.request(layerReq(2));
    const render = renders(t)[0];
    expect(render).toBeTruthy();
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 2, req: render.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(result.current.layers!.get("o1", 2)?.frame).toBe(2);
  });

  it("forwards EVERY request field to the render, pad included", async () => {
    const { result, t } = await mountLoaded();
    const pad = { left: 5, top: 6, right: 7, bottom: 8 };
    const words = [{ text: "hi", start: 0, end: 1 }];
    result.current.layers!.request(layerReq(2, { kind: "tracked", pad, words, pixelRatio: 2 }));
    expect(renders(t)[0]).toMatchObject({ id: "o1", frame: 2, pad, words, pixelRatio: 2, fps: 30, size: { width: 100, height: 100 } });
    expect(renders(t)[0]).not.toHaveProperty("overlayId");
    expect(renders(t)[0]).not.toHaveProperty("kind");
  });

  it("a load completing repaints, so a frame drawn before the body could render asks again", async () => {
    const listener = vi.fn();
    const { result } = mount(comp([code("o1", "1;")]));
    result.current.layers!.subscribe(listener);
    await ready();
    await flush();
    const t = transports[0];
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("1;") });
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a paused preview re-renders the same frame once a NEW body for the overlay has loaded", async () => {
    const { result, rerender, t } = await mountLoaded();
    const layers = result.current.layers!;
    layers.request(layerReq(0));
    const r = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 0, req: r.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    layers.request(layerReq(0));
    expect(renders(t)).toHaveLength(1); // same request, same body: no work
    rerender({ c: comp([code("o1", "2;")]) });
    await flush();
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("2;") });
    });
    layers.request(layerReq(0));
    expect(renders(t)).toHaveLength(2);
  });

  it("an error that answers a render frees the overlay for the next request", async () => {
    const { result, t } = await mountLoaded();
    result.current.layers!.request(layerReq(2));
    const r = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", req: r.req });
    });
    result.current.layers!.request(layerReq(2));
    expect(renders(t)).toHaveLength(2);
  });

  it("a tagged async error with no `req` does NOT drop the render in flight", async () => {
    const { result, t } = await mountLoaded();
    result.current.layers!.request(layerReq(2));
    const r = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "escaped a promise" });
    });
    expect(result.current.errors.o1).toBe("escaped a promise");
    result.current.layers!.request(layerReq(3)); // queued behind the render still out
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 2, req: r.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(result.current.layers!.get("o1", 3)?.frame).toBe(2);
    expect(renders(t).map((m) => m.frame)).toEqual([2, 3]);
  });

  it("a clean render of a DIFFERENT frame does not clear a render error — the body still throws there (Task 11 fix I3)", async () => {
    const onDiagnosticCleared = vi.fn();
    const { result, t } = await mountLoaded({ onDiagnosticCleared });
    const layers = result.current.layers!;
    layers.request(layerReq(40));
    const failed = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", line: 2, column: 5, req: failed.req });
    });
    onDiagnosticCleared.mockClear();
    layers.request(layerReq(10));
    const clean = renders(t)[1];
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 10, req: clean.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(result.current.errors.o1).toBe("boom (line 2:5)");
    expect(onDiagnosticCleared).not.toHaveBeenCalled();
  });

  it("the SAME frame rendering cleanly later clears the render error, and a repeat is reported again (Task 11)", async () => {
    const onDiagnostic = vi.fn();
    const onDiagnosticCleared = vi.fn();
    const { result, t } = await mountLoaded({ onDiagnostic, onDiagnosticCleared });
    const layers = result.current.layers!;
    layers.request(layerReq(40));
    const failed = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", line: 2, column: 5, req: failed.req });
    });
    expect(result.current.errors.o1).toBe("boom (line 2:5)");
    onDiagnosticCleared.mockClear();
    // Same frame, another geometry (a resize): a render the host really sends.
    layers.request(layerReq(40, { size: { width: 50, height: 50 } }));
    const clean = renders(t)[1];
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 40, req: clean.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(result.current.errors.o1).toBeUndefined();
    expect(onDiagnosticCleared).toHaveBeenCalledExactlyOnceWith("o1");
    // The same failure again is news, not a duplicate.
    layers.request(layerReq(41));
    const again = renders(t)[2];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", line: 2, column: 5, req: again.req });
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(result.current.errors.o1).toBe("boom (line 2:5)");
  });

  it("a render error carries the composition time of the frame that failed (Task 11 fix I3)", async () => {
    const onDiagnostic = vi.fn();
    const { result, t } = await mountLoaded({ onDiagnostic });
    result.current.layers!.request(layerReq(45));
    const failed = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", req: failed.req });
    });
    // `code()` starts at 0: frame 45 of the overlay at 30 fps is 1.5 s in —
    // composition frame 45, named beside the time (Task 12b re-review 2, N1).
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ overlayId: "o1", kind: "code", phase: "render", message: "boom", line: undefined, column: undefined, time: 1.5, frame: 45 });
  });

  it("a render error on an overlay whose start is not frame-aligned names the time OF its frame (Task 12b re-review 3, N3)", async () => {
    const onDiagnostic = vi.fn();
    const late = { ...code("o1", "1;"), startTime: 0.1 } as unknown as Overlay;
    const { result } = mount(comp([late]), { onDiagnostic });
    await ready();
    await flush();
    const t = transports[0];
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("1;") });
    });
    result.current.layers!.request(layerReq(1, { fps: 24 }));
    const failed = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", req: failed.req });
    });
    // 0.1 s at 24 fps is 2.4 frames in: local frame 1 is composition frame 3,
    // whose time is 0.125 s — not 0.1 + 1/24 = 0.142 s, which renders frame 4.
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ overlayId: "o1", kind: "code", phase: "render", message: "boom", line: undefined, column: undefined, time: 0.125, frame: 3 });
  });

  it("a clean layer does NOT clear an async escape (no `req`) — it fires beside clean frames (Task 11)", async () => {
    const onDiagnosticCleared = vi.fn();
    const { result, t } = await mountLoaded({ onDiagnosticCleared });
    onDiagnosticCleared.mockClear();
    result.current.layers!.request(layerReq(2));
    const r = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "escaped a promise" });
    });
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 2, req: r.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(result.current.errors.o1).toBe("escaped a promise");
    expect(onDiagnosticCleared).not.toHaveBeenCalled();
  });

  it("a layer answering a render sent BEFORE the failed one clears nothing (Task 11)", async () => {
    const onDiagnosticCleared = vi.fn();
    const { result, t } = await mountLoaded({ onDiagnosticCleared });
    onDiagnosticCleared.mockClear();
    result.current.layers!.request(layerReq(2));
    const r = renders(t)[0];
    // An error naming a LATER request than the layer that follows it.
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", req: r.req + 1 });
    });
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 2, req: r.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(result.current.errors.o1).toBe("boom");
    expect(onDiagnosticCleared).not.toHaveBeenCalled();
  });

  it("forwards an unattributed runtime diagnostic without blaming any overlay", async () => {
    const onUnattributed = vi.fn();
    const onDiagnostic = vi.fn();
    const { result, t } = await mountLoaded({ onUnattributed, onDiagnostic });
    await act(async () => {
      t.deliver({ t: "unattributed", nonce: t.nonce, message: "font libifont-x did not install", line: 3 });
    });
    expect(onUnattributed).toHaveBeenCalledWith({ message: "font libifont-x did not install", line: 3, column: undefined });
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(result.current.errors).toEqual({});
  });

  it(`a sandbox frame still loading after ${FRAME_STARTING_NOTICE_MS / 1000} s puts "still starting" in the piece's diagnostics, and it is withdrawn when the frame loads (R2-M1)`, async () => {
    transportMode.withLoad = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = createRenderDiagnosticsStore({ pieceId: "p1", put: async () => {} });
    const onDiagnostic = vi.fn();
    const { unmount } = mount(comp([code("o1", "1;")]), {
      onDiagnostic,
      onUnattributed: (d) => store.reportUnattributed(d),
      onUnattributedCleared: (m) => store.clearUnattributed(m),
    });
    expect(transports).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_STARTING_NOTICE_MS - 1);
    });
    expect(store.snapshotUnattributed()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(store.snapshotUnattributed().map((d) => d.message)).toEqual([FRAME_STARTING_MESSAGE]);
    // Unattributed: no overlay is blamed or badged for it.
    expect(onDiagnostic).not.toHaveBeenCalled();
    await act(async () => {
      transports[0]!.load();
    });
    expect(store.snapshotUnattributed()).toEqual([]);
    unmount();
    store.dispose();
  });

  it("the still-starting notice is announced again to a new piece's store while it is up", async () => {
    transportMode.withLoad = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onUnattributed = vi.fn();
    const { rerender, unmount } = mount(comp([code("o1", "1;")]), { onUnattributed, diagnosticsKey: "piece-a" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRAME_STARTING_NOTICE_MS);
    });
    expect(onUnattributed).toHaveBeenCalledExactlyOnceWith({ message: FRAME_STARTING_MESSAGE });
    rerender({ c: comp([code("o1", "1;")]), opts: { onUnattributed, diagnosticsKey: "piece-b" } });
    expect(onUnattributed).toHaveBeenCalledTimes(2);
    expect(onUnattributed).toHaveBeenLastCalledWith({ message: FRAME_STARTING_MESSAGE });
    unmount();
  });

  it("a new diagnostics key (the piece changed) re-announces every failure still on screen — a duplicated piece's identical body is not skipped (Task 11 fix)", async () => {
    const onDiagnostic = vi.fn();
    const { rerender, t } = await mountLoaded({ onDiagnostic, diagnosticsKey: "piece-a" });
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", line: 1, column: 1 });
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    // Piece B is a duplicate: same overlay id, same body — no reload, and the
    // body's next throw is deduped. Without a re-announce B's store stays empty.
    rerender({ c: comp([code("o1", "1;")]), opts: { onDiagnostic, diagnosticsKey: "piece-b" } });
    await flush();
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ overlayId: "o1", phase: "render", message: "boom", line: 1, column: 1 }));
  });

  it("a piece switch drops the old piece's overlays before re-announcing, and their late errors land nowhere (Task 11 fix)", async () => {
    const onDiagnostic = vi.fn();
    const onDiagnosticCleared = vi.fn();
    const { rerender, t } = await mountLoaded({ onDiagnostic, onDiagnosticCleared, diagnosticsKey: "piece-a" });
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom" });
    });
    rerender({ c: comp([code("o2", "2;")]), opts: { onDiagnostic, onDiagnosticCleared, diagnosticsKey: "piece-b" } });
    await flush();
    expect(onDiagnostic).toHaveBeenCalledTimes(1); // o1 is not piece B's: not re-announced
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "late from piece A" });
    });
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("after a worker restart, frees every slot and repaints once the replayed body is loaded — without a second load post", async () => {
    const { result, t } = await mountLoaded();
    const listener = vi.fn();
    result.current.layers!.subscribe(listener);
    result.current.layers!.request(layerReq(1));
    expect(renders(t)).toHaveLength(1);
    await act(async () => {
      await t.restart();
    });
    await flush();
    expect(t.posted.filter((m) => m.t === "load")).toHaveLength(2); // the original + ONE replay
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("1;") });
    });
    expect(listener).toHaveBeenCalledTimes(1);
    result.current.layers!.request(layerReq(1));
    expect(renders(t)).toHaveLength(2);
  });

  it("re-posts a three body whose camera preset changed although its source did not", async () => {
    const { rerender } = mount(comp([three("o3", "return {};", "billboard")]));
    await ready();
    await flush();
    const t = transports[0];
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o3", sourceHash: await sha256Hex("return {};") });
    });
    expect(t.posted.filter((m) => m.t === "load")[0]).toMatchObject({ kind: "three", three: { cameraPreset: "billboard", pixelRatio: 1 } });
    rerender({ c: comp([three("o3", "return {};", "ground")]) });
    await flush();
    const kinds = t.posted.map((m) => m.t);
    expect(kinds.slice(-2)).toEqual(["dispose", "load"]);
    expect(t.posted.at(-1)).toMatchObject({ three: { cameraPreset: "ground" } });
  });

  it("disposes a removed overlay and destroys the sandbox on unmount", async () => {
    const { result, rerender, unmount, t } = await mountLoaded();
    expect(result.current.loadedBodies.has("o1")).toBe(true);
    rerender({ c: comp([]) });
    await flush();
    expect(t.posted.some((m) => m.t === "dispose" && m.id === "o1")).toBe(true);
    expect(result.current.loadedBodies.has("o1")).toBe(false);
    expect(transports).toHaveLength(1); // the sandbox stays up for the next body
    unmount();
    expect(t.destroyed).toBe(true);
  });

  // ── Task 9 fix round 1 ─────────────────────────────────────────────────────

  it("a camera-preset change while a render is OUT re-renders once the re-posted body lands (I1)", async () => {
    const { result, rerender } = mount(comp([three("o3", "return {};", "billboard")]));
    await ready();
    await flush();
    const t = transports[0];
    const hash = await sha256Hex("return {};");
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o3", sourceHash: hash });
    });
    const layers = result.current.layers!;
    layers.request(layerReq(1, { overlayId: "o3", kind: "three" }));
    expect(renders(t)).toHaveLength(1); // out, never answered: the dispose abandons it
    rerender({ c: comp([three("o3", "return {};", "ground")]) });
    await flush();
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o3", sourceHash: hash });
    });
    layers.request(layerReq(1, { overlayId: "o3", kind: "three" }));
    expect(renders(t)).toHaveLength(2);
  });

  it("an image that finishes decoding AFTER the body first loaded reaches the loadImage body (I2)", async () => {
    stubBitmaps();
    const c = comp([image("i1", "f1"), code("o1", "const im = loadImage('f1');")]);
    const { result } = renderHook(
      ({ c }: { c: Composition }) => {
        const { images } = useOverlayImages(c);
        return { images, ...useOverlayLayers(c, { images }) };
      },
      { initialProps: { c } },
    );
    await ready();
    await flush();
    const t = transports[0];
    expect(loadsOf(t)).toHaveLength(1);
    expect(Object.keys(loadsOf(t)[0].images ?? {})).toEqual([]); // still decoding
    const img = decoded(result.current.images.i1);
    await act(async () => {
      img.dispatchEvent(new Event("load"));
    });
    await flush();
    const last = loadsOf(t).at(-1)!;
    expect(last.id).toBe("o1");
    expect(Object.keys(last.images ?? {})).toEqual(["f1"]);
  });

  it("an error for an OLDER render does not free the newer one in flight (minor 1)", async () => {
    const { result, t } = await mountLoaded();
    const layers = result.current.layers!;
    layers.request(layerReq(2));
    const r1 = renders(t)[0];
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", req: r1.req });
    });
    layers.request(layerReq(4));
    const r2 = renders(t)[1];
    expect(r2.frame).toBe(4);
    await act(async () => {
      t.deliver({ t: "error", nonce: t.nonce, id: "o1", phase: "render", message: "boom", req: r1.req }); // late, stale
    });
    layers.request(layerReq(5)); // must wait behind r2, not be lost
    await act(async () => {
      t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 4, req: r2.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    expect(renders(t).map((m) => m.frame)).toEqual([2, 4, 5]);
  });

  it("a render timeout says 'timed out after 2 s', frees every other render, and blames no rejected load (minor 7)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tick = async () => {
      await act(async () => {
        for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      });
    };
    const onDiagnostic = vi.fn();
    const { result, rerender, unmount } = mount(comp([code("o1", "1;"), code("o2", "2;")]), { onDiagnostic });
    await ready();
    await tick();
    const t = transports[0];
    expect(loadsOf(t)).toHaveLength(2);
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("1;") });
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o2", sourceHash: await sha256Hex("2;") });
    });
    const layers = result.current.layers!;
    // Each body's first render gets the load budget (fix round 1, ruling 2):
    // answer one render each so the next is timed at 2 s.
    layers.request(layerReq(0));
    layers.request(layerReq(0, { overlayId: "o2" }));
    await act(async () => {
      for (const r of renders(t)) t.deliver({ t: "layer", nonce: t.nonce, id: r.id, frame: 0, req: r.req, bitmap: { width: 1, height: 1, close() {} } });
    });
    layers.request(layerReq(1));
    layers.request(layerReq(1, { overlayId: "o2" }));
    expect(renders(t)).toHaveLength(4);
    // o1's body is entered and never returns.
    const wedged = renders(t)[2];
    expect(wedged.id).toBe("o1");
    t.deliver({ t: "started", nonce: t.nonce, id: "o1", req: wedged.req });
    // A third body arrives; its load queues behind the two renders and stays pending.
    rerender({ c: comp([code("o1", "1;"), code("o2", "2;"), code("o3", "3;")]), opts: { onDiagnostic } });
    await tick();
    expect(loadsOf(t)).toHaveLength(3);
    await act(async () => {
      vi.advanceTimersByTime(RENDER_TIMEOUT_MS);
    });
    await tick();
    expect(result.current.errors.o1).toBe("timed out after 2 s");
    expect(onDiagnostic).toHaveBeenCalledWith({ overlayId: "o1", kind: "code", phase: "render", message: "timed out after 2 s", line: undefined, column: undefined });
    // o3's pending load was rejected by the restart, which explains it (epoch).
    expect(result.current.errors.o3).toBeUndefined();
    expect(onDiagnostic).toHaveBeenCalledTimes(1);

    // A fresh worker: o2's render was abandoned too, so its slot must be free.
    await act(async () => {
      await t.restart();
    });
    await tick();
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o2", sourceHash: await sha256Hex("2;") });
    });
    layers.request(layerReq(1, { overlayId: "o2" }));
    expect(renders(t).filter((m) => m.id === "o2")).toHaveLength(3);
    unmount();
  });

  it("a load that fails host-side (a bitmap that will not clone) becomes a build diagnostic (minor 7)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        if (++calls === 2) throw new Error("The image could not be cloned"); // the host's clone
        return { width: 1, height: 1, close: vi.fn() };
      }),
    );
    const onDiagnostic = vi.fn();
    const images = { i1: decoded() };
    const { result } = mount(comp([image("i1", "f1"), code("o1", "loadImage('f1');")]), { images, onDiagnostic });
    await ready();
    await flush();
    expect(result.current.errors.o1).toBe("The image could not be cloned");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ overlayId: "o1", phase: "build", message: "The image could not be cloned" }));
  });

  it("a new image set re-posts the loadImage body with it and closes the bitmaps it replaced (minor 7)", async () => {
    const made = stubBitmaps();
    const images1 = { i1: decoded() };
    const body = code("o1", "loadImage('f1');");
    const { rerender } = mount(comp([image("i1", "f1"), body]), { images: images1 });
    await ready();
    await flush();
    const t = transports[0];
    const first = made[0]; // the hook's decode; made[1] is the host's clone
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: await sha256Hex("loadImage('f1');") });
    });
    expect(first.close).not.toHaveBeenCalled();
    const images2 = { i1: images1.i1, i2: decoded() };
    rerender({ c: comp([image("i1", "f1"), image("i2", "f2"), body]), opts: { images: images2 } });
    await flush();
    expect(t.posted.slice(-2).map((m) => m.t)).toEqual(["dispose", "load"]);
    expect(Object.keys(loadsOf(t).at(-1)!.images ?? {}).sort()).toEqual(["f1", "f2"]);
    expect(first.close).toHaveBeenCalled();
  });

  it("closes the replaced bitmaps even when the re-post was cut short by a newer reconcile (minor 2)", async () => {
    const made = stubBitmaps();
    const images1 = { i1: decoded() };
    const body = code("o1", "loadImage('f1');");
    const { rerender } = mount(comp([image("i1", "f1"), body]), { images: images1 });
    await ready();
    await flush();
    const first = made[0];
    const images2 = { i1: images1.i1, i2: decoded() };
    const next = () => comp([image("i1", "f1"), image("i2", "f2"), body, code("o2", "2;")]);
    // The reconcile swaps the image set, re-posts o1, then waits on o2's hash…
    rerender({ c: next(), opts: { images: images2 } });
    for (let i = 0; i < 20; i++) await Promise.resolve(); // microtasks only: the hash is a macrotask
    expect(made).toHaveLength(6); // mount: 1 decode + 1 clone; now the new set decoded (2) and o1's re-post cloned it (2)
    // …when a refetch (a new composition identity) cancels it.
    rerender({ c: next(), opts: { images: images2 } });
    await flush();
    expect(first.close).toHaveBeenCalled();
  });

  it("stops holding decoded images once no body uses loadImage (minor 3)", async () => {
    const made = stubBitmaps();
    const images = { i1: decoded() };
    const { rerender } = mount(comp([image("i1", "f1"), code("o1", "loadImage('f1');")]), { images });
    await ready();
    await flush();
    const first = made[0];
    rerender({ c: comp([image("i1", "f1"), code("o1", "1;")]), opts: { images } });
    await flush();
    expect(first.close).toHaveBeenCalled();
  });

  it("a boot failure keeps its real reason on the badge and reports it once across backoff retries (minor 5)", async () => {
    const onDiagnostic = vi.fn();
    const { result, unmount } = mount(comp([code("o1", "1;")]), { onDiagnostic });
    await flush();
    const t = transports[0];
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        t.reply({ t: "supervisorError", nonce: t.nonce, message: "the overlay worker would not start" });
      });
    }
    expect(result.current.errors.o1).toBe("the overlay worker would not start");
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ overlayId: "o1", phase: "build", message: "the overlay worker would not start" }));
    unmount();
  });

  it("a font-only change repaints a PAUSED preview: the same frame renders again once the fonts are installed (Task 12b)", async () => {
    const { result, rerender, t } = await mountLoaded();
    const src = result.current.layers!;
    act(() => src.request(layerReq(3)));
    expect(renders(t)).toHaveLength(1);
    act(() => t.deliver({ t: "layer", nonce: t.nonce, id: "o1", frame: 3, req: renders(t)[0].req, bitmap: { width: 1, height: 1, close: vi.fn() } }));
    act(() => src.request(layerReq(3))); // paused: the same request is skipped
    expect(renders(t)).toHaveLength(1);

    // A text overlay gains an uploaded font; no body changes.
    fontState.fonts = [{ family: "libifont-x", weight: 400, data: new ArrayBuffer(8) }];
    rerender({ c: comp([code("o1", "1;")]) });
    await flush();
    const ride = loadsOf(t).at(-1)!;
    expect(ride.fonts?.map((f) => f.family)).toEqual(["libifont-x"]);
    const repaint = vi.fn();
    src.subscribe(repaint);
    await act(async () => {
      t.deliver({ t: "loaded", nonce: t.nonce, id: "o1", sourceHash: ride.sourceHash });
    });
    expect(repaint).toHaveBeenCalled(); // the player is asked to draw again…
    act(() => src.request(layerReq(3)));
    expect(renders(t)).toHaveLength(2); // …and this time the same frame goes to the worker
  });

  it("a failure inside the reconcile becomes an unattributed diagnostic, not an unhandled rejection (Task 12b)", async () => {
    const onUnattributed = vi.fn();
    fontState.fail = new Error("font store exploded");
    mount(comp([code("o1", "1;")]), { onUnattributed });
    await ready();
    await flush();
    expect(onUnattributed).toHaveBeenCalledWith({ message: expect.stringContaining("font store exploded") });
  });

  it("never closes an image set a skipped body still holds — a cut-short pass whose image key then REVERTS (Task 9 re-review)", async () => {
    const made = stubBitmaps();
    const images1 = { i1: decoded() };
    const x = code("o1", "loadImage('f1');");
    const { rerender, unmount } = mount(comp([image("i1", "f1"), x]), { images: images1 });
    await ready();
    await flush();
    const setS = made[0]; // the hook's decode of the first set; made[1] is the host's clone
    // Pass 1: a second image file AND a new body ahead of o1. The set is
    // swapped, then the pass awaits o0's hash before reaching o1…
    const images2 = { i1: images1.i1, i2: decoded() };
    rerender({ c: comp([image("i1", "f1"), image("i2", "f2"), code("o0", "0;"), x]), opts: { images: images2 } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(made).toHaveLength(4); // the new set (2) is decoded; o1 not re-posted yet
    // …and is cancelled by an update that takes the second file away again.
    rerender({ c: comp([image("i1", "f1"), code("o0", "0;"), x]), opts: { images: images1 } });
    await flush();
    // o1's key is back to the one it was loaded with, so it was skipped and
    // still holds the first set — as does the host's replay cache.
    expect(loadsOf(transports[0]).filter((m) => m.id === "o1")).toHaveLength(1);
    expect(setS.close).not.toHaveBeenCalled();
    expect(made[2].close).toHaveBeenCalled(); // the set nobody holds is closed
    unmount();
    expect(setS.close).toHaveBeenCalled(); // and the held one goes with the sandbox
  });
});
