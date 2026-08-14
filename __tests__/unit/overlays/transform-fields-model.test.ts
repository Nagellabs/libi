import { describe, it, expect } from "vitest";
import { transformToUi, uiToTransform } from "@/components/preview/transform-fields";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";

describe("transform <-> UI mapping", () => {
  it("identity maps to all-zero angles", () => {
    expect(transformToUi(IDENTITY_TRANSFORM3D)).toEqual({
      posX: 0, posY: 0, posZ: 0, angle: 0, elevation: 0, spin: 0,
    });
  });

  it("round-trips degrees<->radians for angle/elevation/spin", () => {
    const ui = { posX: 12, posY: -4, posZ: 1, angle: 30, elevation: -15, spin: 90 };
    const t = uiToTransform(ui);
    expect(t.rotation.y).toBeCloseTo((30 * Math.PI) / 180, 6); // angle
    expect(t.rotation.x).toBeCloseTo((-15 * Math.PI) / 180, 6); // elevation
    expect(t.rotation.z).toBeCloseTo((90 * Math.PI) / 180, 6); // spin
    expect(transformToUi(t)).toEqual(ui);
  });
});
