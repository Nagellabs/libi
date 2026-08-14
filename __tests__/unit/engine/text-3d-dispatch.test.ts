// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { Overlay, TextOverlay } from "@/lib/engine/types";
import type { ThreeOverlayInstance } from "@/lib/engine/three-overlay";

function makeMockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(() => calls.push({ fn: "save", args: [] })),
    restore: vi.fn(() => calls.push({ fn: "restore", args: [] })),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn((...args: unknown[]) => calls.push({ fn: "fillText", args })),
    drawImage: vi.fn((...args: unknown[]) => calls.push({ fn: "drawImage", args })),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    set globalAlpha(_v: number) {},
    get globalAlpha() { return 1; },
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "#000" as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    set filter(_v: string) {},
    get filter() { return "none"; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function makeStubInstance(): { inst: ThreeOverlayInstance; renderSpy: ReturnType<typeof vi.fn>; updateSpy: ReturnType<typeof vi.fn> } {
  const fakeCanvas = { width: 100, height: 100 } as unknown as HTMLCanvasElement;
  const renderSpy = vi.fn(() => fakeCanvas);
  const updateSpy = vi.fn();
  const inst: ThreeOverlayInstance = {
    update: updateSpy,
    applyTransform: vi.fn(),
    render: renderSpy,
    dispose: vi.fn(),
    contentBoundsNDC: () => null,
    ready: Promise.resolve(),
  };
  return { inst, renderSpy, updateSpy };
}

const baseText: TextOverlay = {
  id: "t1",
  kind: "text",
  startTime: 0,
  duration: 2,
  rect: { x: 10, y: 20, width: 400, height: 100 },
  z: 1,
  opacity: 1,
  content: "Hello",
  font: "48px Inter",
  color: "#ffffff",
  align: "center",
};

const drawCtxBase = {
  width: 1920,
  height: 1080,
  fps: 30,
  totalFrames: 60,
  frame: 15,
  time: 0.5,
  assets: {},
} as const;

describe("3D text dispatch in the renderer", () => {
  it("renders via the three instance (drawImage + render, NOT fillText) when threeD + instance present", () => {
    const { ctx, calls } = makeMockCtx();
    const { inst, renderSpy, updateSpy } = makeStubInstance();
    const overlay: Overlay = { ...baseText, threeD: { depth: 4 } };
    drawOverlay(overlay, {
      ctx,
      ...drawCtxBase,
      threeScenes: { t1: inst },
    } as unknown as DrawOverlayContext);

    // Window model (matches `case "three"`): render INTO the rect-sized viewport,
    // no content-bounds expansion args. Keeps 3D text inside its gizmo box and
    // following drags 1:1 (the expansion drew it offset, outside the box).
    expect(renderSpy).toHaveBeenCalledWith(400, 100);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.fn === "drawImage")).toBeTruthy();
    expect(calls.find((c) => c.fn === "fillText")).toBeUndefined();
  });

  it("falls back to the flat text path when threeD is present but NO instance is ready", () => {
    const { ctx, calls } = makeMockCtx();
    const overlay: Overlay = { ...baseText, threeD: { depth: 4 } };
    drawOverlay(overlay, {
      ctx,
      ...drawCtxBase,
      threeScenes: {}, // not yet built
    } as unknown as DrawOverlayContext);

    expect(calls.find((c) => c.fn === "fillText")).toBeTruthy();
    expect(calls.find((c) => c.fn === "drawImage")).toBeUndefined();
  });

  it("uses the flat path for a plain (non-3D) text overlay even if an instance exists for another id", () => {
    const { ctx, calls } = makeMockCtx();
    const { inst } = makeStubInstance();
    const overlay: Overlay = { ...baseText }; // no threeD
    drawOverlay(overlay, {
      ctx,
      ...drawCtxBase,
      threeScenes: { other: inst },
    } as unknown as DrawOverlayContext);

    expect(calls.find((c) => c.fn === "fillText")).toBeTruthy();
    expect(calls.find((c) => c.fn === "drawImage")).toBeUndefined();
  });
});
