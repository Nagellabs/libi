/** Curated caption STYLE library — STATIC LOOKS ONLY.
 *
 *  A small set of good-by-default *looks* (color + stroke/shadow/background +
 *  weight) the UI/agent applies to a caption track or text overlay. A style is
 *  PURELY the static appearance — it carries NO reveal / animation. Motion is a
 *  separate concern owned by the Effects panel (Effects → Reveal / Animations),
 *  so applying a style NEVER touches the overlay's `reveal` / `effects`.
 *
 *  Pure data + thin helpers — canvas-free, DOM-free. */
import type { TextOverlay } from "@/lib/engine/types";
import type { CaptionStyle } from "@/lib/captions/types";

// NOTE: This module is CLIENT-SAFE — it must not import any server-only module
// (no `lib/overlays/preset-store` / `lib/libi-home` / `fs`). The user-preset
// merge that reads from disk lives in `styles.server.ts` (server-only).

/** Curated static caption looks. Each is a self-contained `CaptionStyle` (id,
 *  label, source, color + optional stroke/shadow/background/weight). No `reveal`
 *  — reveals live in Effects → Reveal. Reveal-only looks (Typed / Karaoke /
 *  Highlight Words / Fade In) were dropped: stripped of their animation they
 *  duplicated Outline / Clean. */
export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: "clean",
    label: "Clean",
    source: "bundled",
    color: "#ffffff",
    shadow: { color: "rgba(0,0,0,0.55)", blur: 8, dx: 0, dy: 2 },
  },
  {
    id: "boxed",
    label: "Boxed",
    source: "bundled",
    color: "#ffffff",
    background: { color: "rgba(0,0,0,0.6)", padding: 12, radius: 8 },
  },
  {
    id: "outline",
    label: "Outline",
    source: "bundled",
    color: "#ffffff",
    stroke: { color: "#000000", width: 6 },
  },
  {
    id: "pop",
    label: "Pop",
    source: "bundled",
    color: "#ffd400",
    stroke: { color: "#000000", width: 6 },
  },
  {
    id: "beast",
    label: "Beast",
    source: "bundled",
    color: "#ffffff",
    fontWeight: 900,
    stroke: { color: "#000000", width: 12 },
  },
  {
    id: "minimal",
    label: "Minimal",
    source: "bundled",
    color: "#ffffff",
    fontWeight: 500,
    shadow: { color: "rgba(0,0,0,0.4)", blur: 4, dx: 0, dy: 1 },
  },
  {
    id: "lower-third",
    label: "Lower Third",
    source: "bundled",
    color: "#ffffff",
    background: { color: "rgba(10,12,20,0.78)", padding: 14, radius: 6 },
  },

  // ── Viral / CapCut-inspired looks ──────────────────────────────────────
  // Popular short-form caption styles (Hormozi/MrBeast word-pop, neon glow,
  // highlighter/marker plates, news/retro, terminal). Static looks only.
  { id: "hormozi-yellow", label: "Hormozi Gold", source: "bundled", color: "#ffd400", fontFamily: "Montserrat", fontWeight: 900, stroke: { color: "#000000", width: 12 }, shadow: { color: "rgba(0,0,0,0.6)", blur: 6, dx: 0, dy: 3 } },
  { id: "hormozi-green", label: "Hormozi Green", source: "bundled", color: "#39ff14", fontFamily: "Montserrat", fontWeight: 900, stroke: { color: "#000000", width: 12 }, shadow: { color: "rgba(0,0,0,0.6)", blur: 6, dx: 0, dy: 3 } },
  { id: "beasty-blue", label: "Beasty", source: "bundled", color: "#2f80ff", fontFamily: "Impact", fontWeight: 900, stroke: { color: "#000000", width: 11 }, shadow: { color: "rgba(0,0,0,0.5)", blur: 5, dx: 0, dy: 4 } },
  { id: "tiktok-classic", label: "TikTok", source: "bundled", color: "#ffffff", fontFamily: "Helvetica", fontWeight: 700, shadow: { color: "rgba(0,0,0,0.45)", blur: 8, dx: 0, dy: 2 } },
  { id: "neon-cyan-glow", label: "Cyan Glow", source: "bundled", color: "#00f0ff", fontFamily: "Montserrat", fontWeight: 700, shadow: { color: "rgba(0,240,255,0.9)", blur: 22, dx: 0, dy: 0 } },
  { id: "neon-pink-glow", label: "Pink Glow", source: "bundled", color: "#ff3ea5", fontFamily: "Montserrat", fontWeight: 700, shadow: { color: "rgba(255,62,165,0.9)", blur: 22, dx: 0, dy: 0 } },
  { id: "news-serif", label: "Newsroom", source: "bundled", color: "#ffffff", fontFamily: "Georgia", fontWeight: 600, background: { color: "rgba(12,18,32,0.92)", padding: 14, radius: 4 } },
  { id: "mono-terminal", label: "Terminal", source: "bundled", color: "#39ff14", fontFamily: "Courier New", fontWeight: 600, background: { color: "rgba(8,10,8,0.9)", padding: 12, radius: 4 } },
  { id: "highlighter-yellow", label: "Marker Gold", source: "bundled", color: "#0a0a0a", fontFamily: "Montserrat", fontWeight: 700, background: { color: "#ffd400", padding: 12, radius: 6 } },
  { id: "highlighter-green", label: "Marker Green", source: "bundled", color: "#0a0a0a", fontFamily: "Montserrat", fontWeight: 700, background: { color: "#00e676", padding: 12, radius: 6 } },
  { id: "bubble-white", label: "Bubble", source: "bundled", color: "#ffffff", fontFamily: "Montserrat", fontWeight: 900, stroke: { color: "#ffffff", width: 10 }, shadow: { color: "rgba(0,0,0,0.55)", blur: 10, dx: 0, dy: 3 } },
  { id: "shadow-pop-orange", label: "Shadow Pop", source: "bundled", color: "#ff8a00", fontFamily: "Impact", fontWeight: 900, shadow: { color: "rgba(0,0,0,0.85)", blur: 4, dx: 4, dy: 4 } },
  { id: "red-alert", label: "Red Alert", source: "bundled", color: "#ff2d2d", fontFamily: "Impact", fontWeight: 900, stroke: { color: "#000000", width: 9 }, shadow: { color: "rgba(0,0,0,0.5)", blur: 5, dx: 0, dy: 3 } },
  { id: "cinematic-thin", label: "Cinematic", source: "bundled", color: "rgba(255,255,255,0.92)", fontFamily: "Helvetica", fontWeight: 400, shadow: { color: "rgba(0,0,0,0.4)", blur: 6, dx: 0, dy: 1 } },
  { id: "gradient-look-gold", label: "Lux Gold", source: "bundled", color: "#f5c16c", fontFamily: "Georgia", fontWeight: 700, shadow: { color: "rgba(245,193,108,0.7)", blur: 18, dx: 0, dy: 0 } },
  { id: "cartoon-comic", label: "Comic", source: "bundled", color: "#ffffff", fontFamily: "Impact", fontWeight: 900, stroke: { color: "#000000", width: 13 }, shadow: { color: "rgba(0,0,0,0.45)", blur: 4, dx: 0, dy: 4 } },
  { id: "retro-cream", label: "Retro", source: "bundled", color: "#f3e6c4", fontFamily: "Times New Roman", fontWeight: 700, background: { color: "rgba(74,18,24,0.95)", padding: 14, radius: 8 } },
  { id: "karaoke-bar", label: "Karaoke", source: "bundled", color: "#ffffff", fontFamily: "Montserrat", fontWeight: 700, background: { color: "#7b2ff7", padding: 12, radius: 10 } },
  { id: "pop-cyan-stroke", label: "Cyan Pop", source: "bundled", color: "#00e5ff", fontFamily: "Oswald", fontWeight: 700, stroke: { color: "#000000", width: 8 }, shadow: { color: "rgba(0,0,0,0.5)", blur: 5, dx: 0, dy: 3 } },
  { id: "magenta-marker", label: "Magenta", source: "bundled", color: "#ffffff", fontFamily: "Montserrat", fontWeight: 700, background: { color: "#e6007a", padding: 12, radius: 6 } },
];

