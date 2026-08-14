import { describe, it, expect } from "vitest";
import type { TextOverlay } from "@/lib/engine/types";

describe("point-text TextOverlay fields", () => {
  it("TextOverlay carries anchor + optional maxWidthPct; rect still present (derived)", () => {
    const o: TextOverlay = {
      id: "t",
      kind: "text",
      startTime: 0,
      duration: 2,
      z: 1,
      opacity: 1,
      content: "Hi",
      font: "64px Inter",
      color: "#fff",
      align: "center",
      fontSize: 64,
      rect: { x: 0, y: 0, width: 100, height: 40 },
      anchor: "top-center",
      maxWidthPct: 0.8,
    };
    expect(o.anchor).toBe("top-center");
    expect(o.maxWidthPct).toBe(0.8);
  });
});
