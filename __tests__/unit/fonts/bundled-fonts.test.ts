/**
 * Guards for libi's bundled 2D text fonts.
 *
 * The bug these exist for: a canvas asked to draw in a family that isn't
 * installed substitutes a fallback face and reports NOTHING — `ctx.font` reads
 * back the string that was set either way. A whole 42-second piece rendered in
 * a serif fallback because it asked for "Inter", and nothing caught it for
 * twenty hours. The sentinel test below is the assertion that would have.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import {
  BUNDLED_FONTS,
  BUNDLED_FONT_FAMILIES,
  DEFAULT_TEXT_FAMILY,
  DEFAULT_MONO_FAMILY,
  bundledFontFaceCss,
  bundledFontUrl,
  isBundledFamily,
} from "@/lib/fonts/bundled";
import {
  ensureBundledFontsRegistered,
  bundledFontFilePath,
} from "@/lib/fonts/register-server";

/** A family name that cannot exist — the fallback yardstick. */
const SENTINEL = "LibiNonexistentFontXYZ";
const SAMPLE = "ENGINEERED TO FLOAT";

function widthOf(font: string): number {
  const ctx = createCanvas(10, 10).getContext("2d");
  ctx.font = font;
  return ctx.measureText(SAMPLE).width;
}

/**
 * Total alpha laid down drawing `SAMPLE`. Weight must be probed by INK, not by
 * width: a monospace face has a fixed advance, so JetBrains Mono 400 and 700
 * measure identically even when the weight is applied correctly.
 */
function inkOf(font: string): number {
  const canvas = createCanvas(1400, 240);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 1400, 240);
  ctx.fillStyle = "#fff";
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillText(SAMPLE, 10, 20);
  const data = ctx.getImageData(0, 0, 1400, 240).data;
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i];
  return sum;
}

