import { describe, it, expect } from "vitest";
import { classifyStoragePath } from "@/lib/storage-watch/watcher";

describe("storage path dispatch", () => {
  it("routes storyboard paths", () => {
    expect(classifyStoragePath("p1/storyboard/cards/c1/card.json")).toEqual({ kind: "storyboard", pieceId: "p1" });
  });
  it("routes overlay code files", () => {
    expect(classifyStoragePath("p1/overlays/three-1/scene.jsx")).toEqual({ kind: "overlay", pieceId: "p1" });
    expect(classifyStoragePath("p2/overlays/code-9/draw.jsx")).toEqual({ kind: "overlay", pieceId: "p2" });
  });
  it("ignores unrelated paths", () => {
    expect(classifyStoragePath("p1/composition.json")).toBeNull();
    expect(classifyStoragePath("p1/overlays/x/sketches/y.png")).toBeNull(); // not a code file
  });
});
