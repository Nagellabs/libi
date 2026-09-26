import { describe, it, expect } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { renderFrame, collectLayerRequests } from "@/lib/engine/renderer";
import type { LayerBitmap, LayerRequest, LayerSource } from "@/lib/engine/layer-source";
import type { Composition, Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";
import { LayerEngine } from "@/lib/sandbox/runtime/layers";
import { parseHostMessage, type RenderMessage } from "@/lib/sandbox/protocol";
import { fakeLayers } from "@/__tests__/helpers/fake-layers";

/**
 * Task 8 review I1: tracked `code` bodies used to draw on the main canvas,
 * translated to the tracked bbox and NOT clipped, so a name tag above a face
 * or a glow around a product landed. Behind the sandbox a body draws into a
 * layer; the tracked layer is padded by one bbox size on every side (cut back
 * to the canvas) so that overdraw still reaches the output. Plain `code` stays
 * clipped to its rect.
 *
 * Real pixels, end to end: the runtime's LayerEngine paints each layer on an
 * @napi-rs canvas, the render message goes through the wire parser, and
 * `renderFrame` composites the result at a 2× backing scale.
 */

const HASH = "c".repeat(64);
const W = 400;
const H = 400;
const SCALE = 2;

/** The napi canvas as the worker's OffscreenCanvas: `transferToImageBitmap`
 *  hands back a snapshot, which napi's `drawImage` accepts as a source. */
function napiOffscreen(w: number, h: number): OffscreenCanvas {
  const c = createCanvas(w, h) as Canvas & { transferToImageBitmap?: () => unknown };
  c.transferToImageBitmap = () => {
    const snap = createCanvas(c.width, c.height);
    snap.getContext("2d").drawImage(c, 0, 0);
    return Object.assign(snap, { close() {} });
  };
  return c as unknown as OffscreenCanvas;
}

/** A LayerSource that renders synchronously through the real runtime engine. */
function runtimeLayers(engine: LayerEngine): LayerSource & { messages: RenderMessage[] } {
  const drawn = new Map<string, LayerBitmap>();
  const messages: RenderMessage[] = [];
  let req = 0;
  return {
    messages,
    request(r: LayerRequest) {
      // The parser strips what the wire does not carry (`overlayId`, `kind`).
      const msg = parseHostMessage({ ...r, t: "render", id: r.overlayId, req: ++req });
      if (!msg || msg.t !== "render") throw new Error(`render message rejected for ${r.overlayId}`);
      messages.push(msg);
      // The geometry the bitmap was rendered for, as a real source knows it
      // from the request its `layer` reply's `req` answers.
      const geometry = { size: msg.size, pixelRatio: msg.pixelRatio, ...(msg.pad ? { pad: msg.pad } : {}) };
      drawn.set(r.overlayId, { frame: msg.frame, bitmap: engine.render(msg), ...geometry });
    },
    get(overlayId) {
      return drawn.get(overlayId) ?? null;
    },
  };
}

/** Fills the box red, then puts a blue label 20 px ABOVE it and a green mark
 *  far beyond any pad (two box heights above). */
const BODY = `
  const { ctx, width, height } = context;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(0, -20, width, 10);
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, -2 * height - 10, width, 5);
`;

const track: Track = {
  id: "trk", fileId: "f", method: "mediapipe-face", framerate: 30, durationSec: 2,
  samples: [
    { t: 0, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
    { t: 2, x: 100, y: 200, w: 50, h: 60, confidence: 0.9, visible: true },
  ],
};

const tracked = {
  id: "k", kind: "tracked", trackId: "trk", startTime: 0, duration: 2, z: 1, opacity: 1,
  rect: { x: 0, y: 0, width: W, height: H }, fit: "tight", scale: 1, smoothing: "linear",
  content: { kind: "code", drawFunction: BODY },
} as unknown as Overlay;

const plain = {
  id: "p", kind: "code", startTime: 0, duration: 2, z: 1, opacity: 1,
  rect: { x: 100, y: 200, width: 50, height: 60 }, drawFunction: BODY,
} as unknown as Overlay;

function comp(overlay: Overlay): Composition {
  return { id: "c", name: "c", width: W, height: H, fps: 30, overlays: [overlay] } as Composition;
}

async function render(overlay: Overlay) {
  const engine = new LayerEngine({ makeCanvas: napiOffscreen, now: () => 0, wrapperLineOffset: 2, installFont: async () => {} });
  await engine.load({ t: "load", id: overlay.id, kind: overlay.kind === "tracked" ? "tracked" : "code", source: BODY, sourceHash: HASH, width: 50, height: 60 });
  const layers = runtimeLayers(engine);
  const canvas = createCanvas(W * SCALE, H * SCALE);
  renderFrame(canvas as unknown as HTMLCanvasElement, comp(overlay), 15, {}, undefined, undefined, layers, { trk: track });
  const ctx = canvas.getContext("2d");
  /** RGBA at a COMPOSITION-px point. */
  const at = (x: number, y: number) => Array.from(ctx.getImageData(x * SCALE, y * SCALE, 1, 1).data);
  return { at, messages: layers.messages };
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
/** `renderFrame` paints the composition's background (default black) first. */
const BACKGROUND = [0, 0, 0, 255];

describe("tracked code overdraw (review I1)", () => {
  it("a label drawn ABOVE the tracked bbox reaches the output", async () => {
    const { at, messages } = await render(tracked);
    expect(at(125, 230)).toEqual(RED); // inside the box
    expect(at(125, 185)).toEqual(BLUE); // the label: box top (200) − 20 … − 10
    // The body still sees the bbox as its box; the layer is the padded one.
    expect(messages[0].size).toEqual({ width: 50, height: 60 });
    expect(messages[0].pad).toEqual({ left: 50, top: 60, right: 50, bottom: 60 });
  });

  it("anything past one bbox size is still clipped", async () => {
    const { at } = await render(tracked);
    // The green mark sits at box top − 2 × height − 10 = 70: outside the pad (140).
    expect(at(125, 72)).toEqual(BACKGROUND);
  });

  it("plain code is still clipped to its rect: the same label does not land", async () => {
    const { at, messages } = await render(plain);
    expect(messages[0].pad).toBeUndefined();
    expect(at(125, 230)).toEqual(RED);
    expect(at(125, 185)).toEqual(BACKGROUND);
  });
});

/**
 * Review N1: the preview answers with the newest bitmap it has, which in
 * playback is typically a frame old and, while paused, can outlive a resize.
 * These render a layer once, then composite that SAME held bitmap for a
 * different current geometry.
 */
function holdingLayers(engine: LayerEngine): LayerSource & { hold(): void } {
  const inner = runtimeLayers(engine);
  let holding = false;
  return {
    hold: () => {
      holding = true;
    },
    request: (r) => {
      if (!holding) inner.request(r);
    },
    get: (id, frame) => inner.get(id, frame),
  };
}

function trackOf(w: number, h: number): Track {
  return {
    ...track,
    samples: [
      { t: 0, x: 100, y: 200, w, h, confidence: 0.9, visible: true },
      { t: 2, x: 100, y: 200, w, h, confidence: 0.9, visible: true },
    ],
  };
}

describe("a held layer is mapped onto the current box (review N1)", () => {
  it("tracked: a bitmap rendered for a 25 × 30 box lands on the current 50 × 60 box, pad included", async () => {
    const engine = new LayerEngine({ makeCanvas: napiOffscreen, now: () => 0, wrapperLineOffset: 2, installFont: async () => {} });
    await engine.load({ t: "load", id: "k", kind: "tracked", source: BODY, sourceHash: HASH, width: 25, height: 30 });
    const layers = holdingLayers(engine);
    const first = createCanvas(W * SCALE, H * SCALE);
    renderFrame(first as unknown as HTMLCanvasElement, comp(tracked), 15, {}, undefined, undefined, layers, { trk: trackOf(25, 30) });
    layers.hold();
    const canvas = createCanvas(W * SCALE, H * SCALE);
    renderFrame(canvas as unknown as HTMLCanvasElement, comp(tracked), 16, {}, undefined, undefined, layers, { trk: trackOf(50, 60) });
    const ctx = canvas.getContext("2d");
    const at = (x: number, y: number) => Array.from(ctx.getImageData(x * SCALE, y * SCALE, 1, 1).data);
    // The current box is (100, 200) 50 × 60: filled red, corner to corner.
    expect(at(102, 202)).toEqual(RED);
    expect(at(125, 230)).toEqual(RED);
    expect(at(148, 258)).toEqual(RED);
    // The label, 20 px above a 30 px-high box, scales with it: 40 … 20 px above.
    expect(at(125, 170)).toEqual(BLUE);
    // Nothing below the box or left of it.
    expect(at(125, 265)).toEqual(BACKGROUND);
    expect(at(95, 230)).toEqual(BACKGROUND);
  });

  it("code: a bitmap rendered at pixel ratio 2, composited at 1.5, fills the rect with no zoom or crop", async () => {
    // Red box with a green right quarter: a zoomed-in draw never shows the green.
    const body = `
      const { ctx, width, height } = context;
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#00ff00";
      ctx.fillRect(width * 0.75, 0, width * 0.25, height);
    `;
    const overlay = { ...plain, drawFunction: body } as unknown as Overlay;
    const engine = new LayerEngine({ makeCanvas: napiOffscreen, now: () => 0, wrapperLineOffset: 2, installFont: async () => {} });
    await engine.load({ t: "load", id: "p", kind: "code", source: body, sourceHash: HASH, width: 50, height: 60 });
    const layers = holdingLayers(engine);
    renderFrame(createCanvas(W * 2, H * 2) as unknown as HTMLCanvasElement, comp(overlay), 15, {}, undefined, undefined, layers, {});
    layers.hold();
    const scale = 1.5;
    const canvas = createCanvas(W * scale, H * scale);
    renderFrame(canvas as unknown as HTMLCanvasElement, comp(overlay), 15, {}, undefined, undefined, layers, {});
    const ctx = canvas.getContext("2d");
    const at = (x: number, y: number) => Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    // Rect (100, 200) 50 × 60.
    expect(at(105, 230)).toEqual(RED);
    expect(at(146, 230)).toEqual(GREEN);
    expect(at(146, 257)).toEqual(GREEN);
    expect(at(125, 265)).toEqual(BACKGROUND);
  });
});

describe("collectLayerRequests — tracked sampling (review M2)", () => {
  it("samples the track itself and asks for exactly what renderFrame asks for on the same frame", () => {
    const composition = comp(tracked);
    const tracks = { trk: track };
    const collected = collectLayerRequests(composition, 15, SCALE, tracks);
    const layers = fakeLayers();
    const canvas = createCanvas(W * SCALE, H * SCALE);
    renderFrame(canvas as unknown as HTMLCanvasElement, composition, 15, {}, undefined, undefined, layers, tracks);
    expect(collected).toHaveLength(1);
    expect(collected).toEqual(layers.requests);
    expect(collected[0]).toMatchObject({
      overlayId: "k", kind: "tracked", frame: 15, pixelRatio: SCALE,
      size: { width: 50, height: 60 }, pad: { left: 50, top: 60, right: 50, bottom: 60 },
    });
  });

  it("asks for nothing when the overlay's track is missing", () => {
    expect(collectLayerRequests(comp(tracked), 15, SCALE, {})).toEqual([]);
  });
});
