import { describe, it, expect } from "vitest";
import { overlayHasNonIdentityTransform } from "@/lib/export/overlay-predicates";
import type { Overlay } from "@/lib/engine/types";

describe("overlayHasNonIdentityTransform: transform3d routing", () => {
  it("treats a spatial transform3d as non-identity (routes to chromium-render)", () => {
    const spatial: Overlay = {
      id: "o", kind: "image", fileId: "f", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0.4, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    };
    expect(overlayHasNonIdentityTransform(spatial)).toBe(true);
  });

  it("treats a planar transform3d (z-rot only) as non-identity too", () => {
    const planar: Overlay = {
      id: "o", kind: "image", fileId: "f", startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.2 }, scale: { x: 1, y: 1, z: 1 } },
    };
    expect(overlayHasNonIdentityTransform(planar)).toBe(true);
  });
});
