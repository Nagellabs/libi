import { describe, it, expect } from "vitest";
import { transform3dSchema } from "@/lib/composition/persistence";

describe("transform3dSchema", () => {
  it("parses a valid Transform3D with position and rotation", () => {
    const input = {
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0.1, y: 0.2, z: 0.3 },
    };
    const result = transform3dSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("transform3dSchema (the canonical shape) drops an unknown scale key when applied", () => {
    const input = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      // stale field from before the Transform3D refactor
      scale: { x: 1, y: 1, z: 1 },
    };
    const result = transform3dSchema.parse(input);
    // NB: loadManifest casts JSON directly; a stray legacy scale is harmless (no runtime reader uses it).
    // This asserts the schema is the canonical 2-field shape.
    // Zod's default strip mode silently drops unknown keys.
    expect(result).not.toHaveProperty("scale");
    expect(result).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });
  });

  it("rejects a value missing the required position field", () => {
    expect(() =>
      transform3dSchema.parse({ rotation: { x: 0, y: 0, z: 0 } }),
    ).toThrow();
  });

  it("rejects a value missing the required rotation field", () => {
    expect(() =>
      transform3dSchema.parse({ position: { x: 0, y: 0, z: 0 } }),
    ).toThrow();
  });
});
