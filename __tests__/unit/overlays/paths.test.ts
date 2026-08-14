import { describe, it, expect } from "vitest";
import { overlayDir, overlayCodeRelPath, OVERLAYS_DIR } from "@/lib/overlays/paths";

describe("overlay paths", () => {
  it("derives the overlay dir from id", () => {
    expect(overlayDir("three-abc")).toBe("overlays/three-abc");
    expect(OVERLAYS_DIR).toBe("overlays");
  });

  it("maps kind to the code filename", () => {
    expect(overlayCodeRelPath("code-1", "draw.jsx")).toBe("overlays/code-1/draw.jsx");
    expect(overlayCodeRelPath("three-1", "scene.jsx")).toBe("overlays/three-1/scene.jsx");
    expect(overlayCodeRelPath("t-1", "content.jsx")).toBe("overlays/t-1/content.jsx");
  });

  it("rejects path traversal in the overlay id", () => {
    expect(() => overlayDir("../escape")).toThrow();
    expect(() => overlayCodeRelPath("../x", "draw.jsx")).toThrow();
  });
});
