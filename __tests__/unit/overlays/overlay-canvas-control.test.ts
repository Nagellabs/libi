import { describe, it, expect } from "vitest";
import { overlayCanvasControl } from "@/lib/captions/canvas-control";
import type { CodeOverlay, TextOverlay, ThreeOverlay } from "@/lib/engine/types";

const rect = { x: 0, y: 0, width: 10, height: 10 };
const mk = (over: Partial<CodeOverlay>): CodeOverlay =>
  ({ id: "c", kind: "code", startTime: 0, duration: 1, z: 0, rect, opacity: 1, drawFunction: "", ...over } as CodeOverlay);

describe("overlayCanvasControl", () => {
  it("flat overlay → 2D handles", () => {
    expect(overlayCanvasControl(mk({}))).toBe("handles");
  });
  it("place3d overlay → orbit gizmo", () => {
    expect(overlayCanvasControl(mk({ place3d: true }))).toBe("gizmo");
  });
  it("three → gizmo always", () => {
    const three = { id: "x", kind: "three", startTime: 0, duration: 1, z: 0, rect, opacity: 1, sceneFunction: "" } as ThreeOverlay;
    expect(overlayCanvasControl(three)).toBe("gizmo");
  });
  it("3D text caption → gizmo", () => {
    const t = { id: "t", kind: "text", startTime: 0, duration: 1, z: 0, rect, opacity: 1, content: "x", threeD: { depth: 20 } } as TextOverlay;
    expect(overlayCanvasControl(t)).toBe("gizmo");
  });
});
