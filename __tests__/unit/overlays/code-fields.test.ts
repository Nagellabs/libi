import { describe, it, expect } from "vitest";
import {
  overlayCodeFile, getOverlayBody, setOverlayBody, overlayHasCode,
} from "@/lib/overlays/code-fields";
import type { PersistedOverlay } from "@/lib/composition/persistence";

const code: PersistedOverlay = { id: "c1", kind: "code", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, drawFunction: "ctx.fillRect(0,0,1,1)" };
const three: PersistedOverlay = { id: "t1", kind: "three", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, sceneFunction: "scene.add(x)" };
const trackedCode: PersistedOverlay = { id: "k1", kind: "tracked", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, trackId: "tr", content: { kind: "code", drawFunction: "ctx.arc()" }, fit: "rect", scale: 1, smoothing: "linear" };
const text: PersistedOverlay = { id: "x1", kind: "text", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, content: "hi", font: "20px sans", color: "#fff", align: "center" };

describe("overlay code fields", () => {
  it("identifies code-bearing overlays", () => {
    expect(overlayHasCode(code)).toBe(true);
    expect(overlayHasCode(three)).toBe(true);
    expect(overlayHasCode(trackedCode)).toBe(true);
    expect(overlayHasCode(text)).toBe(false);
  });

  it("maps each to its filename", () => {
    expect(overlayCodeFile(code)).toBe("draw.jsx");
    expect(overlayCodeFile(three)).toBe("scene.jsx");
    expect(overlayCodeFile(trackedCode)).toBe("content.jsx");
    expect(overlayCodeFile(text)).toBeNull();
  });

  it("gets the body", () => {
    expect(getOverlayBody(code)).toBe("ctx.fillRect(0,0,1,1)");
    expect(getOverlayBody(three)).toBe("scene.add(x)");
    expect(getOverlayBody(trackedCode)).toBe("ctx.arc()");
    expect(getOverlayBody(text)).toBeNull();
  });

  it("sets the body immutably", () => {
    const next = setOverlayBody(code, "NEW");
    expect(getOverlayBody(next)).toBe("NEW");
    expect(getOverlayBody(code)).toBe("ctx.fillRect(0,0,1,1)"); // unchanged
    const nextTracked = setOverlayBody(trackedCode, "NEW2");
    expect(getOverlayBody(nextTracked)).toBe("NEW2");
  });
});
