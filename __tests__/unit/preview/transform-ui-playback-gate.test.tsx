import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { showTransformUi } from "@/lib/preview/transform-ui-gate";

/**
 * Locks in "on-canvas transform handles are hidden during playback".
 *
 * PreviewPlayer is far too heavy to mount in jsdom (it pulls in three.js,
 * mediabunny/WebCodecs, the whole audio engine), so this verifies the invariant
 * at two seams:
 *   1. the pure `showTransformUi(playing, active)` gate (truth table), and
 *   2. a source scan asserting `playing` is threaded into that gate AND every
 *      transform-UI surface drawn from the selected overlay's geometry mounts
 *      behind it — so a future 6th ungated handle/gizmo fails here.
 *
 * The historical bug this guards: for a keyframed overlay the gizmo lagged one
 * frame behind the box during playback, and the per-frame transform subtree
 * triggered a recurring major GC → playback stutter. Hiding it while playing is
 * both the fix and pro-editor behavior.
 */
describe("showTransformUi (playback gate)", () => {
  it("shows the transform UI only when PAUSED and the overlay is active", () => {
    expect(showTransformUi(false, true)).toBe(true);
  });

  it("hides the transform UI while PLAYING, even with an active selection", () => {
    expect(showTransformUi(true, true)).toBe(false);
  });

  it("hides the transform UI when nothing is active at the playhead", () => {
    expect(showTransformUi(false, false)).toBe(false);
    expect(showTransformUi(true, false)).toBe(false);
  });

  it("`playing` is the dominant term — no active selection can override it", () => {
    for (const active of [true, false]) {
      expect(showTransformUi(true, active)).toBe(false);
    }
  });
});

describe("preview-player transform-UI mounts stay behind the playback gate", () => {
  const src = readFileSync("components/preview/preview-player.tsx", "utf-8");

  it("routes the gate through showTransformUi with `playing` as an argument", () => {
    // The `!playing` term must live in the gate. If someone drops `playing`
    // from the call (or re-inlines the boolean without it), this fails.
    expect(src).toMatch(
      /const showTransformUI\s*=\s*showTransformUi\(\s*playing\s*,/,
    );
  });

  it("references showTransformUI as many times as there are gated mounts", () => {
    // 1 definition + 6 mount guards (2D handles, 3D text gizmo, readability
    // pill, non-text transform box, tracked scale/spin frame, non-text 3D
    // gizmo) + 1 suppression (the tracked reveal outline mirrors the tracked
    // gizmo's gate to drop itself while the gizmo is up — one box per state).
    // If a mount loses its guard the count drops; if a new gated mount is
    // added, bump this number deliberately (which is the point — it forces a
    // conscious decision).
    const uses = src.match(/showTransformUI/g) ?? [];
    expect(uses.length).toBe(8);
  });

  it("gates every on-canvas transform surface right before it mounts", () => {
    // Each transform-UI surface must have `showTransformUI &&` within the JSX
    // conditional immediately preceding it. A new `<ThreeGizmoControls>` (etc.)
    // added without the gate — the exact regression this task locks out — has
    // no nearby `showTransformUI` and fails.
    //
    // Markers: the three transform components + the readability pill's
    // distinctive gate condition (`isOverlayNearEdgeOn(`).
    const markers = [
      "<OverlayHandles",
      "<OverlayTransformControls",
      "<TrackedTransformControls",
      "<ThreeGizmoControls",
      "isOverlayNearEdgeOn(",
    ];
    // Chars of conditional preamble to search before a mount. Sized for the
    // tracked mount, whose gate is followed by an IIFE (sampleTrack +
    // resolveTrackedRect) before the JSX element (~700 chars).
    const WINDOW = 800;

    for (const marker of markers) {
      let from = 0;
      let occurrences = 0;
      for (;;) {
        const idx = src.indexOf(marker, from);
        if (idx === -1) break;
        occurrences += 1;
        const preamble = src.slice(Math.max(0, idx - WINDOW), idx);
        expect(
          preamble.includes("showTransformUI"),
          `"${marker}" occurrence #${occurrences} is not gated by showTransformUI`,
        ).toBe(true);
        from = idx + marker.length;
      }
      // Sanity: the marker must actually exist, or the guard is vacuous.
      expect(occurrences, `marker "${marker}" not found in preview-player`).toBeGreaterThan(0);
    }
  });
});
