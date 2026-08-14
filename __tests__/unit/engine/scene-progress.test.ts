// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderFrame } from "@/lib/engine/renderer";
import type { Composition, DrawContext } from "@/lib/engine/types";

describe("scene draw context progress/duration", () => {
  it("passes element-local progress + duration to a canvas scene", () => {
    let seen: DrawContext | null = null;
    const comp: Composition = {
      id: "c", name: "c", width: 100, height: 100, fps: 30,
      scenes: [
        { id: "s1", name: "s1", type: "canvas", duration: 2,
          draw: (ctx) => { seen = ctx; } },
      ],
    };
    const canvas = document.createElement("canvas");
    // Provide a minimal 2D context mock so renderFrame can proceed
    const mockCtx = {
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(),
      fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(),
      beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      translate: vi.fn(), scale: vi.fn(),
      font: "", textAlign: "left", textBaseline: "alphabetic",
      fillStyle: "#000", globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(canvas, "getContext").mockReturnValue(mockCtx as never);
    // global frame 30 → 1s into a 2s scene → progress 0.5
    renderFrame(canvas, comp, 30);
    expect(seen).not.toBeNull();
    expect(seen!.duration).toBe(2);
    expect(seen!.time).toBeCloseTo(1);
    expect(seen!.progress).toBeCloseTo(0.5);
  });
});
