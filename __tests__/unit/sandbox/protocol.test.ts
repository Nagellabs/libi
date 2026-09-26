import { z } from "zod";
import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  parseHostMessage,
  parseRuntimeMessage,
  parseSupervisorCommand,
  parseSupervisorReply,
  parseWorkerInit,
  isImageBitmapLike,
  isMessagePortLike,
  clampRenderGeometry,
  MAX_CANVAS_SIDE,
  MAX_LAYER_PIXELS,
  MAX_LAYER_PIXEL_RATIO,
  MAX_LAYER_SIDE,
} from "@/lib/sandbox/protocol";

const HASH = "a".repeat(64);
const fakeBitmap = { width: 4, height: 4, close() {} };
const timing = { frame: 3, time: 0.1, totalFrames: 90, duration: 3, progress: 0.033 };

describe("sandbox protocol — host → runtime", () => {
  it("accepts a well-formed load", () => {
    const m = parseHostMessage({ t: "load", id: "o1", kind: "code", source: "ctx.fillRect(0,0,1,1)", sourceHash: HASH, width: 100, height: 50 });
    expect(m?.t).toBe("load");
  });
  it("accepts load with images, fonts and three options", () => {
    const m = parseHostMessage({
      t: "load", id: "o1", kind: "three", source: "return () => {}", sourceHash: HASH, width: 10, height: 10,
      images: { f1: fakeBitmap }, fonts: [{ family: "Inter", weight: 700, data: new ArrayBuffer(8) }],
      three: { cameraPreset: "ground", pixelRatio: 1 },
    });
    expect(m && m.t === "load" && m.three?.cameraPreset).toBe("ground");
  });
  it("rejects a load whose sourceHash is not 64 hex chars", () => {
    expect(parseHostMessage({ t: "load", id: "o1", kind: "code", source: "x", sourceHash: "abc", width: 1, height: 1 })).toBeNull();
  });
  it("accepts a render and rejects one with a negative req", () => {
    const ok = parseHostMessage({ t: "render", id: "o1", frame: 3, req: 7, size: { width: 100, height: 50 }, pixelRatio: 2, fps: 30, time: timing });
    expect(ok?.t).toBe("render");
    const bad = parseHostMessage({ t: "render", id: "o1", frame: 3, req: -1, size: { width: 100, height: 50 }, pixelRatio: 2, fps: 30, time: timing });
    const noFps = parseHostMessage({ t: "render", id: "o1", frame: 3, req: 1, size: { width: 100, height: 50 }, pixelRatio: 2, time: timing });
    expect(noFps).toBeNull();
    expect(bad).toBeNull();
  });
  it("accepts a render carrying words and transform3d in their real shapes", () => {
    const m = parseHostMessage({
      t: "render", id: "o1", frame: 3, req: 7, size: { width: 100, height: 50 }, pixelRatio: 2, fps: 30, time: timing,
      words: [{ text: "hello", start: 0, end: 0.4 }],
      transform3d: { position: { x: 0, y: 1, z: -2 }, rotation: { x: 0, y: 0.3, z: 0 } },
    });
    expect(m && m.t === "render" && m.words?.[0].text).toBe("hello");
    expect(m && m.t === "render" && m.transform3d?.rotation.y).toBe(0.3);
  });
  it("accepts a render pad of up to one box size per side and rejects anything larger (review I1)", () => {
    const at = (pad: unknown) =>
      parseHostMessage({ t: "render", id: "o1", frame: 3, req: 7, size: { width: 100, height: 50 }, pixelRatio: 2, fps: 30, time: timing, pad });
    const ok = at({ left: 100, top: 50, right: 0, bottom: 12.5 });
    expect(ok && ok.t === "render" && ok.pad).toEqual({ left: 100, top: 50, right: 0, bottom: 12.5 });
    // A body or host must not be able to make the worker allocate a huge layer.
    expect(at({ left: 101, top: 0, right: 0, bottom: 0 })).toBeNull();
    expect(at({ left: 0, top: 0, right: 0, bottom: 51 })).toBeNull();
    expect(at({ left: 0, top: 51, right: 0, bottom: 0 })).toBeNull();
    expect(at({ left: 0, top: 0, right: 1e9, bottom: 0 })).toBeNull();
    expect(at({ left: -1, top: 0, right: 0, bottom: 0 })).toBeNull();
    expect(at({ left: Infinity, top: 0, right: 0, bottom: 0 })).toBeNull();
    expect(at({ left: 0, top: 0, right: 0 })).toBeNull();
  });
  it("caps a render's geometry: box side, pixel ratio and total device pixels (Task 12b)", () => {
    const at = (size: { width: number; height: number }, pixelRatio: number, pad?: unknown) =>
      parseHostMessage({ t: "render", id: "o1", frame: 3, req: 7, size, pixelRatio, fps: 30, time: timing, ...(pad ? { pad } : {}) });
    expect(at({ width: MAX_LAYER_SIDE, height: 100 }, 1)?.t).toBe("render");
    expect(at({ width: MAX_LAYER_SIDE + 1, height: 100 }, 1)).toBeNull();
    expect(at({ width: 100, height: MAX_LAYER_SIDE + 1 }, 1)).toBeNull();
    expect(at({ width: 100, height: 100 }, MAX_LAYER_PIXEL_RATIO)?.t).toBe("render");
    expect(at({ width: 100, height: 100 }, MAX_LAYER_PIXEL_RATIO + 0.5)).toBeNull();
    // 4K at 2×: 7680 × 4320 device px — inside. At 3×, outside the pixel cap.
    expect(at({ width: 3840, height: 2160 }, 2)?.t).toBe("render");
    expect(at({ width: 3840, height: 2160 }, 3)).toBeNull();
    // The pad counts: a 4K tracked box with a full pad at 1× is 11520 × 6480.
    expect(at({ width: 3840, height: 2160 }, 1, { left: 3840, right: 3840, top: 2160, bottom: 2160 })).toBeNull();
  });
  it("caps each device-pixel side of the backing canvas at Chromium's maximum, not just the area (Task 12b M4)", () => {
    const at = (size: { width: number; height: number }, pixelRatio: number, pad?: unknown) =>
      parseHostMessage({ t: "render", id: "o1", frame: 3, req: 7, size, pixelRatio, fps: 30, time: timing, ...(pad ? { pad } : {}) });
    // A long thin layer: well under the area cap, but 32768 device px wide.
    expect(at({ width: MAX_LAYER_SIDE, height: 1 }, MAX_LAYER_PIXEL_RATIO)).toBeNull();
    // The pad counts on each axis too: (8192 + 2 × 8192) × 2 = 49152 px wide.
    expect(at({ width: MAX_LAYER_SIDE, height: 1 }, 2, { left: MAX_LAYER_SIDE, right: MAX_LAYER_SIDE, top: 0, bottom: 0 })).toBeNull();
    expect(at({ width: 4096, height: 1 }, 4)?.t).toBe("render"); // 16384: fine
    for (const g of [
      { size: { width: MAX_LAYER_SIDE, height: 1 }, pixelRatio: MAX_LAYER_PIXEL_RATIO },
      { size: { width: MAX_LAYER_SIDE, height: 1 }, pixelRatio: 2, pad: { left: MAX_LAYER_SIDE, right: MAX_LAYER_SIDE, top: 0, bottom: 0 } },
      { size: { width: 1, height: 7777 }, pixelRatio: 4.3, pad: { left: 0, right: 0, top: 7777, bottom: 7777 } },
    ]) {
      const c = clampRenderGeometry(g);
      expect(parseHostMessage({ t: "render", id: "o1", frame: 3, req: 7, fps: 30, time: timing, ...c }), JSON.stringify(g)).not.toBeNull();
      const w = (c.size.width + (c.pad ? c.pad.left + c.pad.right : 0)) * c.pixelRatio;
      const h = (c.size.height + (c.pad ? c.pad.top + c.pad.bottom : 0)) * c.pixelRatio;
      // What the worker allocates (`LayerEngine.render` ceils each side).
      expect(Math.ceil(w)).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
      expect(Math.ceil(h)).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    }
  });
  it("clampRenderGeometry brings any geometry inside the caps, and is the identity inside them", () => {
    const ok = { size: { width: 1920, height: 1080 }, pixelRatio: 2 };
    expect(clampRenderGeometry(ok)).toEqual(ok);
    expect(clampRenderGeometry(ok).size).toBe(ok.size); // the same object: a request compares equal to itself
    const cases = [
      { size: { width: 20000, height: 100 }, pixelRatio: 1 },
      { size: { width: 100, height: 100 }, pixelRatio: 16 },
      { size: { width: 3840, height: 2160 }, pixelRatio: 3 },
      { size: { width: 3840, height: 2160 }, pixelRatio: 1, pad: { left: 3840, right: 3840, top: 2160, bottom: 2160 } },
      { size: { width: 9000, height: 9000 }, pixelRatio: 4, pad: { left: 9000, right: 9000, top: 9000, bottom: 9000 } },
    ];
    for (const g of cases) {
      const c = clampRenderGeometry(g);
      const msg = { t: "render", id: "o1", frame: 3, req: 7, fps: 30, time: timing, ...c };
      expect(parseHostMessage(msg), JSON.stringify(g)).not.toBeNull();
      expect(c.pixelRatio).toBeGreaterThan(0);
    }
    // A pixel-capped layer keeps its box and loses only resolution, as close to the cap as it can.
    const capped = clampRenderGeometry({ size: { width: 3840, height: 2160 }, pixelRatio: 3 });
    expect(capped.size).toEqual({ width: 3840, height: 2160 });
    const pixels = 3840 * capped.pixelRatio * 2160 * capped.pixelRatio;
    expect(pixels).toBeLessThanOrEqual(MAX_LAYER_PIXELS);
    expect(pixels).toBeGreaterThan(MAX_LAYER_PIXELS * 0.999);
  });
  it("accepts dispose and rejects an unknown discriminator", () => {
    expect(parseHostMessage({ t: "dispose", id: "o1" })?.t).toBe("dispose");
    expect(parseHostMessage({ t: "explode", id: "o1" })).toBeNull();
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage("load")).toBeNull();
  });
});

