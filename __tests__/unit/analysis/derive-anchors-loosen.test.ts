import { describe, it, expect } from "vitest";
import { isValidNormalizedBboxForTest as isValid } from "@/lib/analysis/manager";

describe("relaxed person aspect clamp", () => {
  it("accepts a wide full-body crop (aspect 6) the old 0.2..5 clamp rejected", () => {
    expect(isValid([0.1, 0.1, 0.6, 0.1], "person")).toBe(true);
  });
  it("still rejects an out-of-frame box", () => {
    expect(isValid([0.9, 0.1, 0.5, 0.1], "person")).toBe(false);
  });
  it("still rejects a zero-area box", () => {
    expect(isValid([0.1, 0.1, 0.005, 0.005], "person")).toBe(false);
  });
});
