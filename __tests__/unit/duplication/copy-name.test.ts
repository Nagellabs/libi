import { describe, it, expect } from "vitest";
import { resolveCopyName } from "@/lib/duplication/copy-name";

describe("resolveCopyName", () => {
  it("appends (copy) when no collision", () => {
    expect(resolveCopyName("My Project", [])).toBe("My Project (copy)");
  });
  it("appends (copy 2) when (copy) is taken", () => {
    expect(resolveCopyName("My Project", ["My Project (copy)"])).toBe("My Project (copy 2)");
  });
  it("finds the first free slot", () => {
    expect(
      resolveCopyName("X", ["X (copy)", "X (copy 2)", "X (copy 4)"]),
    ).toBe("X (copy 3)");
  });
  it("ignores unrelated names", () => {
    expect(resolveCopyName("X", ["Y (copy)", "Xanadu"])).toBe("X (copy)");
  });
});
