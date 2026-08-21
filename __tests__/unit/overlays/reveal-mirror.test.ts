import { describe, it, expect } from "vitest";
import { stripRevealMirror, revealToEffectIn, effectInToReveal } from "@/lib/overlays/hydrate";
import type { CompositionManifest } from "@/lib/composition/persistence";
import type { Overlay, TextOverlay } from "@/lib/engine/types";

function textOverlay(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "cue-1",
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    z: 50,
    opacity: 1,
    content: "hi there",
    font: "24px Inter",
    color: "#fff",
    align: "center",
    ...extra,
  };
}

function manifest(overlays: Record<string, unknown>[]): CompositionManifest {
  return { width: 1920, height: 1080, fps: 30, overlays: overlays as never };
}

describe("stripRevealMirror — reveal is the single persisted source of truth", () => {
  it("drops the text-internal effects.in mirror when reveal is present (re-derived on load)", () => {
    const m = manifest([textOverlay({ reveal: { mode: "karaoke" }, effects: { in: { effectId: "karaoke" } } })]);
    const out = stripRevealMirror(m).overlays![0] as Record<string, unknown>;
    expect(out.reveal).toEqual({ mode: "karaoke" }); // reveal untouched
    expect(out.effects).toBeUndefined(); // stale mirror gone
  });

  it("drops a stale mirror even when reveal was already cleared (the resurrection bug)", () => {
    // The exact broken shape: reveal removed, but effects.in mirror still there.
    const m = manifest([textOverlay({ effects: { in: { effectId: "karaoke" } } })]);
    const out = stripRevealMirror(m).overlays![0] as Record<string, unknown>;
    expect(out.reveal).toBeUndefined();
    expect(out.effects).toBeUndefined();
  });

  it("keeps a REAL animation effects.in (fade) — only reveal mirrors are stripped", () => {
    const m = manifest([textOverlay({ effects: { in: { effectId: "fade", durationMs: 400 } } })]);
    const out = stripRevealMirror(m).overlays![0] as Record<string, unknown>;
    expect(out.effects).toEqual({ in: { effectId: "fade", durationMs: 400 } });
  });

  it("strips only the mirrored `in`, preserving out/loop animations", () => {
    const m = manifest([
      textOverlay({ reveal: { mode: "typewriter" }, effects: { in: { effectId: "typewriter" }, out: { effectId: "fade" } } }),
    ]);
    const out = stripRevealMirror(m).overlays![0] as Record<string, unknown>;
    expect(out.effects).toEqual({ out: { effectId: "fade" } });
  });

  it("round-trip: after stripping, hydrate re-derives the mirror from reveal (display parity)", () => {
    const stripped = stripRevealMirror(
      manifest([textOverlay({ reveal: { mode: "karaoke" }, effects: { in: { effectId: "karaoke" } } })]),
    ).overlays![0] as unknown as Overlay;
    // On load, revealToEffectIn re-adds the mirror so the effects inspector shows it.
    const hydrated = revealToEffectIn(stripped) as TextOverlay;
    expect(hydrated.effects?.in?.effectId).toBe("karaoke");
  });

  it("round-trip: removing reveal (None) STAYS removed — nothing to resurrect", () => {
    // Simulate the None click: reveal cleared. Persisted (stripped) form has no
    // mirror, so effectInToReveal on load can't bring karaoke back.
    const persisted = stripRevealMirror(
      manifest([textOverlay({ effects: { in: { effectId: "karaoke" } } })]),
    ).overlays![0] as unknown as Overlay;
    const hydrated = effectInToReveal(revealToEffectIn(persisted)) as TextOverlay;
    expect(hydrated.reveal).toBeUndefined(); // stays gone
    expect(hydrated.effects?.in).toBeUndefined();
  });
});
