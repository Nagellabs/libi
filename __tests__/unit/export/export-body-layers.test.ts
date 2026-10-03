import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Canvas, createCanvas, loadImage, type Canvas as NapiCanvas } from "@napi-rs/canvas";
import type { Composition, Overlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";
import { LayerEngine } from "@/lib/sandbox/runtime/layers";
import { probeWrapperLineOffset } from "@/lib/sandbox/runtime/compile";
import { attachRuntime, type RuntimePort } from "@/lib/sandbox/runtime/serve";
import { ExportLayerSource, buildExportDiagnosticsReport } from "@/lib/sandbox/export-layers";
import type { LoadInput, RenderInput } from "@/lib/sandbox/host";
import type { RuntimeMessage } from "@/lib/sandbox/protocol";
import { sha256Hex } from "@/lib/sandbox/hash";

/**
 * Task 10 gate: the export draws code / tracked-code overlays from the
 * sandboxed runtime, frame-exact, and a broken body is a dropped overlay plus
 * a diagnostic naming the composition second that failed.
 *
 * Real pieces end to end, minus the browser: the runtime's own message loop
 * (`attachRuntime` over the wire parser) runs the REAL LayerEngine and body
 * compiler on @napi-rs canvases; `exportVideo` settles every layer through
 * `ExportLayerSource` and composites with the real `renderFrame`; the encoder
 * is replaced by a capture of each frame as a PNG, which the assertions decode.
 * (The browser half — iframe, worker, CSP — is covered live and by the
 * sandbox e2e; here every message is still asynchronous, as on a real port.)
 */

const captured = vi.hoisted(() => ({ frames: [] as Buffer[] }));
vi.mock("mediabunny", () => {
  class Output {
    addVideoTrack() {}
    async start() {}
    async finalize() {}
  }
  class Mp4OutputFormat {}
  class WebMOutputFormat {}
  class BufferTarget {
    buffer = new ArrayBuffer(8);
  }
  class CanvasSource {
    constructor(private readonly canvas: { encodeSync(format: "png"): Buffer }) {}
    async add() {
      captured.frames.push(this.canvas.encodeSync("png"));
    }
    close() {}
  }
  return { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource };
});

import { exportVideo } from "@/lib/engine/export";
import { renderFrame, collectLayerRequests } from "@/lib/engine/renderer";
import type { LayerRequest, LayerSource } from "@/lib/engine/layer-source";

const W = 200;
const H = 200;
const FPS = 10;

/** The napi canvas as the worker's OffscreenCanvas. */
function napiOffscreen(w: number, h: number): OffscreenCanvas {
  const c = createCanvas(w, h) as NapiCanvas & { transferToImageBitmap?: () => unknown };
  c.transferToImageBitmap = () => {
    const snap = createCanvas(c.width, c.height);
    snap.getContext("2d").drawImage(c, 0, 0);
    return Object.assign(snap, { close() {} });
  };
  return c as unknown as OffscreenCanvas;
}

/**
 * The sandbox as the export sees it: `load` / `render` go down to the runtime's
 * real message loop; `loaded` / `layer` / `error` come back up to the source —
 * always on a later microtask, like a MessagePort.
 */
function inMemorySandbox(source: () => ExportLayerSource) {
  const engine = new LayerEngine({ makeCanvas: napiOffscreen, now: () => 0, wrapperLineOffset: probeWrapperLineOffset(), installFont: async () => {} });
  let toRuntime: (data: unknown) => void = () => {};
  const loaded = new Set<string>();
  const pendingLoads = new Map<string, () => void>();
  const port: RuntimePort = {
    post(msg: RuntimeMessage) {
      queueMicrotask(() => {
        if (msg.t === "loaded") {
          loaded.add(msg.id);
          pendingLoads.get(msg.id)?.();
        } else if (msg.t === "layer") source().onLayer(msg);
        else if (msg.t === "error") {
          source().onError(msg);
          if (msg.phase !== "render") pendingLoads.get(msg.id)?.();
        } else if (msg.t === "unattributed") source().onUnattributed(msg);
      });
    },
    onMessage(handler) {
      toRuntime = handler;
    },
  };
  attachRuntime(port, "nonce", engine);
  let req = 0;
  return {
    load(input: LoadInput): Promise<void> {
      return new Promise((resolve) => {
        pendingLoads.set(input.id, resolve);
        toRuntime({ t: "load", ...input });
      });
    },
    render(input: RenderInput): number {
      if (!loaded.has(input.id)) return -1;
      const r = ++req;
      queueMicrotask(() => toRuntime({ t: "render", req: r, ...input }));
      return r;
    },
  };
}

/** Fills its whole box red. */
const FIXED = `const { ctx, width, height } = context; ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, width, height);`;
/** Green until frame 3 (0.3 s), then throws on every frame. */
const BROKEN = `const { ctx, width, height, frame } = context;
if (frame >= 3) nope();
ctx.fillStyle = "#00ff00"; ctx.fillRect(0, 0, width, height);`;
/** Fills its box blue and puts a white label ABOVE it (tracked pad). */
const TRACKED = `const { ctx, width, height } = context; ctx.fillStyle = "#0000ff"; ctx.fillRect(0, 0, width, height);
ctx.fillStyle = "#ffffff"; ctx.fillRect(0, -10, width, 6);`;
const NEVER_COMPILES = `return (`;

const track: Track = {
  id: "trk", fileId: "f", method: "mediapipe-face", framerate: FPS, durationSec: 1,
  samples: [
    { t: 0, x: 120, y: 140, w: 40, h: 40, confidence: 0.9, visible: true },
    { t: 1, x: 120, y: 140, w: 40, h: 40, confidence: 0.9, visible: true },
  ],
};

const overlays = [
  { id: "fixed", kind: "code", startTime: 0, duration: 0.5, z: 1, opacity: 1, rect: { x: 0, y: 0, width: 80, height: 80 }, drawFunction: FIXED },
  { id: "broken", kind: "code", startTime: 0, duration: 0.5, z: 2, opacity: 1, rect: { x: 100, y: 0, width: 80, height: 80 }, drawFunction: BROKEN },
  {
    id: "tracked", kind: "tracked", trackId: "trk", startTime: 0, duration: 0.5, z: 3, opacity: 1,
    rect: { x: 0, y: 0, width: W, height: H }, fit: "tight", scale: 1, smoothing: "linear",
    content: { kind: "code", drawFunction: TRACKED },
  },
  { id: "syntax", kind: "code", startTime: 0, duration: 0.5, z: 4, opacity: 1, rect: { x: 0, y: 100, width: 80, height: 30 }, drawFunction: NEVER_COMPILES },
] as unknown as Overlay[];

const composition = { id: "c", name: "c", width: W, height: H, fps: FPS, overlays } as Composition;

let saved: typeof globalThis.OffscreenCanvas | undefined;
beforeAll(() => {
  saved = globalThis.OffscreenCanvas;
  // `exportVideo` draws on an OffscreenCanvas; napi's Canvas is the node stand-in.
  globalThis.OffscreenCanvas = Canvas as unknown as typeof OffscreenCanvas;
});
afterAll(() => {
  globalThis.OffscreenCanvas = saved as typeof OffscreenCanvas;
});

async function exportThroughSandbox() {
  captured.frames = [];
  const holder: { source?: ExportLayerSource } = {};
  const sandbox = inMemorySandbox(() => holder.source!);
  const source = new ExportLayerSource((input) => sandbox.render(input));
  holder.source = source;
  const kinds = { fixed: "code", broken: "code", tracked: "tracked", syntax: "code" } as const;
  const bodies = new Map<string, { kind: "code" | "tracked"; sourceHash: string }>();
  for (const o of overlays) {
    const src = o.kind === "code" ? o.drawFunction : o.kind === "tracked" && o.content.kind === "code" ? o.content.drawFunction : "";
    const sourceHash = await sha256Hex(src);
    bodies.set(o.id, { kind: kinds[o.id as keyof typeof kinds], sourceHash });
    await sandbox.load({ id: o.id, kind: kinds[o.id as keyof typeof kinds], source: src, sourceHash, width: o.rect.width, height: o.rect.height });
  }
  const result = await exportVideo(
    composition,
    { format: "mp4", codec: "avc", bitrate: 1, width: W * 2, height: H * 2, fps: FPS },
    undefined,
    undefined,
    undefined,
    source,
    { trk: track },
  );
  const report = buildExportDiagnosticsReport(source, bodies, { fps: FPS, now: 1 });
  return { result, report, frames: captured.frames };
}

async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  // Composition px → the 2× export canvas.
  return Array.from(ctx.getImageData(x * 2, y * 2, 1, 1).data);
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const BACKGROUND = [0, 0, 0, 255];

describe("export draws body layers through the sandboxed runtime (Task 10 gate)", () => {
  it("the FIXED code overlay is drawn in every PNG; the tracked layer carries its pad", async () => {
    const { frames } = await exportThroughSandbox();
    expect(frames).toHaveLength(5);
    for (const png of frames) {
      expect(await pixel(png, 40, 40)).toEqual(RED);
      expect(await pixel(png, 140, 160)).toEqual(BLUE); // tracked box
      expect(await pixel(png, 140, 133)).toEqual(WHITE); // its label, 10 px above the box
    }
  });

  it("a body that throws from frame 3 draws until then, then nothing — never its previous frame", async () => {
    const { frames } = await exportThroughSandbox();
    expect(await pixel(frames[2], 140, 40)).toEqual(GREEN);
    expect(await pixel(frames[3], 140, 40)).toEqual(BACKGROUND);
    expect(await pixel(frames[4], 140, 40)).toEqual(BACKGROUND);
  });

  it("the broken body is a dropped overlay AND a diagnostic carrying the composition second that failed", async () => {
    const { result, report } = await exportThroughSandbox();
    const dropped = new Map((result.droppedOverlays ?? []).map((d) => [d.id, d.message]));
    expect(dropped.get("broken")).toMatch(/^render: nope is not defined \(line 2:\d+\)$/);
    expect(dropped.get("syntax")).toMatch(/^compile: /);
    expect(dropped.has("fixed")).toBe(false);
    const broken = report.diagnostics.find((d) => d.overlayId === "broken");
    expect(broken).toMatchObject({ kind: "code", phase: "render", message: "nope is not defined", line: 2, time: 0.3 });
    expect(report.diagnostics.find((d) => d.overlayId === "syntax")).toMatchObject({ phase: "compile" });
    expect(report.diagnostics.some((d) => d.overlayId === "fixed" || d.overlayId === "tracked")).toBe(false);
    // What lets a clean render retire an older entry: the frames each body drew cleanly.
    expect(report.clean).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ overlayId: "fixed", frames: [[0, 5]] }),
        expect.objectContaining({ overlayId: "broken", frames: [[0, 3]] }),
      ]),
    );
  });
});

