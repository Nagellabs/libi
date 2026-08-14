import { describe, it, expect } from "vitest";
import { sanitizeRightRegionMode } from "@/lib/editor-state-context";

describe("sanitizeRightRegionMode", () => {
  it("accepts known modes", () => {
    expect(sanitizeRightRegionMode("onboarding")).toBe("onboarding");
    expect(sanitizeRightRegionMode("api-config")).toBe("api-config");
    expect(sanitizeRightRegionMode("editor")).toBe("editor");
  });
  it("falls back to editor on garbage", () => {
    expect(sanitizeRightRegionMode("nope")).toBe("editor");
    expect(sanitizeRightRegionMode(undefined)).toBe("editor");
  });
});
