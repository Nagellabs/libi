import { describe, it, expect } from "vitest";
import { revealToEffectIn } from "@/lib/overlays/hydrate";
import type { TextOverlay } from "@/lib/engine/types";

function tx(reveal: TextOverlay["reveal"], effects?: TextOverlay["effects"]): TextOverlay {
  return { id: "t", kind: "text", startTime: 0, duration: 2, z: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, opacity: 1, content: "x", font: "10px Inter", color: "#fff", align: "left", reveal, effects } as TextOverlay;
}

describe("revealToEffectIn", () => {
  it("maps typewriter reveal to effects.in", () => {
    const out = revealToEffectIn(tx({ mode: "typewriter" }));
    expect(out.effects?.in?.effectId).toBe("typewriter");
  });
  it("maps slide-up to slide-up-lines", () => {
    expect(revealToEffectIn(tx({ mode: "slide-up" })).effects?.in?.effectId).toBe("slide-up-lines");
  });
  it("mode none → no effects.in added", () => {
    expect(revealToEffectIn(tx({ mode: "none" })).effects?.in).toBeUndefined();
  });
  it("does NOT clobber an existing effects.in", () => {
    const out = revealToEffectIn(tx({ mode: "typewriter" }, { in: { effectId: "fade" } }));
    expect(out.effects?.in?.effectId).toBe("fade");
  });
});
