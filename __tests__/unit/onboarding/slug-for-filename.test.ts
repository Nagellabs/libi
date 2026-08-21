/**
 * `slugForFilename` decides the public bucket path of every onboarding asset,
 * and a bucket path is forever — you cannot rename it later without breaking
 * every installed build that pinned the old one.
 *
 * This file is the ONLY reason `slugForFilename` is exported: nothing imports
 * it, the extractor calls it internally, and without these assertions its one
 * genuinely subtle rule is unguarded. `__tests__/unit/onboarding/assets-manifest`
 * only checks the SHAPE of the shipped slugs (`/^[a-z0-9][a-z0-9.-]*$/`), which
 * `libi-ring-glyph-1.png` satisfies just as happily as `libi-ring-glyph.png` —
 * so the exact regression the function's comment warns against would pass every
 * assertion over there. It has to be pinned here.
 */
import { describe, it, expect } from "vitest";
import { slugForFilename } from "@/scripts/extract-onboarding-piece";

describe("slugForFilename", () => {
  it("strips a trailing ` (N)` dedupe marker BEFORE collapsing, not after", () => {
    // The whole point. ` (1)` is an upload artifact — `dedupeFilename` in
    // mcp/tools/file-tools.ts appends it when a name is already taken in a
    // piece — not part of the asset's identity. Running only the collapse rule
    // keeps the digit (it is inside `[a-z0-9.-]`) and bakes the accident into a
    // public bucket path forever.
    expect(slugForFilename("libi-ring-glyph (1).png")).toBe("libi-ring-glyph.png");
    expect(slugForFilename("libi-ring-glyph (1).png")).not.toBe("libi-ring-glyph-1.png");
  });

  it("strips the marker regardless of spacing or index width", () => {
    expect(slugForFilename("clip-track-demo (12).mp4")).toBe("clip-track-demo.mp4");
    expect(slugForFilename("clip-track-demo(2).mp4")).toBe("clip-track-demo.mp4");
    expect(slugForFilename("clip-track-demo (3) .mp4")).toBe("clip-track-demo.mp4");
  });

  it("keeps a parenthesised group that is NOT a trailing dedupe marker", () => {
    // Only a trailing `(digits)` is an upload artifact. A number that is part
    // of the name — a take, a version — is identity and must survive.
    expect(slugForFilename("vo-line-2.mp3")).toBe("vo-line-2.mp3");
    expect(slugForFilename("clip-hero-orbit-v2.mp4")).toBe("clip-hero-orbit-v2.mp4");
    expect(slugForFilename("Take (2) final.wav")).toBe("take-2-final.wav");
  });

  it("lowercases and collapses every run of illegal characters to one dash", () => {
    expect(slugForFilename("Libi Ring Glyph.PNG")).toBe("libi-ring-glyph.png");
    expect(slugForFilename("music   bed__loop.mp3")).toBe("music-bed-loop.mp3");
    expect(slugForFilename("sfx whoosh?!.mp3")).toBe("sfx-whoosh.mp3");
  });

  it("trims leading and trailing dashes left by the collapse", () => {
    expect(slugForFilename(" _hero_ .mp4")).toBe("hero.mp4");
    expect(slugForFilename("--hero--.mp4")).toBe("hero.mp4");
  });

  it("preserves dots inside the stem — they are legal in a slug", () => {
    expect(slugForFilename("music.bed.v1.mp3")).toBe("music.bed.v1.mp3");
  });

  it("lowercases the extension and keeps it attached", () => {
    expect(slugForFilename("thumb.JPEG")).toBe("thumb.jpeg");
  });

  it("throws rather than emit an empty slug", () => {
    // An empty slug would become a bucket path of just `.png`, which is not a
    // name — better to stop than to publish it.
    expect(() => slugForFilename("(1).png")).toThrow(/empty slug/);
    expect(() => slugForFilename("___.mp3")).toThrow(/empty slug/);
  });

  it("produces slugs that satisfy the published-slug shape", () => {
    // The same regex assets-manifest.test.ts asserts over the shipped set, so
    // the two can't drift apart.
    for (const name of ["libi-ring-glyph (1).png", "Libi Ring Glyph.PNG", "vo-line-2.mp3"]) {
      expect(slugForFilename(name)).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    }
  });
});
