/**
 * SERVER-ONLY font measure for the ffmpeg export's caption layout
 * (lib/export/text-export-layout.ts).
 *
 * The preview breaks a caption's lines with `ctx.measureText` in the face it
 * draws with; drawtext has no layout of its own, so the export has to break
 * the lines itself — with the SAME face, or a word that fits in the preview
 * lands on the next line in the export. The export already knows which file
 * drawtext loads for each overlay (the bundled face for its family + weight,
 * or the uploaded font), so this measures with exactly that file, registered
 * with `@napi-rs/canvas` under a private alias. A text with no file (a family
 * libi doesn't ship) is measured by family name, as the browser would.
 *
 * That last case is approximate on BOTH sides: a non-bundled family
 * (Montserrat, Impact, Georgia… — several bundled caption STYLES name one) is
 * measured here with whatever system font Skia finds for the name, drawn by
 * drawtext with whatever fontconfig resolves `font=<family>` to, and shown in
 * the preview with whatever the browser falls back to. The three can be
 * different faces, so glyphs and line breaks can differ from the preview.
 * Only the bundled faces (Inter, JetBrains Mono) and uploaded fonts are exact.
 *
 * Ink bounds are reported relative to CHROMIUM's `textBaseline: "top"` — the
 * top of the em box, `size × ascent / (ascent + descent)` above the baseline —
 * which is what the preview's plate math is written against. @napi-rs/canvas
 * puts its own "top" elsewhere (≈ the cap height for Inter), so the metrics
 * are taken on the alphabetic baseline and converted.
 */
import path from "node:path";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { composeFont } from "@/lib/overlays/caption-style";
import { ensureBundledFontsRegistered } from "@/lib/fonts/register-server";
import { layoutFontSize, type TextLayoutInput, type TextMeasurer } from "./text-export-layout";

/** font file → its registered alias, or null when registration failed. */
const aliasByPath = new Map<string, string | null>();
const ctxByFont = new Map<string, SKRSContext2D>();

/** The private family a font file is registered under, or null when Skia
 *  couldn't load it (missing, corrupt, a format it can't read). Naming an
 *  alias that was never registered measures in Skia's fallback face — the
 *  caller then measures by family instead, as the preview's browser would. */
function aliasFor(fontFile: string): string | null {
  if (aliasByPath.has(fontFile)) return aliasByPath.get(fontFile)!;
  const alias = `libi-export-${aliasByPath.size}-${path.basename(fontFile).replace(/[^A-Za-z0-9]/g, "")}`;
  let ok = false;
  try {
    ok = !!GlobalFonts.registerFromPath(fontFile, alias);
  } catch {
    ok = false;
  }
  aliasByPath.set(fontFile, ok ? alias : null);
  return ok ? alias : null;
}

function contextFor(font: string): SKRSContext2D {
  let ctx = ctxByFont.get(font);
  if (!ctx) {
    ctx = createCanvas(1, 1).getContext("2d");
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    ctxByFont.set(font, ctx);
  }
  return ctx;
}

/**
 * A measurer for one text overlay. `fontFile` is the ABSOLUTE path of the face
 * drawtext will load for it, when there is one.
 */
export function createServerTextMeasurer(o: TextLayoutInput, fontFile?: string): TextMeasurer {
  ensureBundledFontsRegistered();
  const size = layoutFontSize(o);
  // A registered file is one face, so the alias alone selects it — naming a
  // weight too could only make Skia synthesize one on top.
  const alias = fontFile ? aliasFor(fontFile) : null;
  const font = alias ? `${size}px "${alias}"` : composeFont(o);
  const ctx = contextFor(font);
  const probe = ctx.measureText("H");
  const fa = probe.fontBoundingBoxAscent;
  const fd = probe.fontBoundingBoxDescent;
  // Chromium's "top" line: the em box's top, above the baseline.
  const emTop = fa + fd > 0 ? (size * fa) / (fa + fd) : size * 0.8;
  return {
    width: (s) => ctx.measureText(s).width,
    ink: (s) => {
      const m = ctx.measureText(s);
      return { ascent: m.actualBoundingBoxAscent - emTop, descent: m.actualBoundingBoxDescent + emTop };
    },
  };
}
