"use client";

import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import {
  applyWheelZoom,
  sliderPosFromZoom,
  zoomFromSliderPos,
  zoomMultiplierLabel,
} from "@/lib/preview/timeline-zoom";

export interface TimelineZoomControlsProps {
  /** Current zoom in content px per second. */
  pxPerSec: number;
  /** The zoom at which the composition exactly fills the viewport (the floor). */
  fitPx: number;
  /** The zoom ceiling (px/sec) — frame-derived, so it depends on the
   *  composition's fps. Passed explicitly rather than defaulted: a hidden
   *  default here is exactly how the wrong ceiling gets applied silently. */
  maxPx: number;
  /** Set an absolute zoom (already clamped by the caller's model). */
  onZoom: (pxPerSec: number) => void;
  /** Return to Fit. */
  onFit: () => void;
}

const BUTTON_CLASS =
  "flex size-5 cursor-pointer items-center justify-center rounded border border-border bg-background text-muted-foreground hover:text-foreground";

/**
 * The timeline's zoom cluster: out / slider / % readout / in / fit. Purely
 * presentational — it owns no zoom state, so the timeline stays the single
 * source of truth and this can be tested without mounting the timeline.
 */
export default function TimelineZoomControls({
  pxPerSec,
  fitPx,
  maxPx,
  onZoom,
  onFit,
}: TimelineZoomControlsProps) {
  const sliderPos = sliderPosFromZoom(pxPerSec, fitPx, maxPx);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-testid="zoom-out"
        onClick={() => onZoom(applyWheelZoom({ pxPerSec, factor: 1 / 1.2, maxPx }))}
        title="Zoom out"
        className={BUTTON_CLASS}
      >
        <ZoomOut className="size-3" />
      </button>
      <input
        type="range"
        data-testid="zoom-slider"
        min={0}
        max={1}
        step={0.001}
        value={sliderPos}
        onChange={(e) => onZoom(zoomFromSliderPos(Number(e.target.value), fitPx, maxPx))}
        aria-label="Timeline zoom"
        className="h-1 w-20 cursor-pointer accent-primary"
      />
      <span
        data-testid="zoom-readout"
        className="min-w-[2.25rem] text-center font-mono text-[10px] text-muted-foreground tabular-nums"
      >
        {zoomMultiplierLabel(pxPerSec, fitPx)}
      </span>
      <button
        type="button"
        data-testid="zoom-in"
        onClick={() => onZoom(applyWheelZoom({ pxPerSec, factor: 1.2, maxPx }))}
        title="Zoom in"
        className={BUTTON_CLASS}
      >
        <ZoomIn className="size-3" />
      </button>
      <button
        type="button"
        data-testid="zoom-fit"
        onClick={onFit}
        title="Fit to viewport (Shift+Z)"
        className={BUTTON_CLASS}
      >
        <Maximize2 className="size-3" />
      </button>
    </div>
  );
}
