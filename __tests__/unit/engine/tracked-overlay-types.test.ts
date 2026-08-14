import { describe, it, expect } from "vitest";
import type { Overlay, TrackedOverlay } from "@/lib/engine/types";

describe("TrackedOverlay", () => {
  it("is assignable to Overlay union", () => {
    const o: TrackedOverlay = {
      id: "ov-1",
      kind: "tracked",
      startTime: 0,
      duration: 5,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 10,
      opacity: 1,
      trackId: "trk-1",
      content: { kind: "emoji", char: "😀" },
      fit: "tight",
      scale: 1.0,
      smoothing: "linear",
    };
    const u: Overlay = o;
    expect(u.kind).toBe("tracked");
  });
});
