// components/preview/reveal-thumbnail.tsx
"use client";

import { useEffect, useState } from "react";
import {
  REVEAL_SAMPLE_WORDS,
  revealWordStates,
  revealTypewriterCount,
} from "@/lib/captions/reveal-preview";
import { thumbnailProgress } from "@/lib/effects/thumbnail";

/**
 * A small animated illustration of a reveal mode, mirroring the Animations tab's
 * EffectThumbnail: at rest it shows the sample text fully revealed; while `active`
 * (card hover/focus or selected) it runs a rAF loop animating the reveal idea on
 * the sample words. The real reveal renders frame-exact on the canvas.
 *
 * `compact` renders a smaller fixed-size chip (for the inspector applied-effect
 * rows). Default rendering is byte-identical to the picker's original inline copy.
 */
export function RevealThumbnail({
  mode,
  highlightColor,
  active,
  compact,
}: {
  mode: string;
  highlightColor?: string;
  active: boolean;
  compact?: boolean;
}) {
  const [p, setP] = useState(1); // resting = fully revealed
  // Snap back to fully revealed on the render where the animation stops
  // (previous-state pattern) — the effect below only ever runs the rAF loop.
  const [prevAnim, setPrevAnim] = useState({ active, mode });
  if (active !== prevAnim.active || mode !== prevAnim.mode) {
    setPrevAnim({ active, mode });
    if (!active || mode === "none") setP(1);
  }
  useEffect(() => {
    if (!active || mode === "none") return;
    let raf = 0;
    let start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      setP(thumbnailProgress(now - start));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, mode]);

  const words = REVEAL_SAMPLE_WORDS;
  const full = words.join(" ");
  let content: React.ReactNode;
  if (mode === "typewriter") {
    const k = revealTypewriterCount(p, full.length);
    content = (
      <span className="font-semibold text-white">
        {full.slice(0, k)}
        {p < 1 && <span className="opacity-60">|</span>}
      </span>
    );
  } else {
    const states = revealWordStates(mode, p, words.length);
    content = (
      <span
        className={
          compact
            ? "flex flex-nowrap items-baseline justify-center gap-x-1 font-semibold"
            : "flex flex-wrap items-baseline justify-center gap-x-1 font-semibold"
        }
      >
        {words.map((w, i) =>
          states[i].visible ? (
            <span
              key={i}
              style={{
                opacity: states[i].opacity,
                transform: `translateY(${states[i].translateYPx}px)`,
                color: states[i].highlighted ? (highlightColor ?? "#ffd700") : "#fff",
              }}
            >
              {w}
            </span>
          ) : null,
        )}
      </span>
    );
  }
  return (
    <div
      data-testid="reveal-thumbnail"
      className={
        compact
          ? "flex h-6 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-black/30 px-1 text-[7px] leading-none whitespace-nowrap"
          : "flex h-10 items-center justify-center overflow-hidden rounded bg-black/30 px-1 text-[11px] leading-tight"
      }
    >
      {content}
    </div>
  );
}