/**
 * `libi.render_overlay_frames` renders ONLY the frames it was asked for (Task
 * 12b review, controller follow-up). It used to encode the whole piece and cut
 * the PNGs out afterwards, so the agent's verify step cost piece length × body
 * cost and ran past the MCP client's 60 s timeout.
 */
describe("exportVideo — a frame list renders only those frames", () => {
  /** Paints its box red = the frame number, so each PNG says which frame it is. */
  const FRAME_STAMP = `const { ctx, width, height, frame } = context; ctx.fillStyle = "rgb(" + frame + ",0,0)"; ctx.fillRect(0, 0, width, height);`;
  const long = [
    { id: "stamp", kind: "code", startTime: 0, duration: 15, z: 1, opacity: 1, rect: { x: 0, y: 0, width: 80, height: 80 }, drawFunction: FRAME_STAMP },
  ] as unknown as Overlay[];
  const piece = { id: "c", name: "c", width: W, height: H, fps: FPS, overlays: long } as Composition; // 150 frames

  it("2 requested frames of a 150-frame piece run the body twice and encode 2 frames, in order", async () => {
    captured.frames = [];
    const holder: { source?: ExportLayerSource } = {};
    const sandbox = inMemorySandbox(() => holder.source!);
    let renders = 0;
    const source = new ExportLayerSource((input) => {
      renders++;
      return sandbox.render(input);
    });
    holder.source = source;
    await sandbox.load({ id: "stamp", kind: "code", source: FRAME_STAMP, sourceHash: await sha256Hex(FRAME_STAMP), width: 80, height: 80 });
    const progress: number[] = [];
    const result = await exportVideo(
      piece,
      { format: "mp4", codec: "avc", bitrate: 1, width: W * 2, height: H * 2, fps: FPS },
      (p) => progress.push(p),
      undefined,
      undefined,
      source,
      undefined,
      undefined,
      undefined,
      { frames: [30, 120] },
    );
    expect(renders).toBe(2);
    expect(captured.frames).toHaveLength(2);
    expect((await pixel(captured.frames[0], 40, 40))[0]).toBe(30);
    expect((await pixel(captured.frames[1], 40, 40))[0]).toBe(120);
    expect(progress).toEqual([0.5, 1]);
    expect(result.duration).toBeCloseTo(2 / FPS, 10); // the encoded file holds 2 frames
    // The frames it drew cleanly are the ones it rendered, not a range.
    expect(source.cleanFrames.get("stamp")).toEqual([[30, 31], [120, 121]]);
  });
});

