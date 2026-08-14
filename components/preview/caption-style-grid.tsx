"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { CAPTION_STYLES, captionStyleToFields } from "@/lib/captions/styles";
import { renderStyleThumbnail } from "@/lib/captions/style-thumbnail";
import type { CaptionStyle } from "@/lib/captions/types";
import type { TextOverlay } from "@/lib/engine/types";

/** Devicepixel-aware backing-store size for each tile canvas. */
const TILE_CSS_W = 72;
const TILE_CSS_H = 40;

/**
 * CaptionStyleGrid — a responsive grid of STATIC caption-style thumbnails, the
 * single look-picker for a caption.
 *
 * Each tile is a `<canvas>` painted ONCE with one `CaptionStyle`'s static look
 * via `renderStyleThumbnail(style, ctx, size)` — no animation (a style is a look,
 * not an effect; reveals live in Effects → Reveal). Clicking a tile applies that
 * style to the selected caption overlay; the tile whose look matches the
 * overlay's current fields gets a primary ring.
 *
 * Apply path: the inspector commits styles the SAME way it commits every other
 * field — through `onApplyStyle`, which the caption inspector wires to
 * `patch(styleToFields(styleId))`. Applying a style writes only static look
 * fields and never touches `reveal` / `effects`.
 *
 * jsdom-safe: `getContext("2d")` returns null under jsdom — the paint effect
 * guards every draw on a non-null ctx, so the component renders tiles + handles
 * clicks without ever throwing in tests.
 */
