"use client";

import type React from "react";

const SPROCKET_COUNT = 18;

function Sprockets({ position }: { position: "top" | "bottom" }): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-[3px] flex items-center justify-between ${
        position === "top" ? "top-[2px]" : "bottom-[2px]"
      }`}
    >
      {Array.from({ length: SPROCKET_COUNT }).map((_, i) => (
        <span key={i} className="h-1 w-2 rounded-[2px] bg-background/70" />
      ))}
    </div>
  );
}

export function ExportProgressBar({
  percent,
  etaLabel,
  unit = "%",
}: {
  percent: number | null;
  etaLabel?: string | null;
  unit?: string;
}): React.JSX.Element {
  const indeterminate = percent == null || percent <= 0;
  const clamped = indeterminate ? 0 : Math.min(100, Math.max(0, percent));
  const rounded = Math.round(clamped);

  return (
    <div className="relative h-7 w-full overflow-hidden rounded-md bg-muted/40 ring-1 ring-foreground/10">
      <style>{`
        @keyframes libi-export-sheen {
          from { transform: translateX(-150%) skewX(-12deg); }
          to   { transform: translateX(250%) skewX(-12deg); }
        }
        @keyframes libi-export-shimmer {
          0%   { transform: translateX(-60%); }
          100% { transform: translateX(160%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .libi-export-anim { animation: none !important; }
        }
      `}</style>

      {/* Film sprocket holes */}
      <Sprockets position="top" />
      <Sprockets position="bottom" />

      {!indeterminate && (
        <>
          {/* Determinate fill — the only thing that advances; width animates
              smoothly so the bar simply grows toward each new percent (no
              leading marker jumping ahead of the fill). */}
          <div
            className="absolute inset-y-0 left-0 overflow-hidden rounded-l-md bg-gradient-to-r from-primary/80 to-primary transition-[width] duration-300 ease-out"
            style={{ width: `${clamped}%` }}
          >
            {/* Animated diagonal sheen (lives inside the fill, clipped to it —
                a passive shimmer, not a leading edge). */}
            <div
              className="libi-export-anim absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
              style={{ animation: "libi-export-sheen 1.4s linear infinite" }}
            />
          </div>
        </>
      )}

      {indeterminate && (
        /* Sliding shimmer band across the whole track */
        <div className="absolute inset-0 overflow-hidden">
          <div
            className="libi-export-anim absolute inset-y-0 w-2/5 bg-gradient-to-r from-transparent via-primary/50 to-transparent"
            style={{ animation: "libi-export-shimmer 1.2s ease-in-out infinite" }}
          />
        </div>
      )}

      {/* Readout */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-end gap-2 px-2.5">
        <span className="tabular-nums text-[11px] font-medium text-foreground mix-blend-plus-lighter [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]">
          {indeterminate ? "…" : `${rounded}${unit}`}
        </span>
        {!indeterminate && etaLabel ? (
          <span className="tabular-nums text-[11px] text-muted-foreground [text-shadow:0_1px_2px_rgba(0,0,0,0.45)]">
            {etaLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
