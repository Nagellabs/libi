"use client";

import { useCallback, useRef, useState } from "react";
import type { Transform3D } from "@/lib/engine/types";
import { snapAngleToDetents, IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import { Input } from "@/components/ui/input";

/** Angle (deg, top = 0, clockwise +, range −180…180) of `p` about center `c`. */
function angleDegAbout(px: number, py: number, cx: number, cy: number): number {
  return (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI;
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
// Two rings now (Spin removed), so the dial is more compact than the old 3-ring
// version (was 124px).
const DIAL_SIZE = 92;

/** The dial's rotation axes, with their ring radius fraction + color + label. The
 *  radius fractions keep a comfortable gap (~15px on the 92px dial) so each ring
 *  knob sits in its own band and is easy to grab without hitting the neighbour.
 *
 *  Spin (roll about the view axis, `rotation.z`) is intentionally NOT here. On the
 *  `three` Scene root a `rotation.z` roll does not actually render (a three.js
 *  quirk — only a child object's roll shows), so the dial would have a dead axis.
 *  In-plane roll is owned by the generic 2D `rotation`/`transformSpin` control
 *  (Transform tab), which rolls the composited quad reliably. The dial keeps only
 *  the genuinely out-of-plane axes — Angle (yaw) and Elevation (pitch). */
const RINGS = [
  { axis: "y", rf: 0.46, color: "#22c55e", label: "Angle", short: "A", tid: "gizmo-ring-angle" },
  { axis: "x", rf: 0.29, color: "#ef4444", label: "Elevation", short: "E", tid: "gizmo-ring-elevation" },
] as const;

interface RotationDialFieldProps {
  /** The overlay's current 3D transform (rotation is read from `.rotation`). */
  transform3d?: Transform3D | null;
  /** Editor-lock suppresses every gesture / edit. */
  locked?: boolean;
  /** Per-change writer — the inspector routes this to its shared edit store
   *  (live preview). Called on each ring move + each number-input keystroke. */
  onChange: (next: Transform3D) => void;
  /** Force the debounced PATCH NOW — ring pointer-up / number-input blur. */
  onFlush?: () => void;
}

/**
 * RotationDialField — the in-panel 3D rotation editor. Three concentric labeled
 * ring dials (Angle yaw / Elevation pitch / Spin roll) over a single SVG, plus
 * three manually-editable degree inputs. This replaces BOTH the floating
 * on-canvas rotate dial (removed) and the per-axis rotation sliders that used to
 * live in each 3D inspector panel — one control, shown directly in the panel.
 *
 * Each ring knob's ANGULAR position about the dial center sets one rotation axis
 * as an ABSOLUTE angle (clock-hand model). The center is read live from the
 * SVG's bounding box. Dragging snaps to a detent unless Alt is held; the number
 * inputs accept any value (free-typing draft) and commit on blur/Enter.
 */
export function RotationDialField({
  transform3d,
  locked = false,
  onChange,
  onFlush,
}: RotationDialFieldProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const baseRef = useRef<Transform3D | null>(null);
  const listenersRef = useRef<{ move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(
    null,
  );
  const [, setDragging] = useState(false);
  // Per-axis free-typing draft for the number inputs.
  const [draft, setDraft] = useState<Partial<Record<"x" | "y" | "z", string>>>({});
  // Live mid-drag transform. STATE, not a ref + force-render: the value drives
  // rendering (the knob + readouts), and the hooks rules reject ref reads
  // during render.
  const [live, setLive] = useState<Transform3D | null>(null);

  const current = transform3d ?? IDENTITY_TRANSFORM3D;
  const liveRot = live?.rotation ?? current.rotation;

  const endGesture = useCallback(() => {
    const l = listenersRef.current;
    if (l) {
      window.removeEventListener("mousemove", l.move);
      window.removeEventListener("mouseup", l.up);
      listenersRef.current = null;
    }
    baseRef.current = null;
    setDragging(false);
  }, []);

  const beginRingGesture = useCallback(
    (e: React.MouseEvent, axis: "x" | "y" | "z") => {
      if (locked) return;
      e.preventDefault();
      e.stopPropagation();
      const base = transform3d ?? IDENTITY_TRANSFORM3D;
      baseRef.current = base;
      setLive(null);
      setDragging(true);

      const rect = svgRef.current?.getBoundingClientRect();
      const cx = (rect?.left ?? 0) + (rect?.width ?? DIAL_SIZE) / 2;
      const cy = (rect?.top ?? 0) + (rect?.height ?? DIAL_SIZE) / 2;

      const move = (ev: MouseEvent) => {
        const b = baseRef.current;
        if (!b) return;
        const deg = angleDegAbout(ev.clientX, ev.clientY, cx, cy);
        let rad = deg * RAD;
        if (!ev.altKey) rad = snapAngleToDetents(rad);
        const next: Transform3D = { ...b, rotation: { ...b.rotation, [axis]: rad } };
        setLive(next);
        onChange(next);
      };

      const up = () => {
        endGesture();
        setLive(null);
        onFlush?.();
      };

      listenersRef.current = { move, up };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [locked, transform3d, endGesture, onChange, onFlush],
  );

  /** Commit a degree value typed into one axis's number input. */
  const setAxisDeg = useCallback(
    (axis: "x" | "y" | "z", deg: number) => {
      const base = transform3d ?? IDENTITY_TRANSFORM3D;
      onChange({ ...base, rotation: { ...base.rotation, [axis]: deg * RAD } });
    },
    [transform3d, onChange],
  );

  const degOf = (rad: number) => Math.round(rad * DEG);

  return (
    <div
      data-testid="rotation-dial-field"
      className="flex min-w-[180px] flex-col items-center gap-2"
    >
      <svg
        ref={svgRef}
        width={DIAL_SIZE}
        height={DIAL_SIZE}
        viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
        style={{ overflow: "visible" }}
      >
        {RINGS.map((ring) => {
          const cx = DIAL_SIZE / 2;
          const cy = DIAL_SIZE / 2;
          const r = DIAL_SIZE * ring.rf;
          const deg = degOf(liveRot[ring.axis]);
          const a = deg * RAD;
          const kx = cx + r * Math.sin(a);
          const ky = cy - r * Math.cos(a);
          return (
            <g key={ring.axis}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={ring.color}
                strokeOpacity={0.5}
                strokeWidth={1.5}
              />
              <circle
                data-testid={ring.tid}
                cx={kx}
                cy={ky}
                r={7}
                fill={ring.color}
                stroke="white"
                strokeWidth={2}
                style={{ pointerEvents: locked ? "none" : "auto", cursor: locked ? "default" : "grab" }}
                onMouseDown={(e) => beginRingGesture(e, ring.axis)}
              />
            </g>
          );
        })}
      </svg>

      {/* Three editable degree inputs (green=Angle, red=Elevation, blue=Spin). */}
      <div className="flex w-full flex-col gap-1">
        {RINGS.map((ring) => {
          const committedDeg = degOf(liveRot[ring.axis]);
          const value = draft[ring.axis] ?? String(committedDeg);
          return (
            <div key={ring.axis} className="flex items-center gap-2">
              <span
                className="w-16 shrink-0 text-xs"
                style={{ color: ring.color }}
              >
                {ring.label}
              </span>
              <Input
                data-testid={`rotation-input-${ring.axis}`}
                type="number"
                min={-180}
                max={180}
                step={1}
                disabled={locked}
                value={value}
                onFocus={(e) => {
                  setDraft((d) => ({ ...d, [ring.axis]: String(committedDeg) }));
                  e.currentTarget.select();
                }}
                onChange={(e) => {
                  const text = e.target.value;
                  setDraft((d) => ({ ...d, [ring.axis]: text }));
                  if (text.trim() === "" || text === "-") return;
                  const n = Number(text);
                  if (Number.isNaN(n)) return;
                  setAxisDeg(ring.axis, Math.max(-180, Math.min(180, n)));
                }}
                onBlur={() => {
                  setDraft((d) => ({ ...d, [ring.axis]: undefined }));
                  onFlush?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                className="h-7 w-[4.5rem] cursor-pointer text-right text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="w-5 shrink-0 text-left text-[10px] text-muted-foreground">°</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
