/**
 * The ffmpeg drawtext export reproduces what the PREVIEW draws for a caption's
 * wrap, shadow and background plate (drawTextOverlay,
 * lib/engine/overlay-renderer.ts), and the classifier routes what drawtext
 * can't draw to the chromium renderer.
 *
 * Measures are injected: a fixed 10 px/char font makes every break and plate
 * edge computable by hand. The real font path is exercised against the bundled
 * ffmpeg in __tests__/integration/export/caption-fidelity-real-ffmpeg.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  unionEnableExpr,
  drawtextSpecFor,
  plateSpecFor,
  blurredShadowOf,
  type TextOverlayLike,
} from "@/lib/export/overlay-filter";
import { layoutTextForExport, type TextMeasurer } from "@/lib/export/text-export-layout";
import { buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import { classifyExportShape } from "@/lib/export/classifier";
import type { Composition, Overlay } from "@/lib/engine/types";

const tenPx: TextMeasurer = {
  width: (s) => s.length * 10,
  ink: () => ({ ascent: -5, descent: 40 }),
};

const base: TextOverlayLike = {
  kind: "text",
  startTime: 1,
  duration: 2,
  rect: { x: 40, y: 1500, width: 1000, height: 200 },
  content: "Hello",
  font: "48px Inter",
  fontSize: 50,
  color: "#ffffff",
  align: "center",
};

/** The `text='…'` of every drawtext in a spec, in order. */
function drawnLines(spec: string): string[] {
  return [...spec.matchAll(/drawtext=text='((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}

describe("wrap — the preview's line breaks", () => {
  // 58 characters: the portrait QA caption.
  const caption58 = "This caption is long enough that it must wrap in portrait.";

  it("an anchored caption wraps at frameWidth × maxWidthPct with the injected measure", () => {
    expect(caption58).toHaveLength(58);
    const o = { ...base, content: caption58, anchor: "mid-center" as const, maxWidthPct: 0.25 };
    // wrap width 1080 × 0.25 = 270 px = 27 chars at 10 px/char
    const layout = layoutTextForExport(o, 1080, tenPx);
    expect(layout.lines).toEqual(["This caption is long enough", "that it must wrap in", "portrait."]);
    const spec = drawtextSpecFor(o, 0, undefined, 1, layout);
    expect(drawnLines(spec)).toEqual(layout.lines);
  });

  it("each wrapped line is its own drawtext, centred as a block in the rect", () => {
    const o = { ...base, content: caption58, anchor: "mid-center" as const, maxWidthPct: 0.25 };
    const layout = layoutTextForExport(o, 1080, tenPx);
    // block = 3 × 50 × 1.2 = 180; (200 − 180)/2 = 10 → tops 1510, 1570, 1630
    const spec = drawtextSpecFor(o, 0, undefined, 1, layout);
    expect(spec).toContain("y=1510+50*font_a/(font_a+abs(font_d))");
    expect(spec).toContain("y=1570+50*font_a/(font_a+abs(font_d))");
    expect(spec).toContain("y=1630+50*font_a/(font_a+abs(font_d))");
  });

  it("no maxWidthPct on an anchored caption ⇒ one line, however long", () => {
    const o = { ...base, content: caption58, anchor: "mid-center" as const };
    expect(layoutTextForExport(o, 1080, tenPx).lines).toEqual([caption58]);
  });

  it("an un-anchored (add_overlay) text wider than its rect wraps at the rect width — build-time normalization", () => {
    // approx width = 58 × 50 × 0.5 = 1450 > rect 900 ⇒ it WAS a wrap box:
    // maxWidthPct = 900 / 1080, so the wrap lands on the authored 900 px.
    const o = { ...base, content: caption58, rect: { x: 90, y: 1500, width: 900, height: 200 } };
    const layout = layoutTextForExport(o, 1080, { ...tenPx, width: (s) => s.length * 25 });
    // 900 / 25 = 36 chars per line
    expect(layout.lines).toEqual(["This caption is long enough that it", "must wrap in portrait."]);
  });

  it("the WRAP DECISION uses the approximate measure, as the preview's build does", () => {
    // approx: 20 chars × 50 × 0.5 = 500 ≤ rect 600 ⇒ the preview does NOT wrap,
    // even though the real font measures it wider than the rect.
    const o = { ...base, content: "twenty chars exactly", rect: { x: 0, y: 0, width: 600, height: 100 } };
    const wide: TextMeasurer = { ...tenPx, width: (s) => s.length * 40 };
    expect(layoutTextForExport(o, 1080, wide).lines).toEqual(["twenty chars exactly"]);
  });

  it("empty lines draw nothing and take no slot — the preview drops them too", () => {
    const layout = layoutTextForExport({ ...base, content: "a\n\nb", lineHeight: 1 }, 1080, tenPx);
    expect(layout.lines).toEqual(["a", "b"]);
  });

  it("wraps in COMPOSITION space and scales: a 4K export has the 1080 line breaks", () => {
    const o = { ...base, content: caption58, anchor: "mid-center" as const, maxWidthPct: 0.25 };
    const layout = layoutTextForExport(o, 1080, tenPx);
    const spec = drawtextSpecFor(o, 0, undefined, 2, layout);
    expect(drawnLines(spec)).toEqual(layout.lines);
    expect(spec).toContain("fontsize=100");
    expect(spec).toContain("y=3020+100*font_a/(font_a+abs(font_d))");
  });
});

describe("shadow", () => {
  it("a hard shadow (blur ≤ 1) is drawtext's own shadow, offset scaled", () => {
    const o = { ...base, shadow: { color: "rgba(0,0,0,0.5)", blur: 0, dx: 3, dy: 4 } };
    expect(blurredShadowOf(o, 1)).toBeNull();
    const spec = drawtextSpecFor(o, 0, undefined, 2);
    expect(spec).toContain("shadowx=6");
    expect(spec).toContain("shadowy=8");
    expect(spec).toContain("shadowcolor=#00000080");
  });

  it("a blurred shadow is NOT drawtext's hard shadow — it goes on a blurred layer", () => {
    const o = { ...base, shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 } };
    expect(drawtextSpecFor(o, 0)).not.toContain("shadowx");
    // canvas shadowBlur b ⇒ gaussian σ = b/2, in target px
    // the colour is opaque; its alpha (0x8c / 255) is applied once, after the blur
    expect(blurredShadowOf(o, 2)).toEqual({ sigma: 8, color: "#000000", alpha: 0.549 });
    expect(blurredShadowOf({ ...o, opacity: 0.5 }, 1)).toMatchObject({ alpha: 0.275 });
  });

  it("buildFilterChain draws a blurred shadow under the text: layer → gblur → overlay → fill", () => {
    const o = {
      ...base, id: "t1", z: 1, opacity: 1, anchor: "mid-center",
      shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 },
    } as unknown as Overlay;
    const graph = buildFilterChain([o], new Map(), { width: 1080, height: 1920 });
    expect(graph).toMatch(/format=yuv420p,split=3\[/);
    expect(graph).toContain("gblur=sigma=4");
    // the silhouette is an opaque white MASK (no colour alpha, no alpha=): the
    // shadow alpha is applied ONCE, to the blurred mask. Drawing it in the
    // translucent shadow colour applied it twice (0.55 → ≈0.30).
    expect(graph).toContain("format=gray,lut=c0=0,drawtext=text='Hello':fontcolor=white:");
    expect(graph).not.toContain("fontcolor=#0000008c");
    expect(graph).toContain("drawbox=c=#000000:t=fill:replace=1");
    expect(graph).toContain("alphamerge,lut=a=val*0.549");
    // blur + composite only while the caption is on screen
    expect(graph).toContain("gblur=sigma=4:steps=3:enable='between(t,1,3)'");
    // The layer is only the rows the shadow can reach — line top 1570 + dy 2,
    // less a font size (50) and 3σ (12) → 1510 — so the silhouette is drawn
    // relative to that band and the band is put back at its row.
    expect(graph).toContain("crop=iw:");
    expect(graph).toContain(":0:1510,format=gray");
    expect(graph).toContain("y=62+50*font_a/(font_a+abs(font_d))");
    expect(graph).toContain("overlay=0:1510:enable='between(t,1,3)'[");
    const gblurAt = graph.indexOf("gblur");
    const fillAt = graph.indexOf("fontcolor=#ffffff");
    expect(gblurAt).toBeGreaterThan(-1);
    expect(fillAt).toBeGreaterThan(gblurAt);
  });

  it("a caption TRACK shares ONE blurred layer (120 cues → one gblur, not 120)", () => {
    const cues = Array.from({ length: 120 }, (_, i) => ({
      ...base, id: `c${i}`, z: i + 1, opacity: 1, anchor: "mid-center",
      startTime: i * 0.5, duration: 0.5, content: `Cue number ${i} says something`,
      shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 },
    })) as unknown as Overlay[];
    const graph = buildFilterChain(cues, new Map(), { width: 1080, height: 1920 });
    expect(graph.match(/gblur=/g)).toHaveLength(1);
    expect(graph.match(/split/g)).toHaveLength(1);
    // back-to-back cues merge into ONE enable window
    expect(graph).toContain("gblur=sigma=4:steps=3:enable='between(t,0,60)'");
  });

  it("a NAMED shadow colour fills the layer as that colour (was black)", () => {
    const o = {
      ...base, id: "t1", z: 1, opacity: 1, anchor: "mid-center",
      shadow: { color: "white", blur: 8 },
    } as unknown as Overlay;
    const graph = buildFilterChain([o], new Map(), { width: 1080, height: 1920 });
    expect(graph).toContain("drawbox=c=white:t=fill:replace=1");
    expect(graph).toContain("lut=a=val*1[");
  });

  it("members with different shadow alphas or opacities get separate layers", () => {
    const a = { ...base, id: "a", z: 1, opacity: 1, anchor: "mid-center", shadow: { color: "rgba(0,0,0,0.5)", blur: 6 } };
    const b = { ...a, id: "b", z: 2, startTime: 5, opacity: 0.5 };
    const graph = buildFilterChain([a, b] as unknown as Overlay[], new Map(), { width: 1080, height: 1920 });
    expect(graph.match(/gblur=/g)).toHaveLength(2);
  });

  it("texts on screen at the SAME time get separate layers, so z-order holds", () => {
    const a = { ...base, id: "a", z: 1, opacity: 1, anchor: "mid-center", shadow: { color: "#000", blur: 6 } };
    const b = { ...a, id: "b", z: 2, startTime: 2 };
    const graph = buildFilterChain([a, b] as unknown as Overlay[], new Map(), { width: 1080, height: 1920 });
    expect(graph.match(/gblur=/g)).toHaveLength(2);
  });
});

describe("background plate", () => {
  it("one drawbox around the whole block: widest line + padding, ink top/bottom + padding", () => {
    const o = {
      ...base, content: "ab\nabcd", anchor: "mid-center" as const, lineHeight: 1,
      background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 0 },
    };
    const layout = layoutTextForExport(o, 1080, tenPx);
    // block 2 × 50 = 100 → top 1550; ink 1555 … 1640 (line 2 top 1600 + 40)
    // widest 40 → plate w 64, x = 40 + 500 − 32 = 508; y 1543, h 85 + 24 = 109
    expect(layout.plate).toMatchObject({ x: 508, y: 1543, width: 64, height: 109 });
    const spec = plateSpecFor(o, layout, 0, 1)!;
    expect(spec).toBe("drawbox=x=508:y=1543:w=64:h=109:color=#00000099:t=fill:enable='between(t,1,3)'");
  });

  it("scales with the export and folds the overlay's opacity into the plate colour", () => {
    const o = {
      ...base, anchor: "mid-center" as const, opacity: 0.5,
      background: { color: "#000000", padding: 10 },
    };
    const layout = layoutTextForExport(o, 1080, tenPx);
    const spec = plateSpecFor(o, layout, 0, 2)!;
    expect(spec).toContain("color=#00000080");
    expect(spec).toMatch(/w=140:/); // (50 + 20) × 2
  });

  it("no background ⇒ no plate", () => {
    expect(plateSpecFor(base, layoutTextForExport(base, 1080, tenPx), 0, 1)).toBeNull();
  });

  it("buildFilterChain draws the plate BEFORE the text", () => {
    const o = {
      ...base, id: "t1", z: 1, opacity: 1, anchor: "mid-center",
      background: { color: "#000000", padding: 10, radius: 4 },
    } as unknown as Overlay;
    const graph = buildFilterChain([o], new Map(), { width: 1080, height: 1920 });
    expect(graph.indexOf("drawbox=")).toBeGreaterThan(-1);
    expect(graph.indexOf("drawbox=")).toBeLessThan(graph.indexOf("drawtext="));
  });
});

