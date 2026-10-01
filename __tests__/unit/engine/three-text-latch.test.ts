// @vitest-environment jsdom
/**
 * A three overlay's `Text` label must put the SAME pixels on every export of the same frame.
 *
 * The overlay-sandbox golden (e2e/overlay-sandbox-golden.spec.ts) dropped its `Parity` label because
 * about one run in three differed on the label's glyphs. The suspected cause was a texture used a
 * frame late: the label drawn after a font load, `needsUpdate` set on the next frame. Instrumenting
 * the real export path disproved it: the label is drawn synchronously at build, its metrics were
 * identical on every run, and `needsUpdate` is set before the first render (pinned below). What
 * varied was the label canvas ITSELF. Hashed right after `fillText`, the same text at the same size
 * in the same face gave three different bitmaps in eight runs, because the canvas was a GPU-backed
 * 2D context and its large-glyph rasterization isn't repeatable. A CPU-backed context
 * (`willReadFrequently`) gave one bitmap in twelve out of twelve runs, and the golden with the label
 * went byte-identical. So the label's context must be asked for that way, on the host (a DOM
 * canvas) and in the sandbox worker (an OffscreenCanvas), since the first `getContext` fixes a
 * canvas's backing for good.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const events: string[] = [];

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  /** A CanvasTexture that records when it is flagged for upload, and what its canvas held then. */
  class RecordingCanvasTexture<T> extends actual.CanvasTexture<T> {
    override set needsUpdate(value: boolean) {
      const image = this.image as unknown as FakeCanvas;
      events.push(`needsUpdate ${image.width}x${image.height} drawn=${image.drawn}`);
      super.needsUpdate = value;
    }
  }
  return { ...actual, CanvasTexture: RecordingCanvasTexture };
});

import * as THREE from "three";
import { makeCanvasTextClass } from "@/lib/engine/canvas-text";
import { buildThreeInstance, type SharedThreeRenderer } from "@/lib/engine/three-overlay";

interface FakeCanvas {
  width: number;
  height: number;
  drawn: boolean;
  getContext: ReturnType<typeof vi.fn>;
}

/** A canvas whose 2D context records its draws; `getContext` is a spy so the requested attributes can be read. */
function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 2,
    height: 2,
    drawn: false,
    getContext: vi.fn(() => ({
      font: "",
      textAlign: "center",
      textBaseline: "middle",
      fillStyle: "#000",
      strokeStyle: "#000",
      lineJoin: "round",
      lineWidth: 1,
      shadowColor: "transparent",
      shadowBlur: 0,
      clearRect: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(() => {
        canvas.drawn = true;
        events.push(`fillText ${canvas.width}x${canvas.height}`);
      }),
      measureText: (s: string) =>
        ({ width: s.length * 90, actualBoundingBoxAscent: 137, actualBoundingBoxDescent: 40 }) as TextMetrics,
    })),
  };
  return canvas;
}

let canvases: FakeCanvas[];

beforeEach(() => {
  events.length = 0;
  canvases = [];
  const original = Document.prototype.createElement;
  vi.spyOn(document, "createElement").mockImplementation(function (this: Document, tag: string, ...rest: unknown[]) {
    if (tag !== "canvas") return (original as (t: string, ...r: unknown[]) => HTMLElement).call(this, tag, ...rest);
    const canvas = fakeCanvas();
    canvases.push(canvas);
    return canvas as unknown as HTMLElement;
  } as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a three.js Text label's canvas", () => {
  it("is a CPU-backed 2D context on the host, so the same label rasterizes to the same bitmap every time", () => {
    const CanvasText = makeCanvasTextClass(THREE);
    const label = new CanvasText();
    label.text = "Parity";
    label.sync();
    expect(canvases).toHaveLength(1);
    expect(canvases[0].getContext).toHaveBeenCalled();
    for (const call of canvases[0].getContext.mock.calls) expect(call).toEqual(["2d", { willReadFrequently: true }]);
  });

  it("is a CPU-backed 2D context in the sandbox worker too, where it is an OffscreenCanvas", () => {
    const offscreen: FakeCanvas[] = [];
    vi.stubGlobal("document", undefined);
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor() {
          const canvas = fakeCanvas();
          offscreen.push(canvas);
          return canvas;
        }
      },
    );
    const CanvasText = makeCanvasTextClass(THREE);
    const label = new CanvasText();
    label.text = "Parity";
    label.sync();
    expect(offscreen).toHaveLength(1);
    expect(offscreen[0].getContext).toHaveBeenCalled();
    for (const call of offscreen[0].getContext.mock.calls) expect(call).toEqual(["2d", { willReadFrequently: true }]);
  });
});

describe("a three.js Text label on the frame it is first rendered", () => {
  it("is drawn and flagged for upload before that frame's render, at its final size", async () => {
    const renderer = {
      domElement: { width: 0, height: 0 },
      setSize: vi.fn(),
      render: vi.fn((scene: import("three").Scene) => {
        const labels: string[] = [];
        scene.traverse((obj) => {
          const map = ((obj as import("three").Mesh).material as import("three").MeshBasicMaterial | undefined)?.map;
          if (map) labels.push(`v${map.version}`);
        });
        events.push(`render ${labels.join(",")}`);
      }),
    };
    const shared = { renderer } as unknown as SharedThreeRenderer;
    const body = `
const label = new Text();
label.text = "Parity";
label.fontSize = 0.6;
label.position.set(0, -1.4, 0);
scene.add(label);
return () => {};
`;
    const inst = await buildThreeInstance(body, "billboard", shared, { width: 480, height: 360 });
    await inst.ready;
    inst.render(480, 360);

    const drawn = events.findIndex((e) => e.startsWith("fillText"));
    const flagged = events.findIndex((e) => e.startsWith("needsUpdate") && e.endsWith("drawn=true"));
    const rendered = events.findIndex((e) => e.startsWith("render"));
    expect(drawn, events.join(" | ")).toBeGreaterThanOrEqual(0);
    // Drawn, THEN flagged (with the drawn canvas at its final size), THEN rendered: the upload for this
    // frame sees the label, not the 2x2 blank it was constructed with.
    expect(flagged, events.join(" | ")).toBeGreaterThan(drawn);
    expect(rendered, events.join(" | ")).toBeGreaterThan(flagged);
    expect(events[flagged]).toBe(`needsUpdate ${events[drawn].split(" ")[1]} drawn=true`);
    expect(events[flagged]).not.toContain("2x2");
    // The texture the render samples has a pending version (three uploads when version > its last upload).
    expect(events[rendered]).toMatch(/^render v[1-9]/);
    inst.dispose();
  });
});
