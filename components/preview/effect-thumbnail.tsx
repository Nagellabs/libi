// components/preview/effect-thumbnail.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { EffectDef, EffectPhase, LayerKind } from "@/lib/effects/types";
import {
  resolveThumbnailParams,
  deltaToThumbnailStyle,
  thumbnailProgress,
} from "@/lib/effects/thumbnail";

interface EffectThumbnailProps {
  effect: EffectDef;
  /** The slot this tile would apply to — picks the sample element + drives semantics. */
  phase: EffectPhase;
  /** Selected layer kind — chooses the sample glyph (text "Aa" / audio bars / visual chip). */
  sampleKind: LayerKind;
  /** True for custom (user-package) effects — renders a small "custom" chip. */
  isCustom?: boolean;
  selected: boolean;
  highlighted: boolean;
  disabled: boolean;
  onClick: () => void;
}

/**
 * A live picker thumbnail. On hover it runs a rAF loop calling the effect's real
 * animate(progress) and applies the resulting TransformDelta to a sample element
 * via CSS. Text-internal and audio-envelope effects (animate→{}) get a
 * representative opacity reveal so the tile still moves.
 */
export function EffectThumbnail({
  effect,
  phase,
  sampleKind,
  isCustom = false,
  selected,
  highlighted,
  disabled,
  onClick,
}: EffectThumbnailProps) {
  const sampleRef = useRef<HTMLDivElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const { meta } = effect;
  const params = useRef(resolveThumbnailParams(meta));

  useEffect(() => {
    if (!hovering) {
      // reset to resting transform
      const el = sampleRef.current;
      if (el) {
        el.style.transform = "none";
        el.style.opacity = "1";
        el.style.filter = "none";
        el.style.clipPath = "none";
      }
      return;
    }
    let raf = 0;
    let start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      const p = thumbnailProgress(now - start);
      const el = sampleRef.current;
      if (el) {
        if (meta.textInternal || meta.audioEnvelope) {
          // representative reveal — the real glyph/gain path renders in preview.
          el.style.transform = "none";
          el.style.opacity = String(0.25 + 0.75 * p);
          el.style.filter = "none";
          el.style.clipPath = "none";
        } else {
          const s = deltaToThumbnailStyle(effect.animate(p, params.current));
          el.style.transform = s.transform;
          el.style.opacity = String(s.opacity);
          el.style.filter = s.filter;
          el.style.clipPath = s.clipPath;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hovering, effect, meta]);

  const sample = sampleContent(sampleKind);
  const ring = highlighted
    ? "ring-2 ring-inset ring-amber-400"
    : selected
      ? "ring-2 ring-inset ring-primary"
      : "ring-1 ring-inset ring-border";

  return (
    <button
      type="button"
      data-testid="effect-thumbnail"
      data-effect-id={meta.id}
      data-highlight={highlighted ? "true" : undefined}
      disabled={disabled}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
      onClick={onClick}
      className={`group flex cursor-pointer flex-col items-stretch gap-1 rounded-md bg-surface p-1.5 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 ${ring}`}
      title={meta.name}
    >
      <div className="relative flex h-12 items-center justify-center overflow-hidden rounded bg-black/30">
        {isCustom && (
          <span
            data-testid="effect-custom-badge"
            className="absolute right-0.5 top-0.5 rounded bg-primary/80 px-1 text-[9px] leading-tight text-primary-foreground"
          >
            custom
          </span>
        )}
        <div ref={sampleRef} style={sample.style} className={sample.className}>
          {sample.node}
        </div>
      </div>
      <span className="truncate text-center text-[10px] leading-tight text-muted-foreground group-hover:text-foreground">
        {meta.name}
      </span>
    </button>
  );
}

function sampleContent(kind: LayerKind): {
  node: React.ReactNode;
  className: string;
  style: CSSProperties;
} {
  if (kind === "text") {
    return { node: "Aa", className: "text-sm font-semibold text-white", style: {} };
  }
  if (kind === "audio") {
    return {
      node: (
        <div className="flex h-4 items-end gap-0.5">
          {[3, 7, 5, 9, 4, 8, 6].map((h, i) => (
            <span key={i} className="w-0.5 rounded-sm bg-emerald-400" style={{ height: `${h * 1.5}px` }} />
          ))}
        </div>
      ),
      className: "",
      style: {},
    };
  }
  // visual chip
  return {
    node: null,
    className: "size-6 rounded bg-gradient-to-br from-sky-400 to-indigo-500",
    style: {},
  };
}
