"use client";

import { cn } from "@/lib/utils";

/**
 * The five shared camera-preset values. Text overlays store this on
 * `threeD.tilt`; `three` overlays store it on `cameraPreset` — but it is the
 * SAME enum mapped through `applyCameraPreset`, so both surfaces render this one
 * illustrated grid.
 */
export type CameraPreset =
  | "billboard"
  | "ground"
  | "lowAngle"
  | "highAngle"
  | "angled";

/** Human labels for each preset — exported for reuse by other surfaces. */
export const CAMERA_PRESET_LABELS: Record<CameraPreset, string> = {
  billboard: "Billboard",
  ground: "Ground",
  lowAngle: "Low angle",
  highAngle: "High angle",
  angled: "Angled",
};

const ORDER: CameraPreset[] = [
  "billboard",
  "ground",
  "lowAngle",
  "highAngle",
  "angled",
];

/**
 * A small inline glyph (~28px, currentColor) suggesting the camera angle for
 * each preset. They don't need to be perfect — just visually distinguishable.
 */
function PresetGlyph({ preset }: { preset: CameraPreset }) {
  const common = {
    width: 28,
    height: 28,
    viewBox: "0 0 28 28",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (preset) {
    case "billboard":
      // Rectangle face-on (flat, facing the viewer).
      return (
        <svg {...common}>
          <rect x="7" y="6" width="14" height="16" rx="1" />
        </svg>
      );
    case "ground":
      // Trapezoid (plane laid flat, receding to a horizon line).
      return (
        <svg {...common}>
          <line x1="4" y1="9" x2="24" y2="9" />
          <path d="M9 21 L19 21 L23 11 L5 11 Z" />
        </svg>
      );
    case "lowAngle":
      // Rectangle whose TOP edge leans away (camera below, looking up).
      return (
        <svg {...common}>
          <path d="M9 21 L19 21 L22 8 L6 8 Z" />
        </svg>
      );
    case "highAngle":
      // Rectangle whose BOTTOM edge leans away (camera above, looking down).
      return (
        <svg {...common}>
          <path d="M6 20 L22 20 L19 7 L9 7 Z" />
        </svg>
      );
    case "angled":
      // Parallelogram (3/4 view).
      return (
        <svg {...common}>
          <path d="M11 6 L23 6 L17 22 L5 22 Z" />
        </svg>
      );
  }
}

/**
 * CameraPresetGrid — a responsive grid of selectable, illustrated camera-preset
 * tiles. The active tile is highlighted; clicking any tile fires `onChange`. The
 * consumer renders its own "Camera" section label.
 */
export function CameraPresetGrid({
  value,
  onChange,
  className,
}: {
  /** The active tile, or `null` when no preset matches (no tile highlighted). */
  value: CameraPreset | null;
  onChange: (v: CameraPreset) => void;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-3 gap-1.5", className)}>
      {ORDER.map((preset) => {
        const active = value === preset;
        return (
          <button
            key={preset}
            type="button"
            data-testid={`camera-preset-${preset}`}
            aria-pressed={active}
            onClick={() => onChange(preset)}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-1 rounded border px-1 py-1.5 text-[10px] transition-colors",
              active
                ? "border-primary bg-primary/15 text-foreground ring-1 ring-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <PresetGlyph preset={preset} />
            <span className="leading-tight">{CAMERA_PRESET_LABELS[preset]}</span>
          </button>
        );
      })}
    </div>
  );
}
