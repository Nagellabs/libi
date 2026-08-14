import { describe, it, expect } from "vitest";
import { isNonDecodingOverlay, stripNonDecodingOverlays } from "@/lib/overlays/hidden";
import { applyBudget, type BudgetEntry, type BudgetSource } from "@/hooks/preview/use-video-sources";
import type { Composition } from "@/lib/engine/types";

/**
 * Regression (sibling of hidden-overlays-decode.test.ts): a video overlay
 * flagged `missing: true` — set by `buildComposition` when its `fileId` is
 * confirmed absent from piece ∪ global files (e.g. an agent authored an
 * overlay pointing at ANOTHER piece's file) — must leave the DECODE pipeline
 * entirely. The renderer paints the "media missing" placeholder and returns
 * BEFORE any source lookup, so a mounted decoder's request time never
 * advances; pre-fix the readiness gate still graded that parked source
 * against the moving playhead → the metronomic ~1.03s re-buffer flap
 * (buffering count 6 over a 6s play on the original repro piece).
 *
 * Equally important: a missing TEXT/IMAGE overlay must NOT be stripped — the
 * RENDER path intentionally paints their placeholder, and they mount no video
 * decoder, so they are harmless to (and must survive) the decode comp too.
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

/** The repro shape: a normal full-frame video plus a sibling video whose file
 *  belongs to a different piece (missing:true), and a missing image + a
 *  missing-flagged text overlay that must both survive the strip. */
function missingVideoComp(): Composition {
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    scenes: [],
    overlays: [
      { id: "vid-ok", kind: "video", startTime: 0, duration: 8, videoUrl: "a", fileId: "fa", z: 1, opacity: 1, rect },
      { id: "vid-missing", kind: "video", startTime: 0, duration: 8, videoUrl: "b", fileId: "fb", z: 4, opacity: 1, rect, missing: true },
      { id: "img-missing", kind: "image", startTime: 0, duration: 8, fileId: "fc", z: 5, opacity: 1, rect, missing: true },
      { id: "txt-a", kind: "text", startTime: 0, duration: 8, content: "hi", z: 6, opacity: 1, rect, missing: true },
    ],
  } as unknown as Composition;
}

describe("isNonDecodingOverlay (missing-file semantics)", () => {
  it("flags a missing video overlay, but not a present one", () => {
    expect(isNonDecodingOverlay({ kind: "video", missing: true })).toBe(true);
    expect(isNonDecodingOverlay({ kind: "video" })).toBe(false);
    expect(isNonDecodingOverlay({ kind: "video", missing: false })).toBe(false);
  });

  it("flags a missing tracked-video overlay", () => {
    expect(
      isNonDecodingOverlay({ kind: "tracked", missing: true, content: { kind: "video" } }),
    ).toBe(true);
    expect(
      isNonDecodingOverlay({ kind: "tracked", content: { kind: "video" } }),
    ).toBe(false);
  });

  it("does NOT flag missing non-video overlays (placeholder must render, no decoder mounts)", () => {
    expect(isNonDecodingOverlay({ kind: "image", missing: true })).toBe(false);
    expect(isNonDecodingOverlay({ kind: "text", missing: true })).toBe(false);
    expect(isNonDecodingOverlay({ kind: "code", missing: true })).toBe(false);
    expect(isNonDecodingOverlay({ kind: "three", missing: true })).toBe(false);
    expect(
      isNonDecodingOverlay({ kind: "tracked", missing: true, content: { kind: "code" } }),
    ).toBe(false);
  });

  it("still flags hidden overlays of any kind", () => {
    expect(isNonDecodingOverlay({ kind: "video", hidden: true })).toBe(true);
    expect(isNonDecodingOverlay({ kind: "text", hidden: true })).toBe(true);
  });
});

describe("stripNonDecodingOverlays (decode composition, missing video)", () => {
  it("removes the missing video overlay; keeps the normal video AND missing image/text", () => {
    const stripped = stripNonDecodingOverlays(missingVideoComp());
    const ids = (stripped?.overlays ?? []).map((o) => o.id);
    expect(ids).toEqual(["vid-ok", "img-missing", "txt-a"]);
  });

  it("keeps the missing video out of the source registry / readiness-probe active set", () => {
    // Both decode consumers derive their sets from `composition.overlays` (the
    // registry in useVideoSources; getReadyAhead's active loop in
    // preview-surface iterates kind === "video" overlays with no missing
    // check). Absence from the stripped array is absence from both — the gate
    // can never again grade the never-painted source.
    const stripped = stripNonDecodingOverlays(missingVideoComp());
    expect(stripped?.overlays?.some((o) => o.id === "vid-missing")).toBe(false);
  });

  it("identity passthrough when nothing is missing or hidden", () => {
    const rect = { x: 0, y: 0, width: 1920, height: 1080 };
    const c = {
      fps: 30,
      width: 1920,
      height: 1080,
      scenes: [],
      overlays: [
        { id: "vid-ok", kind: "video", startTime: 0, duration: 8, fileId: "fa", z: 1, opacity: 1, rect },
      ],
    } as unknown as Composition;
    expect(stripNonDecodingOverlays(c)).toBe(c);
  });
});

describe("applyBudget on the missing-stripped composition", () => {
  it("never plays the missing overlay's source — it goes cold (pause); the real video plays", () => {
    const stripped = stripNonDecodingOverlays(missingVideoComp())!;
    const missing = makeFakeSource();
    const ok = makeFakeSource();
    // The missing overlay's source may still be mounted for a tick before the
    // registry reconcile disposes it — the budget must park it, not play it.
    const map = new Map<string, BudgetEntry>([
      ["vid-missing", { source: missing.source }],
      ["vid-ok", { source: ok.source }],
    ]);

    applyBudget({ composition: stripped, playheadSec: 4, playing: true, map });

    expect(ok.calls).toContain("play");
    expect(missing.calls).not.toContain("play");
    expect(missing.calls).toContain("pause");
  });
});
