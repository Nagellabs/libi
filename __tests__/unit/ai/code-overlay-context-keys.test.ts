import { describe, it, expect } from "vitest";
import { validateDrawFunction, createDrawFunction } from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";

describe("code overlay reads progress/duration from context", () => {
  const body = `
    const { ctx, width, height, progress, duration } = context;
    ctx.fillRect(0, 0, width * (progress ?? 0), height);
    return { progress, duration };
  `;

  it("validates (no disallowed pattern, parses)", () => {
    expect(validateDrawFunction(body).valid).toBe(true);
  });

  it("runs with element-local progress/duration in scope", () => {
    const fn = createDrawFunction(body, DRAW_HELPERS);
    const ctx = { fillRect: () => {} } as unknown as CanvasRenderingContext2D;
    const out = fn({ ctx, width: 100, height: 50, progress: 0.5, duration: 3 }) as
      { progress: number; duration: number };
    expect(out.progress).toBe(0.5);
    expect(out.duration).toBe(3);
  });
});
