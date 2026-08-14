import { describe, it, expect } from "vitest";
import type { TextOverlay, BaseOverlay } from "@/lib/engine/types";

// A compile-level/structural test: the new transform + group fields must be
// OPTIONAL on BaseOverlay (so existing overlays without them still type-check)
// and ACCEPTED when present. If the fields are missing from BaseOverlay, the
// typed `withTransform` literal below fails `tsc` and this file won't compile.
describe("BaseOverlay transform fields", () => {
  const base: BaseOverlay = {
    id: "o1",
    startTime: 0,
    duration: 5,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 100 },
    opacity: 1,
  };

  it("accepts an overlay WITHOUT any transform fields (all optional)", () => {
    const o: TextOverlay = {
      ...base,
      kind: "text",
      content: "hi",
      font: "48px Inter",
      color: "#fff",
      align: "center",
    };
    expect(o.flipH).toBeUndefined();
    expect(o.flipV).toBeUndefined();
    expect(o.group).toBeUndefined();
  });

  it("accepts an overlay WITH transform + group fields set", () => {
    const o: TextOverlay = {
      ...base,
      kind: "text",
      content: "hi",
      font: "48px Inter",
      color: "#fff",
      align: "center",
      flipH: true,
      flipV: false,
      group: "captions",
    };
    expect(o.flipH).toBe(true);
    expect(o.flipV).toBe(false);
    expect(o.group).toBe("captions");
  });
});