/**
 * A body that reads the piece clock (`compositionTime`, `overlayStart`, `pieceDuration`) draws the
 * same in the preview and in the export (the duck bug was this class: a primitive that worked in
 * one path only). Both paths plan a body's request through `planLayer`, from different callers
 * (`renderFrame` → `drawOverlay` in the preview, `collectLayerRequests` in the export), so the
 * request is compared, then the pixels the export draws from it are read back.
 */
describe("a body that reads the piece clock renders identically in the preview and the export", () => {
  /** Paints its box rgb(compositionTime × 100, overlayStart × 100, pieceDuration × 10). */
  const CLOCK = `const { ctx, width, height, compositionTime, overlayStart, pieceDuration } = context;
ctx.fillStyle = "rgb(" + Math.round(compositionTime * 100) + "," + Math.round(overlayStart * 100) + "," + Math.round(pieceDuration * 10) + ")";
ctx.fillRect(0, 0, width, height);`;
  const clockOverlays = [
    // Starts at 0.4 s, so its OWN clock (time) is 0.4 s behind the piece's.
    { id: "clock", kind: "code", startTime: 0.4, duration: 1.2, z: 1, opacity: 1, rect: { x: 0, y: 0, width: 80, height: 80 }, drawFunction: CLOCK },
    // The piece's last thing: it ends at 2.0 s, so the piece is 20 frames at 10 fps.
    { id: "tail", kind: "code", startTime: 1.5, duration: 0.5, z: 0, opacity: 1, rect: { x: 100, y: 100, width: 80, height: 80 }, drawFunction: "context.ctx.fillStyle = '#00ff00'; context.ctx.fillRect(0, 0, context.width, context.height);" },
  ] as unknown as Overlay[];
  const clockPiece = { id: "c", name: "c", width: W, height: H, fps: FPS, overlays: clockOverlays } as Composition;
  const FRAMES = [5, 9, 14];

  /** The requests the PREVIEW makes: `renderFrame` asks its layer source for each body, one draw at a time. */
  function previewRequests(frame: number): LayerRequest[] {
    const asked: LayerRequest[] = [];
    const source: LayerSource = { get: () => null, request: (req) => void asked.push(req) };
    const canvas = createCanvas(W, H) as unknown as HTMLCanvasElement;
    renderFrame(canvas, clockPiece, frame, {}, undefined, undefined, source);
    return asked;
  }

  it("the preview and the export plan the SAME request, piece clock included, at every frame", () => {
    for (const frame of FRAMES) {
      const exportSide = collectLayerRequests(clockPiece, frame, 1).filter((r) => r.overlayId === "clock");
      const previewSide = previewRequests(frame).filter((r) => r.overlayId === "clock");
      expect(previewSide).toEqual(exportSide);
      expect(exportSide).toHaveLength(1);
      const t = exportSide[0]!.time;
      // overlayStart + the overlay's own clock IS the piece clock, and the piece is 2 s.
      expect(t.compositionTime).toBeCloseTo(frame / FPS, 9);
      expect(t.overlayStart).toBe(0.4);
      expect(t.pieceDuration).toBe(2);
      expect(t.overlayStart! + t.time).toBeCloseTo(t.compositionTime!, 9);
    }
  });

  it("the export draws the clock the request carries: a body reading compositionTime paints the piece's second, not its own", async () => {
    captured.frames = [];
    const holder: { source?: ExportLayerSource } = {};
    const sandbox = inMemorySandbox(() => holder.source!);
    const source = new ExportLayerSource((input) => sandbox.render(input));
    holder.source = source;
    for (const o of clockOverlays) {
      const src = (o as unknown as { drawFunction: string }).drawFunction;
      await sandbox.load({ id: o.id, kind: "code", source: src, sourceHash: await sha256Hex(src), width: o.rect.width, height: o.rect.height });
    }
    await exportVideo(clockPiece, { format: "mp4", codec: "avc", bitrate: 1, width: W * 2, height: H * 2, fps: FPS }, undefined, undefined, undefined, source, undefined, undefined, undefined, { frames: FRAMES });
    expect(captured.frames).toHaveLength(FRAMES.length);
    for (const [i, frame] of FRAMES.entries()) {
      // rgb(compositionTime × 100, overlayStart × 100, pieceDuration × 10) = (frame × 10, 40, 20)
      expect(await pixel(captured.frames[i]!, 40, 40), `frame ${frame}`).toEqual([frame * 10, 40, 20, 255]);
    }
  });
});