export function CaptionStyleGrid({
  overlay,
  onApplyStyle,
  styles = CAPTION_STYLES,
}: {
  overlay: TextOverlay;
  /** Apply the picked style to the overlay (inspector wires this to its patch). */
  onApplyStyle: (styleId: string) => void;
  /** Full style list to show — bundled curated looks PLUS any user-created
   *  styles. Defaults to the bundled `CAPTION_STYLES` const (so the grid renders
   *  standalone in tests); the inspector passes the merged list from the API. */
  styles?: CaptionStyle[];
}) {
  const activeId = useMemo(() => matchActiveStyle(overlay, styles), [overlay, styles]);

  // Search filter over label + id (case-insensitive). Empty query ⇒ all styles.
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return styles;
    return styles.filter(
      (s) => s.label.toLowerCase().includes(q) || s.id.includes(q),
    );
  }, [styles, query]);

  // Split into bundled (curated) and user (created/imported) groups so the list
  // can show a separator between them. `ordered` is the flat paint order
  // (bundled first, then user) — the canvas refs index against THIS list.
  const bundledShown = useMemo(() => shown.filter((s) => s.source !== "user"), [shown]);
  const userShown = useMemo(() => shown.filter((s) => s.source === "user"), [shown]);
  const ordered = useMemo(
    () => [...bundledShown, ...userShown],
    [bundledShown, userShown],
  );

  // One ref array holding every visible tile canvas; a single effect paints each
  // once. Re-runs when the filtered set changes (indices map to `ordered`).
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    for (let i = 0; i < ordered.length; i++) {
      const canvas = canvasRefs.current[i];
      if (!canvas) continue;
      const ctx = canvas.getContext("2d");
      // jsdom returns null — skip drawing (component still renders + clicks).
      if (!ctx) continue;
      const w = canvas.width;
      const h = canvas.height;
      const dpr = w / TILE_CSS_W || 1;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Neutral dark tile so light caption text is legible.
      ctx.fillStyle = "#16181d";
      ctx.fillRect(0, 0, w, h);
      ctx.scale(dpr, dpr);
      renderStyleThumbnail(ordered[i], ctx, { width: TILE_CSS_W, height: TILE_CSS_H });
      ctx.restore();
    }
  }, [ordered]);

  // One style tile. `paintIndex` is its position in `ordered`, so the paint
  // effect's canvas ref lines up regardless of which group the tile is in.
  const renderTile = (style: CaptionStyle, paintIndex: number) => {
    const active = style.id === activeId;
    return (
      <button
        key={style.id}
        type="button"
        data-style={style.id}
        data-active={active ? "true" : undefined}
        aria-pressed={active}
        aria-label={style.label}
        title={style.label}
        onClick={() => onApplyStyle(style.id)}
        className={`flex cursor-pointer flex-col items-center gap-1 rounded border p-1 transition-colors ${
          active
            ? "border-primary ring-2 ring-primary"
            : "border-border hover:border-foreground/40"
        }`}
      >
        <canvas
          ref={(el) => {
            canvasRefs.current[paintIndex] = el;
            if (el) {
              const dpr =
                typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
              // Set the backing store once per mount (avoids resize flicker).
              if (el.width !== Math.round(TILE_CSS_W * dpr)) {
                el.width = Math.round(TILE_CSS_W * dpr);
                el.height = Math.round(TILE_CSS_H * dpr);
              }
            }
          }}
          // Responsive: fill the tile's content box but never exceed the
          // intrinsic 72px, so the painted plate can't bleed past the tile
          // border on a narrow (minmax 64px → ~54px content) column. The
          // aspect ratio keeps the height proportional as the width flexes.
          style={{ aspectRatio: `${TILE_CSS_W} / ${TILE_CSS_H}` }}
          className="w-full max-w-[72px] rounded"
        />
        <span className="max-w-full truncate text-[10px] leading-none text-muted-foreground">
          {style.label}
        </span>
      </button>
    );
  };

  const gridCols = { gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))" };

  return (
    <div className="flex flex-col gap-2">
      {/* Search — filters the (now large) style catalog by name. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input
          data-testid="caption-style-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search styles…"
          aria-label="Search caption styles"
          className="w-full rounded border border-border bg-background py-1 pl-7 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Scrollable catalog — ~4 rows tall, scrolls past that. The `p-1.5`
          padding keeps the selected tile's primary RING off the scroll-clip
          edges (top/bottom rows + edge columns) — without it `overflow` shears
          the 2px ring. */}
      <div className="max-h-72 overflow-y-auto overflow-x-hidden p-1.5">
        {bundledShown.length > 0 && (
          <div data-testid="caption-style-grid" className="grid gap-2" style={gridCols}>
            {bundledShown.map((style, i) => renderTile(style, i))}
          </div>
        )}

        {userShown.length > 0 && (
          <>
            {/* Separator — everything below is the user's own styles (created or
                imported), kept visually distinct from the bundled curated set. */}
            <div
              data-testid="caption-style-custom-separator"
              className="my-2.5 flex items-center gap-2 px-0.5"
            >
              <span className="h-px flex-1 bg-border" />
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                Your styles
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div
              data-testid="caption-style-grid-custom"
              className="grid gap-2"
              style={gridCols}
            >
              {userShown.map((style, j) => renderTile(style, bundledShown.length + j))}
            </div>
          </>
        )}

        {shown.length === 0 && (
          <div className="px-1 py-3 text-center text-[11px] text-muted-foreground">
            No styles match “{query}”.
          </div>
        )}
      </div>

      {/* Footer hint — the agent can mint new styles on request (create_caption_style). */}
      <p className="px-0.5 text-[10px] leading-tight text-muted-foreground">
        Need a specific look? Ask the agent to create a new style for you — it’ll
        show up here.
      </p>
    </div>
  );
}

/** Deterministic, order-insensitive stringify for deep-equality comparison. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * The id of the style whose pinned (non-null) look fields all deep-equal the
 * overlay's current values, preferring the MOST SPECIFIC match (most pinned
 * fields). Mirrors `matchPreset` semantics so a sparse style ("clean", color
 * only) can't shadow a richer one. Returns null when nothing matches.
 */
function matchActiveStyle(
  overlay: TextOverlay,
  styles: CaptionStyle[],
): string | null {
  const ov = overlay as unknown as Record<string, unknown>;
  let bestId: string | null = null;
  let bestSpecificity = 0;
  for (const style of styles) {
    const fields = captionStyleToFields(style) as Record<string, unknown>;
    // Only the keys this style actually pins (non-null) count toward a match.
    const pinned = Object.entries(fields).filter(([, v]) => v != null);
    if (pinned.length === 0) continue;
    let ok = true;
    for (const [k, want] of pinned) {
      if (stableStringify(ov[k]) !== stableStringify(want)) {
        ok = false;
        break;
      }
    }
    if (ok && pinned.length > bestSpecificity) {
      bestId = style.id;
      bestSpecificity = pinned.length;
    }
  }
  return bestId;
}
