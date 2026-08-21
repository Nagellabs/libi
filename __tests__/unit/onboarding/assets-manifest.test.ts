/**
 * The published asset list is what a fresh install downloads. Anything wrong
 * here is wrong for every new user: a missing slug means a broken piece, an
 * extra one means we pay to host bytes nothing renders, and a bad hash means
 * the build hard-fails after a 14.8 MB download.
 */
import { describe, it, expect } from "vitest";
import { ONBOARDING_ASSETS_V1, assetBySlug } from "@/lib/onboarding/piece/v1/assets";

describe("onboarding v1 assets", () => {
  it("ships exactly the 21 referenced files", () => {
    expect(ONBOARDING_ASSETS_V1).toHaveLength(21);
  });

  it("totals 14,796,113 bytes — post-re-encode", () => {
    // POST-RE-ENCODE number. The three fullscreen clips are published as
    // `libx264 -crf 20 -preset slow -pix_fmt yuv420p -vf scale='min(1920,iw)':-2
    //  -c:a aac -b:a 128k`, which took them from 61,264,411 to 10,093,630 bytes
    // and the whole download from 65,966,894 to this. Judged visually at native
    // resolution on the hardest content in the film (the near-black gradient in
    // clip-water-impact) and measured over EVERY frame at PSNR-Y 43.7–49.7 dB /
    // SSIM >= 0.992. See docs-local/onboarding-v1/reencode-decision.md.
    const total = ONBOARDING_ASSETS_V1.reduce((n, a) => n + a.bytes, 0);
    expect(total).toBe(14_796_113);
  });

  it("carries no VO bus mix — the six lines replaced it", () => {
    // Shipping a bus would silently reinstate the single-sidechain workaround
    // that multi-sidechain ducking removed.
    for (const a of ONBOARDING_ASSETS_V1) expect(a.slug).not.toMatch(/vo-bus/);
  });

  it("carries no unreferenced leftovers from the build session", () => {
    const slugs = ONBOARDING_ASSETS_V1.map((a) => a.slug);
    for (const dead of [
      "sfx-whoosh.mp3",
      "music-anthem-6s.mp3",
      "clip-hero-orbit.mp4",
      "libi-icon-alpha.png",
      "youtube-thumbnail.png",
    ]) {
      expect(slugs, `${dead} is not referenced by anything`).not.toContain(dead);
    }
  });

  it("uses clean slugs — no spaces, parentheses, or uppercase", () => {
    // `libi-ring-glyph (1).png` is what the source piece actually holds.
    for (const a of ONBOARDING_ASSETS_V1) {
      expect(a.slug, a.slug).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    }
  });

  it("pins a full lowercase-hex sha256 for every asset", () => {
    for (const a of ONBOARDING_ASSETS_V1) {
      expect(a.sha256, a.slug).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes, a.slug).toBeGreaterThan(0);
    }
  });

  it("has unique slugs and resolves them", () => {
    const slugs = ONBOARDING_ASSETS_V1.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(assetBySlug(slugs[0])?.slug).toBe(slugs[0]);
    expect(assetBySlug("nope.mp4")).toBeUndefined();
  });

  it("declares the expected kind mix", () => {
    const by = (k: string) => ONBOARDING_ASSETS_V1.filter((a) => a.kind === k).length;
    expect(by("video")).toBe(3);
    expect(by("image")).toBe(6);
    expect(by("audio")).toBe(12); // 2 music + 4 sfx + 6 VO
  });
});