describe("classifier — what drawtext can't draw routes to the chromium renderer", () => {
  function comp(text: Record<string, unknown>): Composition {
    return {
      id: "c", width: 1080, height: 1920, fps: 30, durationInFrames: 300, scenes: [],
      overlays: [
        {
          id: "bg", kind: "video", fileId: "f", startTime: 0, duration: 10, z: 0, opacity: 1,
          rect: { x: 0, y: 0, width: 1080, height: 1920 }, fit: "cover",
          sourceWidth: 1080, sourceHeight: 1920,
        },
        {
          id: "t", kind: "text", startTime: 1, duration: 2, z: 1, opacity: 1,
          rect: { x: 40, y: 1500, width: 1000, height: 200 }, content: "Hello there",
          font: "48px Inter", color: "#fff", align: "center", ...text,
        },
      ],
      audioClips: [],
    } as unknown as Composition;
  }

  it("a plain caption with shadow + background stays on the ffmpeg fast path", () => {
    expect(classifyExportShape(comp({
      shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 },
      background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 },
    })).tag).toBe("ffmpeg-overlay");
  });

  it.each(["typewriter", "fade-words", "slide-up", "pop", "karaoke", "word-current"])(
    "a %s reveal animates — chromium-render",
    (mode) => {
      expect(classifyExportShape(comp({ reveal: { mode } })).tag).toBe("chromium-render");
    },
  );

  it("reveal mode 'none' is static — ffmpeg", () => {
    expect(classifyExportShape(comp({ reveal: { mode: "none" } })).tag).toBe("ffmpeg-overlay");
  });

  it.each(["Let's go 🔥", "I ❤️ this", "Made in 🇮🇱", "Press 1️⃣"])("emoji %s — chromium-render", (content) => {
    expect(classifyExportShape(comp({ content })).tag).toBe("chromium-render");
  });

  it("© ® ™ are ordinary font glyphs — ffmpeg", () => {
    expect(classifyExportShape(comp({ content: "libi™ © 2026 ®" })).tag).toBe("ffmpeg-overlay");
  });

  function track(n: number, zBase: number, zStep: number, y: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `${y}-${i}`, kind: "text", startTime: i * 0.4, duration: 0.4, z: zBase + i * zStep, opacity: 1,
      rect: { x: 40, y, width: 1000, height: 100 }, content: `cue ${i}`, font: "48px Inter", color: "#fff",
      align: "center", shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dy: 2 },
    }));
  }
  function withTexts(texts: unknown[]): Composition {
    const c = comp({});
    return { ...c, overlays: [c.overlays![0], ...(texts as Overlay[])] } as Composition;
  }

  it("a 20-cue shadowed caption track is ONE shadow layer — ffmpeg", () => {
    expect(classifyExportShape(withTexts(track(20, 1, 1, 1500))).tag).toBe("ffmpeg-overlay");
  });

  // Two simultaneous tracks whose cues interleave in z (a, b, a, b, …) break
  // every run at each cue: a layer per cue, 40 blurs a frame.
  it("interleaved simultaneous shadowed tracks past the layer cap — chromium-render", () => {
    const a = track(20, 1, 2, 1500);
    const b = track(20, 2, 2, 200);
    expect(classifyExportShape(withTexts([...a, ...b])).tag).toBe("chromium-render");
  });

  // Cue times rounded to the millisecond overlap their neighbour by 0.001 s;
  // that split a 36-cue track into 13 runs → 13 blur layers, and its 4K
  // export stalled for 15+ minutes. A sub-frame overlap isn't an overlap.
  it("a track whose cues overlap by rounding error is still ONE run — ffmpeg", () => {
    const t = track(36, 1, 1, 1500).map((c, i) => ({ ...c, startTime: Math.round(i * 0.2667 * 1000) / 1000, duration: 0.267 }));
    expect(classifyExportShape(withTexts(t)).tag).toBe("ffmpeg-overlay");
  });

  it("the rounding tolerance: a 1 ms overlap groups, a 30 ms true overlap does not", async () => {
    const { shadowLayerCount } = await import("@/lib/export/text-runs");
    const pair = (overlap: number) => {
      const [a] = track(1, 1, 1, 1500);
      const b = { ...a, id: "b", z: 2, startTime: a.startTime + a.duration - overlap };
      return shadowLayerCount([a, b]);
    };
    expect(pair(0.001)).toBe(1);
    expect(pair(0.03)).toBe(2);
  });

  it("five shadowed texts on screen at once (five layers) — chromium-render", () => {
    const five = [0, 1, 2, 3, 4].map((k) => ({ ...track(1, k + 1, 1, 200 + k * 300)[0], id: `s${k}` }));
    expect(classifyExportShape(withTexts(five)).tag).toBe("chromium-render");
  });

  it("a plate rounder than drawtext's square corners can pass for — chromium-render", () => {
    expect(classifyExportShape(comp({ background: { color: "#000", padding: 12, radius: 24 } })).tag)
      .toBe("chromium-render");
  });
});

describe("unionEnableExpr", () => {
  it("merges touching and overlapping windows", () => {
    expect(unionEnableExpr([{ startTime: 2, duration: 1 }, { startTime: 0, duration: 2 }, { startTime: 5, duration: 1 }], 0))
      .toBe("between(t,0,3)+between(t,5,6)");
  });

  // ffmpeg failed to parse a sum of 120 `between`s (a sparse caption track).
  it("many disjoint windows collapse to one covering window", () => {
    const w = Array.from({ length: 120 }, (_, i) => ({ startTime: i, duration: 0.5 }));
    expect(unionEnableExpr(w, 0)).toBe("between(t,0,119.5)");
  });
});

describe("server text measure", () => {
  it("a font file Skia can't register falls back to measuring by family, not Skia's default face", async () => {
    const { createServerTextMeasurer } = await import("@/lib/export/text-measure-server");
    const o = { ...base, content: "", font: "700 72px Inter", fontSize: 72, fontWeight: 700 };
    const byFamily = createServerTextMeasurer(o);
    const broken = createServerTextMeasurer(o, "/nonexistent/NotAFont.ttf");
    expect(broken.width("Hello caption")).toBeCloseTo(byFamily.width("Hello caption"), 3);
  });
});
