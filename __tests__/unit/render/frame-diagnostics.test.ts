import { describe, it, expect } from "vitest";
import { diagnosticsForFrames } from "@/lib/render/frame-diagnostics";
import type { RenderDiagnostic } from "@/lib/render/render-diagnostics-types";
import type { Overlay } from "@/lib/engine/types";

const overlay = (id: string, startTime: number, duration: number): Overlay =>
  ({ id, kind: "code", drawFunction: "1;", startTime, duration, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }) as unknown as Overlay;

const diag = (overlayId: string, phase: RenderDiagnostic["phase"], extra: Partial<RenderDiagnostic> = {}): RenderDiagnostic => ({
  overlayId,
  kind: "code",
  phase,
  message: "heart is not defined",
  at: 1,
  ...extra,
});

describe("diagnosticsForFrames", () => {
  const overlays = [overlay("a", 0, 2), overlay("b", 5, 2)];
  const frames = [{ frame: 30, frameTime: 1 }];

  it("keeps a render error on a frame this pass drew", () => {
    const d = diag("a", "render", { frame: 30, time: 1 });
    expect(diagnosticsForFrames([d], overlays, frames)).toEqual([d]);
  });

  it("drops a render error on a frame this pass did not draw", () => {
    expect(diagnosticsForFrames([diag("a", "render", { frame: 90 })], overlays, frames)).toEqual([]);
  });

  it("keeps a compile/build failure of an overlay that is on screen", () => {
    const d = diag("a", "compile");
    expect(diagnosticsForFrames([d], overlays, frames)).toEqual([d]);
  });

  it("drops a failure of an overlay that is not on screen at any rendered frame", () => {
    expect(diagnosticsForFrames([diag("b", "compile"), diag("b", "render", { frame: 30 })], overlays, frames)).toEqual([]);
  });

  it("keeps a frameless render failure (an async escape, a timeout) while its overlay is on screen", () => {
    const d = diag("a", "render");
    expect(diagnosticsForFrames([d], overlays, frames)).toEqual([d]);
  });
});
