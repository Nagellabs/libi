import { describe, it, expect } from "vitest";
import { anchorToRect, look3dToTilt, regionCenterPoint, placeBoxAtAnchor } from "@/lib/captions/anchor";

describe("anchorToRect", () => {
  const frame = { width: 720, height: 1280 };
  const size = { width: 600, height: 120 };
  it("bottom-center sits near the bottom, horizontally centered", () => {
    const r = anchorToRect("bottom-center", frame, size);
    expect(r.x).toBeCloseTo((720 - 600) / 2, 5);
    expect(r.y).toBeGreaterThan(1280 * 0.8);
  });
  it("mid-left hugs the left margin, vertically centered", () => {
    const r = anchorToRect("mid-left", frame, size);
    expect(r.x).toBeCloseTo(720 * 0.06, 5);
    expect(r.y).toBeCloseTo((1280 - 120) / 2, 5);
  });
});
describe("regionCenterPoint (content-aware anchor for non-text overlays)", () => {
  const frame = { width: 720, height: 1280 };

  it("FITTING box: center equals anchorToRect's center (image/video unchanged)", () => {
    const size = { width: 300, height: 200 };
    for (const a of ["top-left", "bottom-right", "mid-center", "top-center"] as const) {
      const c = regionCenterPoint(a, frame, size);
      const r = anchorToRect(a, frame, size);
      expect(c.x).toBeCloseTo(r.x + size.width / 2, 4);
      expect(c.y).toBeCloseTo(r.y + size.height / 2, 4);
    }
  });

  it("FITTING box placed via center round-trips to the old edge-anchor rect", () => {
    const size = { width: 300, height: 200 };
    const c = regionCenterPoint("top-left", frame, size);
    const r = placeBoxAtAnchor(c, "mid-center", size.width, size.height);
    const old = anchorToRect("top-left", frame, size);
    expect(r.x).toBeCloseTo(old.x, 4);
    expect(r.y).toBeCloseTo(old.y, 4);
  });

  it("FRAME-FILLING box: top-left moves the content toward the TOP-LEFT, not down-right", () => {
    const size = { width: 720, height: 1280 }; // exactly the frame (a `three` default)
    const c = regionCenterPoint("top-left", frame, size);
    // content center should land in the upper-left quadrant (¼ frame), NOT past center
    expect(c.x).toBeLessThan(frame.width / 2);
    expect(c.y).toBeLessThan(frame.height / 2);
    expect(c.x).toBeCloseTo(frame.width * 0.25, 4);
    expect(c.y).toBeCloseTo(frame.height * 0.25, 4);
  });

  it("FRAME-FILLING box: bottom-right is the mirror of top-left (not inverted)", () => {
    const size = { width: 720, height: 1280 };
    const tl = regionCenterPoint("top-left", frame, size);
    const br = regionCenterPoint("bottom-right", frame, size);
    expect(br.x).toBeGreaterThan(tl.x); // right is right
    expect(br.y).toBeGreaterThan(tl.y); // bottom is below top
    expect(br.x).toBeCloseTo(frame.width * 0.75, 4);
    expect(br.y).toBeCloseTo(frame.height * 0.75, 4);
  });

  it("OVERFLOW box (bigger than frame): still centers on the region, no overflow inversion", () => {
    const size = { width: 1000, height: 1600 };
    expect(regionCenterPoint("top-center", frame, size).y).toBeCloseTo(frame.height * 0.25, 4);
    expect(regionCenterPoint("bottom-center", frame, size).y).toBeCloseTo(frame.height * 0.75, 4);
    expect(regionCenterPoint("mid-center", frame, size).x).toBeCloseTo(frame.width * 0.5, 4);
  });
});

describe("look3dToTilt", () => {
  it("flat → null, lay-on-road → ground", () => {
    expect(look3dToTilt("flat")).toBeNull();
    expect(look3dToTilt("lay-on-road")).toBe("ground");
  });
});
