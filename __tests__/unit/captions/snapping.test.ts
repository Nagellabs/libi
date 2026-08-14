import { describe, it, expect } from "vitest";
import {
  snapPosition1D,
  snapAngle,
  frameSnapTargetsX,
  frameSnapTargetsY,
  type SnapTarget,
} from "@/lib/captions/snapping";

describe("snapAngle", () => {
  it("snaps to nearest 15° detent", () => {
    expect(snapAngle(43)).toBe(45);
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(100)).toBe(105);
  });

  it("respects bypass=true (identity)", () => {
    expect(snapAngle(43, { bypass: true })).toBe(43);
  });

  it("respects custom step", () => {
    expect(snapAngle(38, { step: 15 })).toBe(45);
  });
});

describe("snapPosition1D", () => {
  it("snaps to a target within threshold", () => {
    expect(
      snapPosition1D(958, [{ value: 960, kind: "center" }], 8),
    ).toEqual({ value: 960, hit: { value: 960, kind: "center" } });
  });

  it("returns identity when nothing in range", () => {
    expect(snapPosition1D(900, [{ value: 960, kind: "center" }], 8)).toEqual({
      value: 900,
      hit: null,
    });
  });

  it("snaps to the nearest target", () => {
    const targets: SnapTarget[] = [
      { value: 0, kind: "safe" },
      { value: 6, kind: "overlay" },
    ];
    const res = snapPosition1D(5, targets, 8);
    expect(res.value).toBe(6);
    expect(res.hit?.kind).toBe("overlay");
  });
});

describe("frameSnapTargetsX / Y", () => {
  it("includes center, thirds and safe margins", () => {
    const vals = frameSnapTargetsX(1920, []).map((t) => t.value);
    expect(vals).toContain(960); // center
    expect(vals).toContain(640); // third
    expect(vals).toContain(1280); // 2/3
    expect(vals).toContain(96); // safe 5%
    expect(vals).toContain(1824); // safe 95%
  });

  it("passes siblings through as overlay targets", () => {
    const targets = frameSnapTargetsX(1920, [500]);
    expect(targets).toContainEqual({ value: 500, kind: "overlay" });
  });

  it("works for the Y axis too", () => {
    const vals = frameSnapTargetsY(1080, []).map((t) => t.value);
    expect(vals).toContain(540); // center
    expect(vals).toContain(360); // third
    expect(vals).toContain(720); // 2/3
    expect(vals).toContain(54); // safe 5%
    expect(vals).toContain(1026); // safe 95%
  });
});
