import { describe, it, expect } from "vitest";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";

describe("effect-highlight-store", () => {
  it("sets + auto-clears after ttl (injected clock)", () => {
    let fn: (() => void) | null = null;
    const store = createEffectHighlightStore({
      setTimeoutFn: (f) => {
        fn = f;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });
    store.set({ kind: "catalog", effectId: "fade", phase: "in" }, 4000);
    expect(store.get()?.kind).toBe("catalog");
    fn!();
    expect(store.get()).toBeNull();
  });
  it("notifies subscribers on change", () => {
    const store = createEffectHighlightStore();
    let n = 0;
    const unsub = store.subscribe(() => {
      n++;
    });
    store.set({ kind: "applied", layerId: "ov1", phase: "out" }, 0);
    expect(n).toBe(1);
    unsub();
  });
});
