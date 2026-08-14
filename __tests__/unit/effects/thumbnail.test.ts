// __tests__/unit/effects/thumbnail.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveThumbnailParams,
  deltaToThumbnailStyle,
  thumbnailProgress,
} from "@/lib/effects/thumbnail";
import type { EffectMeta } from "@/lib/effects/types";

const meta = (params: EffectMeta["params"]): EffectMeta => ({
  id: "x", name: "X", family: "animation", phases: ["in"], supports: ["text"], params,
});

describe("resolveThumbnailParams", () => {
  it("fills each param with its default", () => {
    const m = meta([
      { key: "turns", label: "Turns", type: "number", default: 2 },
      { key: "dir", label: "Dir", type: "enum", options: ["left", "right"], default: "right" },
    ]);
    expect(resolveThumbnailParams(m)).toEqual({ turns: 2, dir: "right" });
  });
  it("falls back to 0 / first option when no default", () => {
    const m = meta([
      { key: "n", label: "N", type: "number" },
      { key: "d", label: "D", type: "enum", options: ["a", "b"] },
    ]);
    expect(resolveThumbnailParams(m)).toEqual({ n: 0, d: "a" });
  });
});

describe("deltaToThumbnailStyle", () => {
  it("maps translate/scale/rotate/opacity/blur", () => {
    const s = deltaToThumbnailStyle({ dx: 10, dy: -5, scale: 1.5, rotateDeg: 30, opacity: 0.4, blurPx: 3 });
    expect(s.transform).toContain("translate(10px, -5px)");
    expect(s.transform).toContain("scale(1.5)");
    expect(s.transform).toContain("rotate(30deg)");
    expect(s.opacity).toBe(0.4);
    expect(s.filter).toBe("blur(3px)");
  });
  it("applies non-uniform scaleX/scaleY when present", () => {
    const s = deltaToThumbnailStyle({ scaleX: 0.5, scaleY: 2 });
    expect(s.transform).toContain("scale(0.5, 2)");
  });
  it("emits a clip-path inset for clipReveal", () => {
    const s = deltaToThumbnailStyle({ clipReveal: { edge: "left", fraction: 0.25 } });
    // reveal 25% from the left → hide the right 75%
    expect(s.clipPath).toBe("inset(0 75% 0 0)");
  });
  it("identity delta → no transform, opacity 1", () => {
    const s = deltaToThumbnailStyle({});
    expect(s.transform).toBe("none");
    expect(s.opacity).toBe(1);
    expect(s.filter).toBe("none");
    expect(s.clipPath).toBe("none");
  });
});

describe("thumbnailProgress", () => {
  it("ramps 0→1 over the active window then holds at 1 during the pause", () => {
    // window 800ms, pause 400ms, period 1200ms
    expect(thumbnailProgress(0)).toBeCloseTo(0, 5);
    expect(thumbnailProgress(400)).toBeCloseTo(0.5, 5);
    expect(thumbnailProgress(800)).toBeCloseTo(1, 5);
    expect(thumbnailProgress(1000)).toBeCloseTo(1, 5); // held during pause
    expect(thumbnailProgress(1200)).toBeCloseTo(0, 5); // wraps
  });
});
