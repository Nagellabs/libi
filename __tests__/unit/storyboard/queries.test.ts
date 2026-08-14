import { describe, it, expect } from "vitest";
import { storyboardKeys } from "@/lib/queries/storyboard";

describe("storyboardKeys", () => {
  it("builds stable detail keys", () => {
    expect(storyboardKeys.detail("p1")).toEqual(["storyboard", "p1"]);
    expect(storyboardKeys.all).toEqual(["storyboard"]);
  });
});
