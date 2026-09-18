/**
 * QA 2026-09-18 N3: the ffmpeg drawtext export named the family only
 * (`font=Inter`), so a bold caption exported at regular weight — and on a
 * machine whose fontconfig can't find Inter, in a different face entirely.
 * The export now draws with the SAME bundled file the preview's @font-face
 * picks, which needs CSS's weight-matching rule to choose it.
 */
import { describe, it, expect } from "vitest";
import { bundledFaceFor, cssFontWeight } from "@/lib/fonts/bundled";

describe("cssFontWeight", () => {
  it.each([
    [undefined, 400],
    ["normal", 400],
    ["bold", 700],
    ["700", 700],
    [600, 600],
    ["garbage", 400],
  ] as const)("%s → %s", (input, expected) => {
    expect(cssFontWeight(input)).toBe(expected);
  });
});

describe("bundledFaceFor — CSS font-weight matching over the bundled faces", () => {
  it.each([
    ["Inter", 700, "Inter-Bold.ttf"],
    ["Inter", "bold", "Inter-Bold.ttf"],
    ["Inter", 400, "Inter-Regular.ttf"],
    ["Inter", undefined, "Inter-Regular.ttf"],
    // 500: nothing in 500..500, so the next lighter face.
    ["Inter", 500, "Inter-Regular.ttf"],
    // Above 500: heavier first, then lighter.
    ["Inter", 650, "Inter-Bold.ttf"],
    ["Inter", 900, "Inter-ExtraBold.ttf"],
    // Below 400: lighter first (none), then heavier.
    ["Inter", 300, "Inter-Regular.ttf"],
    ["JetBrains Mono", 600, "JetBrainsMono-Bold.ttf"],
    ["inter", 700, "Inter-Bold.ttf"],
    ['"Inter", sans-serif', 800, "Inter-ExtraBold.ttf"],
  ] as const)("%s @ %s → %s", (family, weight, file) => {
    expect(bundledFaceFor(family, weight)?.file).toBe(file);
  });

  it("returns undefined for a family libi doesn't ship", () => {
    expect(bundledFaceFor("Anton", 700)).toBeUndefined();
  });
});
