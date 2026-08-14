// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, TextOverlay } from "@/lib/engine/types";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";

/** Recording 2D ctx: logs fillText (with the drawn string) + supports the
 *  props the renderer reads back. measureText → len*10 for deterministic wrap. */
function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    strokeText: vi.fn((...args: unknown[]) => calls.push({ fn: "strokeText", args })),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => calls.push({ fn: "drawImage", args })),
    measureText: vi.fn((s: string) => ({ width: s.length * 10 })),
    set globalAlpha(v: number) { (this as unknown as Record<string, unknown>)._a = v; },
    get globalAlpha() { return ((this as unknown as Record<string, unknown>)._a ?? 1) as number; },
    set filter(v: string) { (this as unknown as Record<string, unknown>)._f = v; },
    get filter() { return ((this as unknown as Record<string, unknown>)._f ?? "none") as string; },
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "#000" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

// "Hello world" so typewriter has multiple chars to reveal progressively.
const typewriterText: TextOverlay = {
  id: "tx",
  kind: "text",
  startTime: 0,
  duration: 2,
  rect: { x: 100, y: 200, width: 800, height: 120 },
  z: 10,
  opacity: 1,
  content: "Hello world",
  font: "48px Inter",
  fontSize: 48,
  color: "#ffffff",
  align: "left",
  reveal: { mode: "typewriter" },
};

function render(overlay: Overlay, time: number, extra?: Partial<DrawOverlayContext>) {
  const { ctx, calls } = makeMockCtx();
  drawOverlay(overlay, {
    ctx,
    width: 1920,
    height: 1080,
    fps: 30,
    totalFrames: 60,
    frame: Math.round(time * 30),
    time,
    assets: {},
    ...extra,
  } as DrawOverlayContext);
  return { ctx, calls };
}

/** Longest fillText string drawn (the visible typed text on the 2D path). */
function longestFill(calls: { fn: string; args: unknown[] }[]): string {
  return calls
    .filter((c) => c.fn === "fillText")
    .map((c) => String(c.args[0]))
    .reduce((a, b) => (b.length > a.length ? b : a), "");
}

describe("text reveal — 2D path animates (typewriter)", () => {
  it("(a) plain 2D: typed text is SHORTER early than late", () => {
    const early = longestFill(render(typewriterText, 0.1).calls);
    const late = longestFill(render(typewriterText, 1.9).calls);
    expect(early.length).toBeLessThan(late.length);
    expect(late.length).toBeGreaterThan(0);
  });

  it("(b) 2D + planar rotation: typewriter STILL progresses", () => {
    const rotated = {
      ...typewriterText,
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (30 * Math.PI) / 180 } },
    };
    const early = longestFill(render(rotated, 0.1).calls);
    const late = longestFill(render(rotated, 1.9).calls);
    expect(early.length).toBeLessThan(late.length);
  });
});

describe("text reveal — 3D extruded path (threeD)", () => {
  /** Stub a three instance: records every `update({progress})` call. Its render
   *  returns a canvas so drawImage runs. The 2D fillText path must NOT fire. */
  function stubThreeInstance() {
    const progresses: number[] = [];
    const canvas = { width: 1, height: 1 } as unknown as HTMLCanvasElement;
    const inst: ThreeOverlayInstance = {
      update: (api) => { progresses.push(api.progress); },
      applyTransform: () => {},
      render: () => canvas,
      dispose: () => {},
      contentBoundsNDC: () => null,
      ready: Promise.resolve(),
    };
    return { inst, progresses };
  }

  it("(c) threeD typewriter: reveal progress reaches the 3D instance; 2D fillText is NOT used", () => {
    const threeText: TextOverlay = { ...typewriterText, threeD: { depth: 20 } };
    const { inst: instEarly, progresses: pEarly } = stubThreeInstance();
    const earlyCalls = render(threeText, 0.1, { threeScenes: { tx: instEarly } }).calls;

    const { inst: instLate, progresses: pLate } = stubThreeInstance();
    const lateCalls = render(threeText, 1.9, { threeScenes: { tx: instLate } }).calls;

    // The 3D instance owns rendering — it gets the element-local progress, and it
    // is LOWER early than late (so per-glyph reveal inside the instance can play).
    expect(pEarly.length).toBe(1);
    expect(pLate.length).toBe(1);
    expect(pEarly[0]).toBeLessThan(pLate[0]);

    // Crucially: the flat 2D drawTextOverlay path is bypassed (no fillText) — the
    // extruded instance is drawn via drawImage instead.
    expect(earlyCalls.find((c) => c.fn === "fillText")).toBeUndefined();
    expect(earlyCalls.find((c) => c.fn === "drawImage")).toBeDefined();
    void lateCalls;
  });

  // The 3D path now implements per-letter/word reveal for EVERY mode: typewriter /
  // word-current / karaoke / flythrough toggle per-glyph visibility/scale, and
  // fade-words / slide-up / pop run a per-word transform stagger (glyphRevealState
  // in word-reveal.ts, unit-tested in text-3d-word-reveal.test.ts). This test pins
  // the renderer's contract — element-local progress reaches the instance every
  // frame — which is what lets any of those modes animate.
  it("(c') threeD fade-words: progress reaches the instance every frame (renderer contract)", () => {
    const threeFade: TextOverlay = {
      ...typewriterText,
      threeD: { depth: 20 },
      reveal: { mode: "fade-words" },
    };
    const { inst: instEarly, progresses: pEarly } = stubThreeInstance();
    render(threeFade, 0.1, { threeScenes: { tx: instEarly } });
    const { inst: instLate, progresses: pLate } = stubThreeInstance();
    render(threeFade, 1.9, { threeScenes: { tx: instLate } });
    // The renderer feeds progress every frame; whether fade-words plays in 3D is
    // up to the instance (currently it shows-all — the documented limitation).
    expect(pEarly[0]).toBeLessThan(pLate[0]);
  });
});
