import { describe, it, expect } from "vitest";
import { mergeOptimistic } from "@/lib/overlays/use-optimistic-overlay";
import type { TextOverlay } from "@/lib/engine/types";

function makeOverlay(over: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "o1",
    kind: "text",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 0, y: 0, width: 100, height: 50 },
    opacity: 1,
    content: "Hello",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
    ...over,
  } as TextOverlay;
}

describe("mergeOptimistic", () => {
  it("applies a patch onto the base", () => {
    const base = makeOverlay();
    const view = mergeOptimistic(base, { color: "#ff0000" });
    expect(view.color).toBe("#ff0000");
    // unrelated fields preserved
    expect(view.content).toBe("Hello");
  });

  it("a null patch value DELETES that key", () => {
    const base = makeOverlay({ background: { color: "rgba(0,0,0,0.6)" } });
    const view = mergeOptimistic(base, { background: null });
    expect("background" in view).toBe(false);
  });

  it("does not mutate the base", () => {
    const base = makeOverlay();
    mergeOptimistic(base, { color: "#abcdef" });
    expect(base.color).toBe("#ffffff");
  });

  it("nested object patches replace wholesale (caller spreads)", () => {
    const base = makeOverlay({ background: { color: "rgba(0,0,0,0.6)", padding: 12 } });
    const view = mergeOptimistic(base, { background: { color: "#111111", padding: 4 } });
    expect(view.background).toEqual({ color: "#111111", padding: 4 });
  });

  it("when the incoming base already reflects the patch, the view equals base", () => {
    // Reconcile rule: applying the same patch to a base that already matches is
    // a no-op — the optimistic view is structurally the base.
    const base = makeOverlay({ color: "#00ff00" });
    const view = mergeOptimistic(base, { color: "#00ff00" });
    expect(view).toEqual(base);
  });
});
