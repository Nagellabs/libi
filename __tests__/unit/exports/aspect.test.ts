import { describe, it, expect } from "vitest";
import { aspectOf } from "@/lib/exports/aspect";

describe("aspectOf", () => {
  it.each([
    [1080, 1920, "9:16"],
    [720, 1280, "9:16"],
    [1920, 1080, "16:9"],
    [3840, 2160, "16:9"],
    [1080, 1080, "1:1"],
    [1080, 1350, "4:5"],
    // 1082/1920 = 0.5635, 0.18 % off 9:16 — inside the ±1 % tolerance.
    [1082, 1920, "9:16"],
    // 1000/1920 = 0.5208, 7.4 % off 9:16.
    [1000, 1920, "other"],
    [1440, 1080, "other"],
  ] as const)("%i×%i → %s", (w, h, want) => {
    expect(aspectOf(w, h)).toBe(want);
  });

  it("is 'other' for missing or non-positive dimensions", () => {
    expect(aspectOf(null, 1080)).toBe("other");
    expect(aspectOf(1920, undefined)).toBe("other");
    expect(aspectOf(0, 0)).toBe("other");
    expect(aspectOf(-1920, 1080)).toBe("other");
  });
});
