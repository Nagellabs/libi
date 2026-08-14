import { describe, it, expect } from "vitest";
import { applyOverlayTransform } from "@/lib/engine/overlay-renderer";
import { hitTest } from "@/lib/engine/overlays";
import type { TextOverlay } from "@/lib/engine/types";

const box = { x: 0, y: 0, width: 100, height: 100 };

function recCtx() {
  const ops: string[] = [];
  return {
    ops,
    translate: (x: number, y: number) => ops.push(`t:${Math.round(x)},${Math.round(y)}`),
    rotate: (r: number) => ops.push(`r:${r.toFixed(3)}`),
    scale: (x: number, y: number) => ops.push(`s:${x},${y}`),
  } as unknown as CanvasRenderingContext2D & { ops: string[] };
}

describe("applyOverlayTransform from transform3d (planar)", () => {
  it("no-ops for the identity overlay", () => {
    const ctx = recCtx();
    applyOverlayTransform(ctx, box, {});
    expect(ctx.ops).toEqual([]);
  });

  it("a transform3d z-roll produces a center-anchored rotate", () => {
    const ctx = recCtx();
    const t3d = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.PI / 2 } };
    applyOverlayTransform(ctx, box, { transform3d: t3d });
    expect(ctx.ops).toEqual(["t:50,50", `r:${(Math.PI / 2).toFixed(3)}`, "s:1,1", "t:-50,-50"]);
  });

  it("transform3d positional offset translates the overlay", () => {
    const ctx = recCtx();
    const t3d = { position: { x: 20, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    applyOverlayTransform(ctx, box, { transform3d: t3d });
    expect(ctx.ops).toEqual(["t:70,50", "r:0.000", "s:1,1", "t:-50,-50"]);
  });
});

describe("hitTest honors transform3d position", () => {
  it("selects an overlay shifted +40px in x when clicked at the shifted center", () => {
    const t3d = { position: { x: 40, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const overlay: TextOverlay = {
      id: "o1", kind: "text", content: "x", font: "10px Inter", color: "#fff", align: "left",
      startTime: 0, duration: 5, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 100, height: 100 },
      transform3d: t3d,
    };
    expect(hitTest(90, 50, [overlay], 1)?.id).toBe("o1");
    expect(hitTest(5, 50, [overlay], 1)).toBeNull();
  });
});
