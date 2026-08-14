import { describe, it, expect } from "vitest";
import { overlaysActiveAt } from "@/lib/engine/overlays";
import type { TextOverlay } from "@/lib/engine/types";

function mkText(overrides: Partial<TextOverlay>): TextOverlay {
  return {
    id: "o1", kind: "text", content: "hi", font: "16px Inter",
    color: "#fff", align: "left", opacity: 1,
    rect: { x: 0, y: 0, width: 100, height: 20 },
    startTime: 0, duration: 1, z: 0, ...overrides,
  };
}

describe("overlaysActiveAt", () => {
  it("includes overlays whose [start, start+duration) contains time", () => {
    const overlays = [mkText({ id: "a", startTime: 0, duration: 1 })];
    expect(overlaysActiveAt(overlays, 0.5).map((o) => o.id)).toEqual(["a"]);
  });

  it("excludes overlays before start", () => {
    const overlays = [mkText({ id: "a", startTime: 1, duration: 1 })];
    expect(overlaysActiveAt(overlays, 0.5)).toEqual([]);
  });

  it("is exclusive at the end (time === start+duration is out)", () => {
    const overlays = [mkText({ id: "a", startTime: 0, duration: 1 })];
    expect(overlaysActiveAt(overlays, 1)).toEqual([]);
  });

  it("handles zero-duration as a single-frame hit at start", () => {
    const overlays = [mkText({ id: "a", startTime: 0, duration: 0 })];
    expect(overlaysActiveAt(overlays, 0)).toEqual([]); // zero-duration = always off
  });

  it("returns overlays sorted ascending by z (bottom first)", () => {
    const overlays = [
      mkText({ id: "a", z: 2 }),
      mkText({ id: "b", z: 0 }),
      mkText({ id: "c", z: 1 }),
    ];
    expect(overlaysActiveAt(overlays, 0.5).map((o) => o.id)).toEqual(["b", "c", "a"]);
  });
});
