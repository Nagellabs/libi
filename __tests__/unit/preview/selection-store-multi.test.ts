import { describe, it, expect, vi } from "vitest";
import { createSelectionStore } from "@/lib/preview/selection-store";

describe("multi selection store", () => {
  it("setAll/getAll holds an ordered set; primary() is the first", () => {
    const s = createSelectionStore();
    s.setAll(["a", "b"]);
    expect(s.getAll()).toEqual(["a", "b"]);
    expect(s.primary()).toBe("a");
  });
  it("single get() returns the primary for back-compat", () => {
    const s = createSelectionStore();
    s.setAll(["x", "y"]);
    expect(s.get()).toBe("x");
  });
  it("set(id) replaces with a single id", () => {
    const s = createSelectionStore();
    s.setAll(["a", "b"]);
    s.set("c");
    expect(s.getAll()).toEqual(["c"]);
  });
  it("notifies only on real change", () => {
    const s = createSelectionStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.setAll(["a"]);
    s.setAll(["a"]); // no change
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("toggle adds/removes one id", () => {
    const s = createSelectionStore();
    s.setAll(["a"]);
    s.toggle("b");
    expect(s.getAll()).toEqual(["a", "b"]);
    s.toggle("a");
    expect(s.getAll()).toEqual(["b"]);
  });
});
