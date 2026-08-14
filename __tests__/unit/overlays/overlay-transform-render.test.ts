// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { applyOverlayTransform } from "@/lib/engine/overlay-renderer";

function mkMockCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const ctx = {
    translate: record("translate"),
    rotate: record("rotate"),
    scale: record("scale"),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const rect = { x: 100, y: 50, width: 200, height: 100 }; // center (200, 100)

describe("applyOverlayTransform", () => {
  it("identity transform is a no-op (no ctx mutations)", () => {
    const { ctx, calls } = mkMockCtx();
    applyOverlayTransform(ctx, rect, {});
    expect(calls).toHaveLength(0);
  });

  it("z-roll 0 / flip:false is also a no-op", () => {
    const { ctx, calls } = mkMockCtx();
    applyOverlayTransform(ctx, rect, {
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      flipH: false,
      flipV: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("z-roll only: translate(cx,cy) → rotate(rad) → translate(-cx,-cy)", () => {
    const { ctx, calls } = mkMockCtx();
    applyOverlayTransform(ctx, rect, {
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (90 * Math.PI) / 180 } },
    });
    expect(calls.map((c) => c.name)).toEqual(["translate", "rotate", "scale", "translate"]);
    expect(calls[0].args).toEqual([200, 100]);
    expect(calls[1].args).toEqual([(90 * Math.PI) / 180]);
    // scale stays identity when no flip
    expect(calls[2].args).toEqual([1, 1]);
    expect(calls[3].args).toEqual([-200, -100]);
  });

  it("flipH only: scale(-1, 1) about the center", () => {
    const { ctx, calls } = mkMockCtx();
    applyOverlayTransform(ctx, rect, { flipH: true });
    expect(calls.map((c) => c.name)).toEqual(["translate", "rotate", "scale", "translate"]);
    expect(calls[1].args).toEqual([0]); // no rotation
    expect(calls[2].args).toEqual([-1, 1]);
  });

  it("combined z-roll + flipV", () => {
    const { ctx, calls } = mkMockCtx();
    applyOverlayTransform(ctx, rect, {
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (45 * Math.PI) / 180 } },
      flipV: true,
    });
    expect(calls[1].args).toEqual([(45 * Math.PI) / 180]);
    expect(calls[2].args).toEqual([1, -1]);
  });
});

import { drawOverlay } from "@/lib/engine/overlay-renderer";
import type { TextOverlay } from "@/lib/engine/types";

function mkFullCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) =>
    (...args: unknown[]) => calls.push({ name, args });
  const ctx = {
    save: record("save"),
    restore: record("restore"),
    fillText: record("fillText"),
    translate: record("translate"),
    rotate: record("rotate"),
    scale: record("scale"),
    globalAlpha: 1,
    font: "",
    fillStyle: "",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("drawOverlay applies the transform wrapper", () => {
  const baseText: TextOverlay = {
    id: "t",
    kind: "text",
    content: "hi",
    font: "16px Inter",
    color: "#fff",
    align: "left",
    opacity: 1,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    startTime: 0,
    duration: 1,
    z: 0,
  };

  it("rotated text overlay calls rotate before fillText", () => {
    const { ctx, calls } = mkFullCtx();
    drawOverlay(
      { ...baseText, transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: (30 * Math.PI) / 180 } } },
      { ctx, width: 200, height: 200, fps: 30, totalFrames: 1, frame: 0, time: 0.5, assets: {} },
    );
    const names = calls.map((c) => c.name);
    expect(names).toContain("rotate");
    expect(names.indexOf("rotate")).toBeLessThan(names.indexOf("fillText"));
  });

  it("non-transformed text overlay does NOT call rotate", () => {
    const { ctx, calls } = mkFullCtx();
    drawOverlay(
      baseText,
      { ctx, width: 200, height: 200, fps: 30, totalFrames: 1, frame: 0, time: 0.5, assets: {} },
    );
    expect(calls.map((c) => c.name)).not.toContain("rotate");
  });
});
