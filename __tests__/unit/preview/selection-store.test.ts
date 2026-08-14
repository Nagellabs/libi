import { describe, it, expect, vi } from "vitest";
import { createSelectionStore } from "@/lib/preview/selection-store";

describe("createSelectionStore", () => {
  it("starts null and reflects set()", () => {
    const s = createSelectionStore();
    expect(s.get()).toBe(null);
    s.set("o1");
    expect(s.get()).toBe("o1");
  });

  it("notifies subscribers only when the value actually changes", () => {
    const s = createSelectionStore("o1");
    const fn = vi.fn();
    const unsub = s.subscribe(fn);
    s.set("o1"); // same → no notify
    expect(fn).toHaveBeenCalledTimes(0);
    s.set("o2"); // change → notify
    expect(fn).toHaveBeenCalledTimes(1);
    s.set(null); // change → notify
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
    s.set("o3"); // unsubscribed → no notify
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
