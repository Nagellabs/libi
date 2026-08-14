import { describe, it, expect } from "vitest";
import {
  REVEAL_MODES,
  isRevealModeEnabled,
  revealDisabledReason,
  partitionRevealModes,
} from "@/lib/captions/reveal-modes";

describe("reveal-modes catalog", () => {
  it("lists the word-reveal modes (no `pop` — that's an Animation effect)", () => {
    const modes = REVEAL_MODES.map((m) => m.mode);
    expect(modes).toContain("none");
    expect(modes).toContain("karaoke");
    expect(modes).toContain("word-current");
    expect(modes).toContain("flythrough");
    expect(modes).not.toContain("pop");
  });

  it("karaoke exposes a color param; flythrough is 3D with direction + angle", () => {
    const karaoke = REVEAL_MODES.find((m) => m.mode === "karaoke")!;
    expect(karaoke.dim).toBe("2d");
    expect(karaoke.params.map((p) => p.key)).toEqual(["highlightColor"]);
    expect(karaoke.params[0].type).toBe("color");

    const fly = REVEAL_MODES.find((m) => m.mode === "flythrough")!;
    expect(fly.dim).toBe("3d");
    expect(fly.params.map((p) => p.key)).toEqual(["direction", "sideOffset"]);
  });

  it("gates modes by the caption's 3D state", () => {
    const fly = REVEAL_MODES.find((m) => m.mode === "flythrough")!;
    const typewriter = REVEAL_MODES.find((m) => m.mode === "typewriter")!;
    const none = REVEAL_MODES.find((m) => m.mode === "none")!;
    // 2D caption: 2D modes on, 3D modes off, `none` always on.
    expect(isRevealModeEnabled(typewriter, false)).toBe(true);
    expect(isRevealModeEnabled(fly, false)).toBe(false);
    expect(isRevealModeEnabled(none, false)).toBe(true);
    // 3D caption: flip — only 3D modes (and `none`).
    expect(isRevealModeEnabled(typewriter, true)).toBe(false);
    expect(isRevealModeEnabled(fly, true)).toBe(true);
    expect(isRevealModeEnabled(none, true)).toBe(true);
  });

  it("revealDisabledReason: null when enabled, explains the 3D mismatch otherwise", () => {
    const fly = REVEAL_MODES.find((m) => m.mode === "flythrough")!;
    const typewriter = REVEAL_MODES.find((m) => m.mode === "typewriter")!;
    const none = REVEAL_MODES.find((m) => m.mode === "none")!;
    // enabled → no reason
    expect(revealDisabledReason(typewriter, false)).toBeNull();
    expect(revealDisabledReason(fly, true)).toBeNull();
    expect(revealDisabledReason(none, false)).toBeNull();
    expect(revealDisabledReason(none, true)).toBeNull();
    // disabled → a reason that points at the fix
    expect(revealDisabledReason(fly, false)).toMatch(/3D/i);
    expect(revealDisabledReason(typewriter, true)).toMatch(/3D caption/i);
  });

  it("partitions into flat (2D/any) vs spatial (3D-only) sections", () => {
    const { flat, spatial } = partitionRevealModes();
    expect(spatial.map((m) => m.mode)).toEqual(["flythrough"]);
    expect(flat.some((m) => m.mode === "flythrough")).toBe(false);
    expect(flat.some((m) => m.mode === "karaoke")).toBe(true);
  });
});