describe("bundled fonts — files and registry", () => {
  it("ships every declared face plus its license", () => {
    for (const face of BUNDLED_FONTS) {
      expect(fs.existsSync(bundledFontFilePath(face.file)), face.file).toBe(true);
    }
    // OFL §2: a bundled font must carry its license.
    for (const license of ["Inter-LICENSE.txt", "JetBrainsMono-OFL.txt"]) {
      const p = path.join(process.cwd(), "public", "fonts", "2d", license);
      expect(fs.existsSync(p), license).toBe(true);
    }
  });

  it("declares the families the defaults name", () => {
    expect(BUNDLED_FONT_FAMILIES).toContain(DEFAULT_TEXT_FAMILY);
    expect(BUNDLED_FONT_FAMILIES).toContain(DEFAULT_MONO_FAMILY);
    expect(isBundledFamily("inter")).toBe(true);
    expect(isBundledFamily("  Inter  ")).toBe(true);
    expect(isBundledFamily(SENTINEL)).toBe(false);
  });

  it("has no duplicate family+weight pairs", () => {
    const keys = BUNDLED_FONTS.map((f) => `${f.family}:${f.weight}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("bundled fonts — CSS reaches both browser renderers", () => {
  it("emits an @font-face per declared face", () => {
    const css = bundledFontFaceCss();
    for (const face of BUNDLED_FONTS) {
      expect(css).toContain(bundledFontUrl(face.file));
      expect(css).toContain(`font-family:"${face.family}"`);
    }
    expect(css.match(/@font-face/g) ?? []).toHaveLength(BUNDLED_FONTS.length);
  });

  it("blocks rather than swaps, so a render never bakes in the fallback", () => {
    expect(bundledFontFaceCss()).toContain("font-display:block");
    expect(bundledFontFaceCss()).not.toContain("font-display:swap");
  });

  it("app/globals.css declares exactly the same faces (preview must match export)", () => {
    // globals.css is static CSS and cannot import the registry, so drift is
    // possible and would mean preview and export disagree. This is the check.
    const css = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
    for (const face of BUNDLED_FONTS) {
      const url = bundledFontUrl(face.file);
      const rule = css
        .split("@font-face")
        .find((chunk) => chunk.includes(url));
      expect(rule, `globals.css is missing an @font-face for ${face.file}`).toBeDefined();
      expect(rule, `globals.css declares the wrong weight for ${face.file}`).toContain(
        `font-weight:${face.weight}`,
      );
      expect(rule).toContain(`font-family:"${face.family}"`);
    }
    // Match actual RULES (`@font-face{`), not every mention of the token —
    // the surrounding comment in globals.css talks about @font-face too.
    const declared = css.match(/@font-face\s*\{/g) ?? [];
    expect(
      declared.length,
      "globals.css declares more @font-face rules than the registry does",
    ).toBe(BUNDLED_FONTS.length);
  });

  it("keeps the @font-face rules inside @layer base", () => {
    // Tailwind v4 (@tailwindcss/postcss 4.2.2) DROPS top-level @font-face rules
    // from a file that does `@import "tailwindcss"`. Verified in the running
    // app: the compiled stylesheet carried this file's :root tokens but zero
    // occurrences of "Inter" or "/fonts/2d/", and a canvas measurement of
    // `800 120px Inter` came back byte-identical to a garbage family name.
    // Inside @layer base they survive. This asserts the placement, because the
    // text-level check above passes either way — which is exactly why the
    // original bug shipped.
    const css = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
    const layerBaseAt = css.indexOf("@layer base");
    expect(layerBaseAt, "app/globals.css no longer has an @layer base block").toBeGreaterThan(-1);
    for (const face of BUNDLED_FONTS) {
      const ruleAt = css.indexOf(bundledFontUrl(face.file));
      expect(
        ruleAt,
        `@font-face for ${face.file} sits above @layer base — Tailwind will drop it`,
      ).toBeGreaterThan(layerBaseAt);
    }
  });
});

describe("bundled fonts — the browser must actually fetch them", () => {
  it("the loader covers every declared face", async () => {
    // An @font-face is lazy: the browser fetches only when rendered DOM needs
    // the face, and a canvas is not DOM. Measured live — after a fresh load,
    // Inter 600/700 and JetBrains Mono 700 reported status "unloaded" and a
    // canvas measured them as the fallback; after an explicit
    // document.fonts.load() they measured correctly.
    const requested: string[] = [];
    const fakeDoc = {
      fonts: {
        load: (shorthand: string) => {
          requested.push(shorthand);
          return Promise.resolve([]);
        },
      },
    };
    const original = globalThis.document;
    // @ts-expect-error — standing in for the browser document in a node test.
    globalThis.document = fakeDoc;
    try {
      const { ensureBundledFontsLoaded, resetBundledFontLoadingForTests } = await import(
        "@/lib/fonts/load-client"
      );
      resetBundledFontLoadingForTests();
      await ensureBundledFontsLoaded();
      for (const face of BUNDLED_FONTS) {
        expect(
          requested.some((r) => r.includes(`"${face.family}"`) && r.startsWith(`${face.weight} `)),
          `nothing loaded ${face.family} ${face.weight} — that weight will draw as a fallback`,
        ).toBe(true);
      }
      // Families with a space must be quoted or document.fonts.load throws.
      for (const r of requested) expect(r).toMatch(/"[^"]+"$/);
      resetBundledFontLoadingForTests();
    } finally {
      globalThis.document = original;
    }
  });
});

describe("bundled fonts — sandbox safety", () => {
  it("register-server.ts does not statically import the logger", () => {
    // `lib/storyboard/render/canvas.ts` registers fonts inside a Node
    // permission-model sandbox. `lib/logger.ts` runs `ensureLibiDirs()` (an
    // mkdirSync) at MODULE SCOPE, so a static import here throws
    // ERR_ACCESS_DENIED while the module graph loads and kills the render
    // subprocess — which is exactly what happened, caught by
    // __tests__/integration/storyboard/render-isolation.test.ts. The logger is
    // required lazily on the missing-file branch instead. This asserts the
    // constraint by name so a future "tidy up the dynamic require" does not
    // quietly reintroduce it.
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib", "fonts", "register-server.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/^\s*import\s+.*from\s+["']@\/lib\/logger["']/m);
  });
});

describe("bundled fonts — @napi-rs/canvas registration", () => {
  beforeAll(() => {
    ensureBundledFontsRegistered();
  });

  it("registers every bundled family", () => {
    for (const family of BUNDLED_FONT_FAMILIES) {
      expect(GlobalFonts.has(family), family).toBe(true);
    }
  });

  it("SENTINEL: a bundled family no longer measures like a missing one", () => {
    // THIS is the assertion that fails without bundling. Before registration
    // `Inter` and a garbage family both resolve to the same fallback face and
    // measure identically, which is why the original bug was invisible.
    const sentinelWidth = widthOf(`800 120px ${SENTINEL}`);
    for (const family of BUNDLED_FONT_FAMILIES) {
      expect(
        widthOf(`800 120px "${family}"`),
        `${family} measures like a missing font — it is NOT actually registered`,
      ).not.toBe(sentinelWidth);
    }
  });

  it("applies each declared weight rather than collapsing to one face", () => {
    // Probed by ink, not width — monospace advance is fixed across weights.
    for (const family of BUNDLED_FONT_FAMILIES) {
      const weights = BUNDLED_FONTS.filter((f) => f.family === family)
        .map((f) => f.weight)
        .sort((a, b) => a - b);
      const lightest = inkOf(`${weights[0]} 64px "${family}"`);
      const heaviest = inkOf(`${weights[weights.length - 1]} 64px "${family}"`);
      expect(lightest).toBeGreaterThan(0);
      expect(
        heaviest,
        `${family} ${weights[weights.length - 1]} lays down no more ink than ${weights[0]} — the weight is being ignored`,
      ).toBeGreaterThan(lightest * 1.05);
    }
  });

  it("is idempotent", () => {
    expect(() => {
      ensureBundledFontsRegistered();
      ensureBundledFontsRegistered();
    }).not.toThrow();
    expect(GlobalFonts.has(DEFAULT_TEXT_FAMILY)).toBe(true);
  });
});
