import { describe, it, expect } from "vitest";
import { hitTest } from "@/lib/engine/overlays";
import type { TextOverlay, TrackedOverlay, ThreeOverlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";

function mk(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<TextOverlay> = {},
): TextOverlay {
  return {
    id,
    kind: "text",
    content: "",
    font: "",
    color: "",
    align: "left",
    opacity: 1,
    rect: { x, y, width: w, height: h },
    startTime: 0,
    duration: 10,
    z: 0,
    ...extra,
  };
}

describe("hitTest with rotation", () => {
  it("identity (no rotation) behaves exactly as before", () => {
    const overlays = [mk("a", 0, 0, 100, 100)];
    expect(hitTest(50, 50, overlays, 1)?.id).toBe("a");
    expect(hitTest(150, 150, overlays, 1)).toBe(null);
  });

  // A thin 200x40 bar centered at (100,100), rotated 90° → occupies a
  // 40-wide x 200-tall vertical strip. A point at (100, 180) is OUTSIDE the
  // unrotated AABB (y 80..120) but INSIDE the rotated bar.
  it("selects a point inside the rotated rect but outside the AABB", () => {
    const overlays = [mk("bar", 0, 80, 200, 40, { transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.PI / 2 } } })];
    // inside the rotated (vertical) strip near the top
    expect(hitTest(100, 180, overlays, 1)?.id).toBe("bar");
  });

  it("rejects a point inside the AABB but outside the rotated rect", () => {
    const overlays = [mk("bar", 0, 80, 200, 40, { transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.PI / 2 } } })];
    // (180, 100) is inside the horizontal AABB but the rotated strip is only
    // 40px wide around x=100 → outside.
    expect(hitTest(180, 100, overlays, 1)).toBe(null);
  });

  it("flipH does not break hit-testing of a symmetric rect", () => {
    const overlays = [mk("a", 0, 0, 100, 100, { flipH: true })];
    expect(hitTest(50, 50, overlays, 1)?.id).toBe("a");
  });

  it("tracked overlay still hit-tests through applyFitAndScale", () => {
    const track: Track = {
      id: "t",
      samples: [{ time: 1, x: 40, y: 40, w: 20, h: 20, visible: true }],
    } as unknown as Track;
    const tracked: TrackedOverlay = {
      id: "trk",
      kind: "tracked",
      trackId: "t",
      content: { kind: "emoji", char: "x" },
      fit: "tight",
      scale: 1,
      smoothing: "linear",
      opacity: 1,
      rect: { x: 0, y: 0, width: 20, height: 20 },
      startTime: 0,
      duration: 10,
      z: 0,
    };
    const hit = hitTest(50, 50, [tracked], 1, { t: track }, { width: 200, height: 200 });
    expect(hit?.id).toBe("trk");
  });
});

describe("hitTest with a spatial (3D) transform3d", () => {
  // An out-of-plane transform renders through the textured quad, so the hit
  // region is the PROJECTED footprint, not the flat rect.
  const spatial = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 1.2, z: 0 }, // yaw (Angle) → spatial
  };

  it("an identity transform3d still hits exactly as the flat rect", () => {
    const overlays = [
      mk("a", 100, 100, 400, 200, {
        transform3d: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
      }),
    ];
    expect(hitTest(300, 200, overlays, 1)?.id).toBe("a");
    expect(hitTest(700, 200, overlays, 1)).toBe(null);
  });

  it("selects the overlay at its (covered) center when 3D-tilted", () => {
    const overlays = [mk("tilt", 100, 100, 400, 200, { transform3d: spatial })];
    // Rect center is still covered by the projected footprint.
    expect(hitTest(300, 200, overlays, 1)?.id).toBe("tilt");
  });

  it("rejects a click far outside the projected footprint of a tilted overlay", () => {
    const overlays = [mk("tilt", 100, 100, 400, 200, { transform3d: spatial })];
    // Well to the right of the rect — never covered.
    expect(hitTest(900, 200, overlays, 1)).toBe(null);
  });

  it("an added in-plane Spin (rotation.z) is a SCREEN-ROLL: the hit region rolls, not the tilt footprint", () => {
    // A wide-short tilted bar. Spinning it 90° (rotation.z = π/2) about the rect
    // center rolls the on-screen footprint to tall-narrow — a point above/below
    // the un-spun footprint becomes a hit, and a point left/right stops being one.
    const tiltedSpin = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0.6, y: 0, z: Math.PI / 2 },
    };
    const overlays = [mk("roll", 100, 200, 400, 80, { transform3d: tiltedSpin })];
    // Center is covered regardless of roll.
    expect(hitTest(300, 240, overlays, 1)?.id).toBe("roll");
    // A point ~120px BELOW the center: outside the wide-short footprint, but the
    // 90° screen-roll makes the bar vertical → this point is now inside.
    expect(hitTest(300, 360, overlays, 1)?.id).toBe("roll");
  });

  it("a 3D-MODE text (place3d) renders via the three instance into its rect — hit by the RECT, not the foreshortened quad", () => {
    // Same yaw as the plain-text case above, but `place3d: true` ⇒ it renders
    // through the three instance into the rect viewport (window model), exactly
    // like a `three` overlay. So a point near the rect edge that the foreshortened
    // quad would EXCLUDE must still select it (rect path), matching the gizmo box.
    const overlays = [
      mk("d3", 100, 100, 400, 200, { place3d: true, transform3d: spatial }),
    ];
    expect(hitTest(300, 200, overlays, 1)?.id).toBe("d3"); // center
    // Near the right edge of the rect (x 100..500). Strong yaw foreshortens the
    // quad well inside x=480, so the old quad path missed this; the rect path hits.
    expect(hitTest(480, 200, overlays, 1)?.id).toBe("d3");
  });
});

describe("hitTest with a three overlay (axis-aligned viewport)", () => {
  // A `three` overlay renders into a FIXED axis-aligned rect viewport; its
  // transform3d only moves content inside the 3D scene, never the rect on
  // canvas. So even when pitched (→ classifyTransform "spatial"), a click
  // inside the rect must select it — it must NOT take the skewed-quad path.
  function mkThree(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    extra: Partial<ThreeOverlay> = {},
  ): ThreeOverlay {
    return {
      id,
      kind: "three",
      sceneFunction: "",
      opacity: 1,
      rect: { x, y, width: w, height: h },
      startTime: 0,
      duration: 10,
      z: 0,
      ...extra,
    };
  }

  it("selects a three overlay at a point inside its rect even when 3D-pitched", () => {
    const overlays = [
      mkThree("three", 100, 100, 400, 400, {
        transform3d: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 1.2, y: 0, z: 0 }, // pitch → classifyTransform "spatial"
        },
      }),
    ];
    // (300,450) is well inside the axis-aligned rect viewport (y 100..500) but
    // OUTSIDE the pitched spatial quad — so before the fix the quad path missed
    // it and returned null. The fix routes `three` through the rect test.
    expect(hitTest(300, 450, overlays, 1)?.id).toBe("three");
  });

  it("uses the projected content rect when threeContentRects is provided", () => {
    const overlays = [mkThree("three", 0, 0, 600, 600)];
    const threeContentRects = { three: { x: 200, y: 120, width: 100, height: 60 } };
    // Inside the content rect (200..300, 120..180) → hits.
    expect(
      hitTest(210, 130, overlays, 1, undefined, undefined, threeContentRects)?.id,
    ).toBe("three");
    // Inside the FULL rect (0..600) but OUTSIDE the content rect → null.
    expect(
      hitTest(160, 300, overlays, 1, undefined, undefined, threeContentRects),
    ).toBe(null);
  });
});
