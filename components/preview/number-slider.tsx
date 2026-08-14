"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Shared inspector-row layout tokens. Every labelled control in the caption
 * inspector (NumberSlider, the `Row` wrapper, chip rows, toggles) reads the
 * SAME fixed label-column width + gap from here so labels line up to one left
 * edge across the Transform / Style / Text / 3D tabs. Numeric readouts are
 * right-aligned (the number input's own `text-right`).
 */
export const INSPECTOR_LABEL_WIDTH_CLASS = "w-16";
export const INSPECTOR_ROW_GAP_CLASS = "gap-2";

/** A fixed-width, left-aligned label cell for an inspector row. */
export const INSPECTOR_LABEL_CLASS = `${INSPECTOR_LABEL_WIDTH_CLASS} shrink-0 text-xs text-muted-foreground`;

/** Snap a value to the nearest detent. Empty detents ⇒ identity. */
export function snapToDetents(v: number, detents: number[]): number {
  if (!detents.length) return v;
  let best = detents[0];
  let bestDist = Math.abs(detents[0] - v);
  for (const d of detents) {
    const dist = Math.abs(d - v);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

export interface NumberSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  detents?: number[];
  label?: string;
  /**
   * Custom label cell rendered in place of the plain `label` string — used by
   * the SizeField's clickable toggle-label. It occupies the SAME label column
   * (`INSPECTOR_LABEL_CLASS` width) INSIDE this row's `@container`, so the
   * range-track wrap math is identical to a normal labeled slider (the toggle
   * no longer steals width from a sibling element outside the container). When
   * provided, `label` is ignored for rendering but still used for `aria-label`.
   */
  labelSlot?: React.ReactNode;
  /**
   * The value this control resets to. When provided AND the current value
   * differs, a small reset affordance (↺) appears at the end of the row on
   * hover. Omit to suppress the reset control entirely.
   */
  defaultValue?: number;
  onChange: (v: number) => void;
  /**
   * Fired when a continuous adjustment ENDS — pointer-up on the range track or
   * blur of the number input. Inspector callers use this to persist the
   * coalesced edit immediately (flush the debounced PATCH) instead of waiting
   * for the trailing debounce. `onChange` already painted every intermediate
   * value via the shared edit store; this is purely the "commit now" signal.
   */
  onCommitEnd?: () => void;
  className?: string;
  /** Render read-only + dimmed (used by toggle-gated rows that stay mounted —
   *  e.g. wrap-width when the Wrap toggle is off — instead of unmounting). */
  disabled?: boolean;
}

/**
 * Controlled numeric control: a draggable range track + an editable number
 * input, both driving `onChange` live.
 *
 * Holding Alt while dragging the track bypasses detent/step snapping for
 * continuous adjustment. Without Alt, the dragged value snaps to the nearest
 * detent (when `detents` is supplied) or to `step`.
 */
export function NumberSlider({
  value,
  min,
  max,
  step = 1,
  unit,
  detents,
  label,
  labelSlot,
  defaultValue,
  onChange,
  onCommitEnd,
  className,
  disabled,
}: NumberSliderProps) {
  const snap = React.useCallback(
    (raw: number, bypass: boolean): number => {
      if (bypass) return raw;
      if (detents && detents.length) return snapToDetents(raw, detents);
      // Snap to step relative to min.
      return min + Math.round((raw - min) / step) * step;
    },
    [detents, min, step],
  );

  const clampToRange = React.useCallback(
    (n: number) => Math.min(max, Math.max(min, n)),
    [min, max],
  );

  // While the number input is focused we hold the raw typed string as a draft
  // so the user can freely clear it / type intermediate values (the controlled
  // numeric `value` snaps back each keystroke otherwise). `onChange` still fires
  // live (clamped) so the preview paints as they type; the draft is released on
  // blur, after which the field shows the committed `value`.
  const [draft, setDraft] = React.useState<string | null>(null);

  const handleRangeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.target.value);
    if (Number.isNaN(raw)) return;
    // `altKey` is available on the native event for change/input.
    const bypass = (e.nativeEvent as { altKey?: boolean }).altKey === true;
    onChange(snap(raw, bypass));
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setDraft(text);
    if (text.trim() === "" || text === "-") return; // mid-edit; don't commit yet
    const raw = Number(text);
    if (Number.isNaN(raw)) return;
    onChange(clampToRange(raw));
  };

  const showReset =
    !disabled && defaultValue !== undefined && Math.abs(value - defaultValue) > 1e-6;

  return (
    <div
      className={cn(
        "group @container flex flex-wrap items-center",
        INSPECTOR_ROW_GAP_CLASS,
        disabled && "opacity-50",
        className,
      )}
    >
      {labelSlot ? (
        labelSlot
      ) : label ? (
        <span className={INSPECTOR_LABEL_CLASS}>{label}</span>
      ) : null}
      {/* Range track. On a narrow row the whole control wraps: the label +
          number + unit + reset stay on the first line and the track drops to
          its own full-width line below (`order-last basis-full`), so the user
          always gets a usable-width slider. Only above the `@[300px]`
          row-container breakpoint — where an inline track is still wide enough
          to drag — does it share the first line (`basis-0`, grow). */}
      <input
        data-testid="number-slider-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={handleRangeChange}
        onPointerUp={onCommitEnd}
        onKeyUp={onCommitEnd}
        className="order-last h-1.5 min-w-0 grow basis-full cursor-pointer appearance-none rounded-full bg-input accent-primary disabled:cursor-not-allowed @[300px]:order-none @[300px]:basis-0"
        aria-label={label}
      />
      {/* Number input — fixed width so every readout's right edge aligns. The
          draft string lets the user type freely; commit (clamp) on blur/Enter. */}
      <Input
        data-testid="number-slider-number"
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={handleNumberChange}
        onFocus={(e) => {
          setDraft(String(value));
          e.currentTarget.select();
        }}
        onBlur={() => {
          setDraft(null);
          onCommitEnd?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-7 w-[4.5rem] shrink-0 cursor-pointer text-right text-xs tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {/* Fixed unit column (empty when no unit) so the input column aligns
          across rows whether or not a unit is present. */}
      <span className="w-5 shrink-0 text-left text-[10px] text-muted-foreground">
        {unit ?? ""}
      </span>
      {/* Reset-to-default — a themed (primary) button revealed on row hover when
          the value differs from its default. It reserves an inline slot (so it
          never overlaps the input) and shows the "Reset" LABEL when the row is
          wide enough, collapsing to icon-only on a narrow/minimized panel (via
          the `@container` query on the row). */}
      <button
        type="button"
        data-testid="number-slider-reset"
        aria-label="Reset to default"
        title={showReset ? `Reset to ${defaultValue}` : undefined}
        tabIndex={showReset ? 0 : -1}
        onClick={
          showReset
            ? () => {
                onChange(defaultValue!);
                onCommitEnd?.();
              }
            : undefined
        }
        className={cn(
          "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-opacity",
          "bg-primary/15 text-primary hover:bg-primary/25",
          showReset
            ? "cursor-pointer opacity-0 group-hover:opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        <RotateCcw className="size-3.5 shrink-0" />
        <span className="hidden @[300px]:inline">Reset</span>
      </button>
    </div>
  );
}
