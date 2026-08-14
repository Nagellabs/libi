import { describe, it, expect } from "vitest";
import { captionCanvasControl } from "@/lib/captions/canvas-control";
import type { TextOverlay } from "@/lib/engine/types";
const t = (o: Partial<TextOverlay>): TextOverlay => ({ id:"t", kind:"text", content:"x", font:"100px Inter", color:"#fff", align:"center", fontSize:40, startTime:0, duration:2, z:1, ...o } as TextOverlay);
describe("captionCanvasControl", () => {
  it("flat caption → 2D handles", () => expect(captionCanvasControl(t({}))).toBe("handles"));
  it("3D caption → gizmo", () => expect(captionCanvasControl(t({ threeD: { depth: 20 } }))).toBe("gizmo"));
});