/** The static look fields a style sets on a text overlay (the keys
 *  `styleToFields` spreads + null-clears). Deliberately EXCLUDES `reveal` and
 *  `highlightColor` — those are reveal/animation concerns owned by Effects. */
const STYLE_FIELD_KEYS = [
  "color",
  "stroke",
  "shadow",
  "background",
  "fontFamily",
  "fontWeight",
] as const;

/** The nullable look keys a style may omit. Applying a style emits `null` for
 *  each omitted one so a style switch clears the prior look (idempotent — no
 *  stale background/stroke/shadow). Note: `reveal` is intentionally NOT here, so
 *  picking a style PRESERVES the user's chosen reveal effect. */
export const STYLE_NULLABLE_KEYS = ["background", "stroke", "shadow"] as const;

/** The static look fields to spread onto a text overlay for a style id. Every
 *  nullable look key the style omits is emitted as `null` (idempotent style
 *  switch). `reveal` / `effects` are never written or cleared — a style is look
 *  only. Unknown id → `{}` (caller falls back to the "clean" default). */
export function styleToFields(styleId: string): Partial<TextOverlay> {
  const style = CAPTION_STYLES.find((s) => s.id === styleId);
  if (!style) return {};
  return captionStyleToFields(style);
}

/** Object form of `styleToFields` — produces the apply patch from a `CaptionStyle`
 *  directly (not by bundled-id lookup), so USER styles (which aren't in
 *  `CAPTION_STYLES`) apply too. Same contract: spread the static look keys, emit
 *  `null` for every omitted nullable look key, never touch reveal/effects. */
export function captionStyleToFields(style: CaptionStyle): Partial<TextOverlay> {
  const src = style as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of STYLE_FIELD_KEYS) {
    const v = src[key];
    if (v != null) out[key] = v;
  }
  for (const key of STYLE_NULLABLE_KEYS) {
    if (out[key] == null) out[key] = null;
  }
  return out as Partial<TextOverlay>;
}

// `listCaptionStyles` (bundled + user-preset merge, reads from disk) lives in
// `lib/captions/styles.server.ts` so this module stays client-safe.