const fakePort = { postMessage() {}, start() {}, close() {}, onmessage: null };

describe("sandbox protocol — supervisor leg (A1)", () => {
  it("accepts restart and ping with a nonce, nothing else", () => {
    expect(parseSupervisorCommand({ t: "restart", nonce: "n" })?.t).toBe("restart");
    expect(parseSupervisorCommand({ t: "ping", nonce: "n" })?.t).toBe("ping");
    expect(parseSupervisorCommand({ t: "restart" })).toBeNull();
    expect(parseSupervisorCommand({ t: "load", nonce: "n" })).toBeNull();
  });
  it("the hand-written supervisor-command parser accepts exactly what the zod union it replaced did", () => {
    // `parseSupervisorCommand` is hand-written so the supervisor bundle carries
    // no zod (lib/sandbox/protocol-supervisor.ts). Held to the schema it
    // replaced, evaluated here where zod IS available.
    const reference = z.discriminatedUnion("t", [
      z.object({ t: z.literal("restart"), nonce: z.string().min(1) }),
      z.object({ t: z.literal("ping"), nonce: z.string().min(1), id: z.number().int().nonnegative().optional() }),
    ]);
    const cases: unknown[] = [
      { t: "restart", nonce: "n" },
      { t: "ping", nonce: "n" },
      { t: "ping", nonce: "" },
      { t: "ping", nonce: 7 },
      { t: "ping" },
      { t: "restart", nonce: "n", extra: "dropped" },
      { t: "ping", nonce: "n", id: 0 },
      { t: "ping", nonce: "n", id: 12 },
      { t: "ping", nonce: "n", id: -1 },
      { t: "ping", nonce: "n", id: 1.5 },
      { t: "ping", nonce: "n", id: "3" },
      { t: "ping", nonce: "n", id: Number.NaN },
      { t: "restart", nonce: "n", id: 3 },
      { t: "explode", nonce: "n" },
      { nonce: "n" },
      null,
      undefined,
      "ping",
      42,
      [],
    ];
    for (const c of cases) {
      const ours = parseSupervisorCommand(c);
      const theirs = reference.safeParse(c);
      expect([c, ours], JSON.stringify(c)).toEqual([c, theirs.success ? theirs.data : null]);
    }
  });
  it("accepts ready with the current version AND a port, rejects another version or a missing port; accepts pong", () => {
    expect(parseSupervisorReply({ t: "ready", nonce: "n", version: PROTOCOL_VERSION, port: fakePort })?.t).toBe("ready");
    expect(parseSupervisorReply({ t: "ready", nonce: "n", version: PROTOCOL_VERSION + 1, port: fakePort })).toBeNull();
    expect(parseSupervisorReply({ t: "ready", nonce: "n", version: PROTOCOL_VERSION })).toBeNull();
    expect(parseSupervisorReply({ t: "pong", nonce: "n" })?.t).toBe("pong");
    expect(parseSupervisorReply({ t: "pong" })).toBeNull();
    expect(parseSupervisorReply({ t: "pong", nonce: "n", id: 3 })).toEqual({ t: "pong", nonce: "n", id: 3 });
    expect(parseSupervisorReply({ t: "pong", nonce: "n", id: -1 })).toBeNull();
  });
  it("accepts supervisorError and bounds its message, so a boot failure is never silent", () => {
    expect(parseSupervisorReply({ t: "supervisorError", nonce: "n", message: "Worker construction failed" })?.t)
      .toBe("supervisorError");
    expect(parseSupervisorReply({ t: "supervisorError", nonce: "n" })).toBeNull();
    expect(parseSupervisorReply({ t: "supervisorError", message: "m" })).toBeNull();
    // Same wire cap as the worker's own `error`: the text can come from a
    // browser event the body influenced.
    expect(parseSupervisorReply({ t: "supervisorError", nonce: "n", message: "x".repeat(2000) })?.t)
      .toBe("supervisorError");
    expect(parseSupervisorReply({ t: "supervisorError", nonce: "n", message: "x".repeat(2001) })).toBeNull();
  });
  it("accepts the worker init with a port", () => {
    expect(parseWorkerInit({ t: "init", nonce: "n", port: fakePort })?.t).toBe("init");
    expect(parseWorkerInit({ t: "init", nonce: "n", port: "p" })).toBeNull();
    expect(isMessagePortLike(fakePort)).toBe(true);
    expect(isMessagePortLike({ postMessage() {} })).toBe(false);
  });
});

