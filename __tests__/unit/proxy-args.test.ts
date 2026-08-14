/**
 * Unit: buildProxyArgs — exact ffmpeg flag set for proxy generation.
 *
 * Flag drift is a source of quality regressions (e.g. accidentally
 * dropping -movflags +faststart makes the proxy unstreamable). This
 * test pins the exact flag list.
 */
import { describe, it, expect } from "vitest";
import { buildProxyArgs } from "@/lib/proxy/args";

describe("buildProxyArgs", () => {
  it("produces resolution-aware (≤1080p) H.264 with 1 keyframe/sec GOP, fast preset, faststart", () => {
    const args = buildProxyArgs("/src/in.mp4", "/dst/proxy.mp4", { fps: 30 });
    expect(args).toEqual([
      "-y",
      "-i", "/src/in.mp4",
      "-vf", "scale='trunc(iw*min(ih,1080)/ih/2)*2':'trunc(min(ih,1080)/2)*2'",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-g", "30",                   // GOP = fps = 1 keyframe/sec
      "-keyint_min", "30",
      "-sc_threshold", "0",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "/dst/proxy.mp4",
    ]);
  });

  it("honors a non-30 fps for GOP sizing", () => {
    const args = buildProxyArgs("/a", "/b", { fps: 60 });
    expect(args).toContain("-g");
    const gopIndex = args.indexOf("-g");
    expect(args[gopIndex + 1]).toBe("60");
  });

  it("quotes dangerous paths literally (no shell interpretation)", () => {
    const args = buildProxyArgs("/path with space/a.mp4", "/b.mp4", { fps: 30 });
    expect(args).toContain("/path with space/a.mp4");
  });

  it("uses a scale expression that caps height at 1080 and even-truncates both dims", () => {
    const args = buildProxyArgs("/src.mp4", "/dst.mp4", { fps: 30 });
    const vfIndex = args.indexOf("-vf");
    const expr = args[vfIndex + 1]!;
    // Both output dimensions are even-truncated (libx264/yuv420p reject odd
    // width OR height), derived from a height capped at 1080.
    expect(expr).toBe(
      "scale='trunc(iw*min(ih,1080)/ih/2)*2':'trunc(min(ih,1080)/2)*2'",
    );
    // Guarantee we haven't reintroduced `force_original_aspect_ratio=decrease`,
    // which silently overrides the even-rounding behaviour.
    expect(expr).not.toContain("force_original_aspect_ratio");
    // And that we have NOT reintroduced the old `min(iw,…)` form, which left a
    // ≤1080p source's native (possibly odd) width untouched.
    expect(expr).not.toContain("min(iw,");
  });

  // Faithful JS port of the ffmpeg scale expression, so the even-dimension
  // invariant is checked arithmetically (ffmpeg itself can't run in the unit
  // env). Mirrors `trunc(iw*min(ih,1080)/ih/2)*2` × `trunc(min(ih,1080)/2)*2`.
  function proxyDims(iw: number, ih: number): { w: number; h: number } {
    const capH = Math.min(ih, 1080);
    return {
      w: Math.trunc((iw * capH) / ih / 2) * 2,
      h: Math.trunc(capH / 2) * 2,
    };
  }

  it("yields even width AND height, capping height at 1080 and never upscaling", () => {
    const cases: Array<[number, number]> = [
      [853, 480], // THE regression: odd-width ≤1080p Big Buck Bunny trailer → libx264 failed
      [1920, 1080], // even, sub/at cap → unchanged
      [3840, 2160], // 4K downscale → 1920×1080
      [1080, 1920], // vertical → height capped to 1080
      [1281, 721], // odd × odd, ≤1080
      [1279, 719], // odd × odd, ≤1080
      [641, 361], // small odd × odd
    ];
    for (const [iw, ih] of cases) {
      const { w, h } = proxyDims(iw, ih);
      expect(w % 2, `${iw}x${ih} → width ${w} must be even`).toBe(0);
      expect(h % 2, `${iw}x${ih} → height ${h} must be even`).toBe(0);
      expect(h, `${iw}x${ih} → height must be ≤ min(ih,1080)`).toBeLessThanOrEqual(
        Math.min(ih, 1080),
      );
      expect(w, `${iw}x${ih} → width must not upscale`).toBeLessThanOrEqual(iw);
      expect(w, `${iw}x${ih} → width must be positive`).toBeGreaterThan(0);
    }
  });

  it("maps the 853×480 regression case to 852×480 (even width)", () => {
    expect(proxyDims(853, 480)).toEqual({ w: 852, h: 480 });
  });
});
