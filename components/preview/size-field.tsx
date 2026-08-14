"use client";

import * as React from "react";
import { ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";

import {
  INSPECTOR_LABEL_CLASS,
  NumberSlider,
} from "@/components/preview/number-slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { aspectLockedHeight, aspectOf } from "@/lib/overlays/size-field-math";

/**
 * Reusable inspector "Size" control with progressive disclosure.
 *
 * - Text overlays (no W/H): ALWAYS one row editing `fontSize`. No split.
 * - Box overlays (image/video/code/three/tracked) with `split === false`: one
 *   "Size" row that edits WIDTH and keeps HEIGHT proportional (aspect captured
 *   from the CURRENT width/height at change time). The "Size" label is a button
 *   that splits the control into independent W/H rows.
 * - Box overlays with `split === true`: two rows — "W" and "H" — each editing
 *   its dimension independently. Each label is a button that consolidates back
 *   to a single "Size" row.
 *
 * CONTROLLED: this component does not own `split`. The parent supplies it (it
 * will come from editor-state) and receives `onToggleSplit`.
 *
 * The toggle affordance lives in a clickable LABEL rendered as the reused
 * `NumberSlider`'s `labelSlot` (so it occupies the SAME fixed label column the
 * slider's plain string label would — the row's wrap math matches every other
 * labeled inspector row instead of stealing slider width).
 *
 * When `disabled` is true (e.g. the overlay is in 3D mode and Scale on the 3D
 * tab is the active sizer) the whole field dims, every NumberSlider renders
 * read-only, the split/consolidate toggles no-op, and `disabledHint` shows as a
 * small muted sublabel.
 */
export interface SizeFieldProps {
  sizeMode: "text" | "box";
  split: boolean;
  onToggleSplit: (split: boolean) => void;
  width: number;
  height: number;
  fontSize?: number;
  widthDefault?: number;
  heightDefault?: number;
  fontSizeDefault?: number;
  onCommitWidth: (w: number) => void;
  onCommitHeight: (h: number) => void;
  /**
   * Combined size commit for the single "Size" row (box + !split). When
   * provided, the aspect-locked drag fires this ONCE with both the new width
   * and the proportional height — a single patch carrying BOTH dimensions, so
   * a top-level `rect` merge can't drop one. When omitted, falls back to the
   * legacy two-call (`onCommitWidth` then `onCommitHeight`) behaviour.
   */
  onCommitSize?: (width: number, height: number) => void;
  onCommitFontSize?: (n: number) => void;
  /**
   * Render the field disabled (dimmed, sliders read-only, toggles inert) — used
   * when 3D mode is on and Scale (on the 3D tab) is the active sizer.
   */
  disabled?: boolean;
  /** Muted sublabel shown under the field when `disabled` (e.g. "Use Scale on the 3D tab"). */
  disabledHint?: string;
  className?: string;
}

const WIDTH_MIN = 8;
const WIDTH_MAX = 4096;
const HEIGHT_MIN = 8;
const HEIGHT_MAX = 4096;
const FONT_MIN = 8;
const FONT_MAX = 400;

/**
 * A label cell rendered as a button so the user can toggle the split state by
 * clicking the dimension's name. The toggle glyph fades in on row hover. Wrapped
 * in the project Tooltip for a styled, instant hint. Mirrors
 * `INSPECTOR_LABEL_CLASS` width (`w-16`) so it lines up with sibling inspector
 * rows whose labels come from `NumberSlider`.
 *
 * When `disabled`, the button is inert (no toggle) and shows no tooltip.
 */
function ToggleLabel({
  text,
  testid,
  tooltip,
  glyph,
  onClick,
  disabled,
}: {
  text: string;
  testid: string;
  tooltip: string;
  glyph: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const button = (
    <button
      type="button"
      data-testid={testid}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        INSPECTOR_LABEL_CLASS,
        "group/size-label flex cursor-pointer items-center gap-1 text-left hover:text-foreground",
        disabled && "cursor-not-allowed hover:text-muted-foreground",
      )}
    >
      <span>{text}</span>
      <span className="opacity-0 transition-opacity group-hover/size-label:opacity-100">
        {glyph}
      </span>
    </button>
  );
  if (disabled) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function SizeField(props: SizeFieldProps) {
  const {
    sizeMode,
    split,
    onToggleSplit,
    width,
    height,
    fontSize,
    widthDefault,
    heightDefault,
    fontSizeDefault,
    onCommitWidth,
    onCommitHeight,
    onCommitSize,
    onCommitFontSize,
    disabled,
    disabledHint,
    className,
  } = props;

  // When disabled, toggles are inert (no-op) so the user can't restructure a
  // field they can't edit.
  const toggleSplit = (s: boolean) => {
    if (disabled) return;
    onToggleSplit(s);
  };

  const hint =
    disabled && disabledHint ? (
      <div className="text-[10px] text-muted-foreground">{disabledHint}</div>
    ) : null;

  // Text overlays have no W/H — always a single fontSize row, never split.
  if (sizeMode === "text") {
    return (
      <div
        data-testid="size-field"
        className={cn("flex flex-col gap-1", disabled && "opacity-50", className)}
      >
        <NumberSlider
          label="Size"
          value={fontSize ?? 0}
          min={FONT_MIN}
          max={FONT_MAX}
          step={1}
          unit="px"
          disabled={disabled}
          defaultValue={fontSizeDefault}
          onChange={(n) => onCommitFontSize?.(n)}
        />
        {hint}
      </div>
    );
  }

  return (
    <TooltipProvider delay={300}>
      {!split ? (
        renderConsolidated()
      ) : (
        renderSplit()
      )}
    </TooltipProvider>
  );

  function renderConsolidated() {
    // Single "Size" row edits width and scales height to keep aspect.
    // When `onCommitSize` is provided, emit ONE combined commit so a top-level
    // `rect` merge can't drop the width (the two-call path's bug). Otherwise
    // fall back to the legacy two separate commits.
    const handleSize = (nextWidth: number) => {
      const aspect = aspectOf(width, height);
      const nextHeight = aspectLockedHeight(nextWidth, aspect);
      if (onCommitSize) {
        onCommitSize(nextWidth, nextHeight);
        return;
      }
      onCommitWidth(nextWidth);
      onCommitHeight(nextHeight);
    };
    return (
      <div
        data-testid="size-field"
        className={cn("flex flex-col gap-1", disabled && "opacity-50", className)}
      >
        <NumberSlider
          labelSlot={
            <ToggleLabel
              text="Size"
              testid="size-split-toggle"
              tooltip="Click to split into width & height"
              glyph={<ChevronsLeftRight className="size-3" />}
              onClick={() => toggleSplit(true)}
              disabled={disabled}
            />
          }
          value={width}
          min={WIDTH_MIN}
          max={WIDTH_MAX}
          step={1}
          unit="px"
          disabled={disabled}
          defaultValue={widthDefault}
          onChange={handleSize}
        />
        {hint}
      </div>
    );
  }

  function renderSplit() {
    // Split: independent W and H rows.
    return (
      <div
        data-testid="size-field"
        className={cn("flex flex-col gap-1", disabled && "opacity-50", className)}
      >
        <NumberSlider
          labelSlot={
            <ToggleLabel
              text="W"
              testid="size-consolidate-toggle-w"
              tooltip="Click to go back to a single size"
              glyph={<ChevronsRightLeft className="size-3" />}
              onClick={() => toggleSplit(false)}
              disabled={disabled}
            />
          }
          value={width}
          min={WIDTH_MIN}
          max={WIDTH_MAX}
          step={1}
          unit="px"
          disabled={disabled}
          defaultValue={widthDefault}
          onChange={(w) => onCommitWidth(w)}
        />
        <NumberSlider
          labelSlot={
            <ToggleLabel
              text="H"
              testid="size-consolidate-toggle-h"
              tooltip="Click to go back to a single size"
              glyph={<ChevronsRightLeft className="size-3" />}
              onClick={() => toggleSplit(false)}
              disabled={disabled}
            />
          }
          value={height}
          min={HEIGHT_MIN}
          max={HEIGHT_MAX}
          step={1}
          unit="px"
          disabled={disabled}
          defaultValue={heightDefault}
          onChange={(h) => onCommitHeight(h)}
        />
        {hint}
      </div>
    );
  }
}