describe("sandbox protocol — worker → host (the port)", () => {
  it("a ready is NOT a port message (it belongs to the supervisor leg)", () => {
    expect(parseRuntimeMessage({ t: "ready", nonce: "n", version: PROTOCOL_VERSION })).toBeNull();
  });
  it("requires a nonce on every runtime message", () => {
    expect(parseRuntimeMessage({ t: "loaded", id: "o1", sourceHash: HASH })).toBeNull();
    expect(parseRuntimeMessage({ t: "layer", id: "o1", frame: 1, req: 1, bitmap: fakeBitmap })).toBeNull();
    expect(parseRuntimeMessage({ t: "error", id: "o1", phase: "render", message: "boom" })).toBeNull();
  });
  it("accepts a render-start ack with its request id, and requires the nonce (Task 13 fix round 1, I2)", () => {
    expect(parseRuntimeMessage({ t: "started", nonce: "n", id: "o1", req: 4 })).toEqual({ t: "started", nonce: "n", id: "o1", req: 4 });
    expect(parseRuntimeMessage({ t: "started", id: "o1", req: 4 })).toBeNull();
    expect(parseRuntimeMessage({ t: "started", nonce: "n", id: "o1", req: -1 })).toBeNull();
    expect(parseRuntimeMessage({ t: "started", nonce: "n", id: "o1" })).toBeNull();
  });
  it("accepts the async window messages with an overlay id, and requires the nonce (Task 13 fix round 2)", () => {
    expect(parseRuntimeMessage({ t: "async", nonce: "n", id: "o1" })).toEqual({ t: "async", nonce: "n", id: "o1" });
    expect(parseRuntimeMessage({ t: "asyncDone", nonce: "n", id: "o1" })).toEqual({ t: "asyncDone", nonce: "n", id: "o1" });
    expect(parseRuntimeMessage({ t: "async", id: "o1" })).toBeNull();
    expect(parseRuntimeMessage({ t: "asyncDone", nonce: "n" })).toBeNull();
    expect(parseRuntimeMessage({ t: "async", nonce: "n", id: "" })).toBeNull();
    expect(parseRuntimeMessage({ t: "async", nonce: "n", id: "x".repeat(201) })).toBeNull();
    // Fix round 3 (N3): the body that scheduled the callback rides along.
    const h = "c".repeat(64);
    expect(parseRuntimeMessage({ t: "async", nonce: "n", id: "o1", sourceHash: h })).toEqual({ t: "async", nonce: "n", id: "o1", sourceHash: h });
    expect(parseRuntimeMessage({ t: "async", nonce: "n", id: "o1", sourceHash: "nope" })).toBeNull();
  });
  it("accepts a loaded ack — the 5 s load watchdog waits on it", () => {
    const m = parseRuntimeMessage({ t: "loaded", nonce: "n", id: "o1", sourceHash: HASH });
    expect(m && m.t === "loaded" && m.sourceHash).toBe(HASH);
  });
  it("rejects an error whose message or stack exceeds the wire cap", () => {
    const at = (message: string, stack?: string) =>
      parseRuntimeMessage({ t: "error", nonce: "n", id: "o1", phase: "render", message, stack });
    expect(at("x".repeat(2000))?.t).toBe("error");
    expect(at("x".repeat(2001))).toBeNull();
    expect(at("boom", "s".repeat(8000))?.t).toBe("error");
    expect(at("boom", "s".repeat(8001))).toBeNull();
  });
  it("accepts a layer with a duck-typed bitmap and rejects a non-bitmap", () => {
    expect(parseRuntimeMessage({ t: "layer", nonce: "n", id: "o1", frame: 1, req: 1, bitmap: fakeBitmap })?.t).toBe("layer");
    expect(parseRuntimeMessage({ t: "layer", nonce: "n", id: "o1", frame: 1, req: 1, bitmap: "png" })).toBeNull();
  });
  it("accepts an error with optional line/column/stack", () => {
    const m = parseRuntimeMessage({ t: "error", nonce: "n", id: "o1", phase: "compile", message: "Unexpected token", line: 3, column: 9, stack: "…" });
    expect(m && m.t === "error" && m.line).toBe(3);
    expect(parseRuntimeMessage({ t: "error", nonce: "n", id: "o1", phase: "boot", message: "x" })).toBeNull();
  });
  it("accepts an optional sourceHash on an error and rejects one that is not 64 hex (Task 5 ruling)", () => {
    const hash = "d".repeat(64);
    const m = parseRuntimeMessage({ t: "error", nonce: "n", id: "o1", phase: "compile", message: "bad", sourceHash: hash });
    expect(m && m.t === "error" && m.sourceHash).toBe(hash);
    // Absent is still valid — a render error has no load to attribute it to.
    const bare = parseRuntimeMessage({ t: "error", nonce: "n", id: "o1", phase: "render", message: "bad" });
    expect(bare && bare.t === "error" && bare.sourceHash).toBeUndefined();
    expect(parseRuntimeMessage({ t: "error", nonce: "n", id: "o1", phase: "compile", message: "bad", sourceHash: "abc" })).toBeNull();
  });
});

describe("isImageBitmapLike", () => {
  it("is a duck-type check (width, height, close)", () => {
    expect(isImageBitmapLike(fakeBitmap)).toBe(true);
    expect(isImageBitmapLike({ width: 1, height: 1 })).toBe(false);
    expect(isImageBitmapLike(null)).toBe(false);
  });
});
