"use client";

import type { Composition } from "@/lib/engine/types";
import type { SnapTarget } from "@/lib/captions/snapping";

/** One caught snap line during an active body drag. `value` is in composition px. */
export interface ActiveGuide {
  axis: "x" | "y";
  value: number;
  kind: SnapTarget["kind"];
}

interface SnapGuidesProps {
  guides: ActiveGuide[];
  composition: Composition;
  canvasDisplayWidth: number;
  canvasDisplayHeight: number;
}

/** Per-kind line color. Center/thirds use the accent; safe margins are muted;
 *  sibling-overlay snaps use a distinct cyan so the user can tell them apart. */
function colorForKind(kind: SnapTarget["kind"]): string {
  switch (kind) {
    case "center":
      return "rgb(244 114 182)"; // pink-400
    case "third":
      return "rgb(251 191 36)"; // amber-400
    case "safe":
      return "rgb(148 163 184)"; // slate-400
    case "overlay":
      return "rgb(34 211 238)"; // cyan-400
  }
}

/**
 * A thin guide-line overlay that flashes the caught snap target line during an
 * active body drag. Vertical line at a snapped X, horizontal at a snapped Y.
 * Purely presentational + pointer-transparent; driven by the `hit` returned from
 * `snapPosition1D` in OverlayHandles.
 */
export function SnapGuides({
  guides,
  composition,
  canvasDisplayWidth,
  canvasDisplayHeight,
}: SnapGuidesProps) {
  if (guides.length === 0 || canvasDisplayWidth <= 0 || canvasDisplayHeight <= 0) {
    return null;
  }
  const scaleX = composition.width > 0 ? canvasDisplayWidth / composition.width : 1;
  const scaleY = composition.height > 0 ? canvasDisplayHeight / composition.height : 1;

  return (
    <div
      data-testid="snap-guides"
      aria-hidden
      className="pointer-events-none absolute left-0 top-0"
      style={{ width: canvasDisplayWidth, height: canvasDisplayHeight, zIndex: 13 }}
    >
      {guides.map((g, i) => {
        const color = colorForKind(g.kind);
        if (g.axis === "x") {
          return (
            <div
              key={`x-${i}`}
              data-testid="snap-guide-x"
              className="absolute top-0 transition-opacity"
              style={{
                left: g.value * scaleX,
                width: 1,
                height: "100%",
                background: color,
                opacity: 0.85,
                boxShadow: `0 0 4px ${color}`,
              }}
            />
          );
        }
        return (
          <div
            key={`y-${i}`}
            data-testid="snap-guide-y"
            className="absolute left-0 transition-opacity"
            style={{
              top: g.value * scaleY,
              height: 1,
              width: "100%",
              background: color,
              opacity: 0.85,
              boxShadow: `0 0 4px ${color}`,
            }}
          />
        );
      })}
    </div>
  );
}
