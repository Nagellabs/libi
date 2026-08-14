import { describe, it, expect } from "vitest";
import { stripNonDecodingOverlays } from "@/lib/overlays/hidden";
import { applyBudget, type BudgetEntry, type BudgetSource } from "@/hooks/preview/use-video-sources";
import type { Composition } from "@/lib/engine/types";

/**
 * Regression: a hidden (`overlay.hidden === true`, the persisted eye toggle)
 * video overlay must leave the DECODE pipeline entirely. Preview-surface feeds
 * `stripNonDecodingOverlays(mergedComposition)` to BOTH decode consumers —
 * `usePreviewAssets`→`useVideoSources` (whose source registry + `applyBudget`
 * geometry iterate `composition.overlays`) and the readiness probe
 * (`getReadyAhead`, which builds its active set from the same array).
 * The original bug: the hidden overlay stayed in both, its decoder's request
 * time froze (the renderer never calls getFrame for a hidden overlay), and the
 * gate re-buffered on its ~0 runway every ~1s — the flashing spinner loop.
 * (Helper-semantics coverage — coupled/detached audio, identity passthrough,
 * manifest arrays — lives in __tests__/unit/overlays/hidden-layers.test.ts.)
 */

/** Records decode actions so we can assert what the budget issued. */
function makeFakeSource() {
  const calls: string[] = [];
  const source: BudgetSource = {
    play: () => calls.push("play"),
    warm: (s: number) => calls.push(`warm:${s}`),
    pause: () => calls.push("pause"),
    prime: (t: number) => {
      calls.push(`prime:${t}`);
    },
  };
  return { source, calls };
}

/** Three overlapping full-frame video overlays (the 9–14s window of the
 *  original repro piece), cast — consumers only read overlays/fps. The top-z
 *  one carries the persisted hidden flag. */
function threeVideoComp(): Composition {
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    scenes: [],
    overlays: [
      { id: "vid-a", kind: "video", startTime: 7, duration: 7, videoUrl: "a", fileId: "fa", z: 1, opacity: 1, rect },
      { id: "vid-b", kind: "video", startTime: 7, duration: 7, videoUrl: "b", fileId: "fb", z: 4, opacity: 1, rect },
      { id: "vid-hidden", kind: "video", startTime: 7, duration: 7, videoUrl: "c", fileId: "fc", z: 5, opacity: 1, rect, hidden: true },
    ],
  } as unknown as Composition;
}

describe("stripNonDecodingOverlays (decode composition, field-sourced)", () => {
  it("removes hidden overlays and keeps the rest", () => {
    const stripped = stripNonDecodingOverlays(threeVideoComp());
    const ids = (stripped?.overlays ?? []).map((o) => o.id);
    expect(ids).toEqual(["vid-a", "vid-b"]);
  });

  it("keeps the hidden overlay out of the source registry / readiness-probe active set", () => {
    // Both consumers derive their sets from `composition.overlays` (the
    // registry in useVideoSources; the probe's active loop in preview-surface).
    // Absence from the stripped array is absence from both.
    const stripped = stripNonDecodingOverlays(threeVideoComp());
    expect(stripped?.overlays?.some((o) => o.id === "vid-hidden")).toBe(false);
  });
});

describe("applyBudget on the hidden-stripped composition", () => {
  it("never plays a hidden overlay's source — it goes cold (pause), visible siblings play", () => {
    const stripped = stripNonDecodingOverlays(threeVideoComp())!;
    const hidden = makeFakeSource();
    const visible = makeFakeSource();
    // A just-hidden overlay's source may still be mounted for a tick before the
    // registry reconcile disposes it — the budget must park it, not play it.
    const map = new Map<string, BudgetEntry>([
      ["vid-hidden", { source: hidden.source }],
      ["vid-a", { source: visible.source }],
    ]);

    // Playhead mid-window (10s): all three overlays would be "active" pre-fix.
    applyBudget({ composition: stripped, playheadSec: 10, playing: true, map });

    expect(visible.calls).toContain("play");
    expect(hidden.calls).not.toContain("play");
    expect(hidden.calls).toContain("pause");
  });
});
