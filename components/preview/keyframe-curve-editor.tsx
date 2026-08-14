// components/preview/keyframe-curve-editor.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Overlay } from "@/lib/engine/types";
import { overlayKeyframeTimes } from "@/lib/overlays/keyframes";
import { EASING_PRESETS } from "@/lib/engine/easing-registry";
import { easingAt } from "@/lib/preview/keyframe-list";
import { frameToTimecode } from "@/lib/preview/timecode";
import { useKeyframeOps } from "@/lib/queries/keyframes";
import {
  bezierForEasing,
  bezierHandlesSvg,
  clamp,
  formatCubicBezier,
  polylinePath,
  sampleEasing,
  svgToUnit,
  unitToSvg,
  type BezierTuple,
  type GraphBox,
} from "@/lib/preview/curve-geometry";

/** Curve-editor SVG box — a square unit graph with symmetric padding. */
const BOX: GraphBox = { width: 120, height: 120, pad: 14 };
/** Debounce for the Custom drag commit (matches the Phase 5b keyframe debounce). */
const COMMIT_DEBOUNCE_MS = 150;

interface KeyframeCurveEditorProps {
  pieceId: string;
  /** The overlay the selected keyframe belongs to. */
  overlay: Overlay;
  /** The selected keyframe's NORMALIZED time (0→1 in the overlay window). */
  t: number;
  /** Composition fps — drives the HH:MM:SS:FF segment label. */
  fps: number;
  readOnly: boolean;
}

/** Which handle is being dragged. */
type DragHandle = "c1" | "c2" | null;

/**
 * CapCut-style bézier graph editor for the selected keyframe's outgoing-segment
 * easing. Shows a preset dropdown + a unit-square graph with the current curve;
 * for bézier-representable easings two draggable control-point handles let the
 * user shape a Custom curve. Commits via `setEasing` (seconds = t·duration).
 */
export function KeyframeCurveEditor({ pieceId, overlay, t, fps, readOnly }: KeyframeCurveEditorProps) {
  const { setEasing } = useKeyframeOps(pieceId);
  const times = useMemo(() => overlayKeyframeTimes(overlay), [overlay]);

  // Resolve the SEGMENT: the selected keyframe (left) + the next keyframe (right).
  // Exact-float match is intentional: `t` is the SAME value the store received
  // from `overlayKeyframeTimes(overlay)` (never recomputed via arithmetic), and
  // `setSegmentEasing` matches on the same `k.t === t`. If a future path ever
  // rescales `t`, switch these to an epsilon compare (shared with keyframes.ts).
  const idx = times.indexOf(t);
  const rightT = idx >= 0 && idx < times.length - 1 ? times[idx + 1] : null;
  const isLast = rightT === null;

  const duration = overlay.duration > 0 ? overlay.duration : 1;
  const leftSec = t * duration;
  const rightSec = rightT !== null ? rightT * duration : null;
  // Seconds within the clip for the commit call (the route normalizes ÷duration).
  const commitSeconds = leftSec;

  const currentEasing = easingAt(overlay, t);
  // The dropdown value: the current easing if it's a known preset id, else
  // "custom" when it's a cubic-bezier literal, else the default.
  const presetValue = useMemo(() => {
    if (currentEasing && EASING_PRESETS.some((p) => p.id === currentEasing)) return currentEasing;
    if (currentEasing && currentEasing.startsWith("cubic-bezier(")) return "custom";
    return "ease-in-out";
  }, [currentEasing]);

  // Local bézier handle state (unit space). Seeded from the current easing; a
  // drag mutates it live and commits (debounced) as a `cubic-bezier(...)`.
  const seededBezier = useMemo<BezierTuple | null>(() => bezierForEasing(currentEasing), [currentEasing]);
  const [bezier, setBezier] = useState<BezierTuple | null>(seededBezier);
  // Which handle a drag currently owns. STATE, not a ref: it drives rendering
  // (the live-bezier curve below), and the hooks rules reject ref reads during
  // render.
  const [dragHandle, setDragHandle] = useState<DragHandle>(null);
  // Re-seed when the selected keyframe / stored easing changes (but not while
  // the user is mid-drag — drag owns the state then). Adjusted during render
  // (previous-state pattern) rather than in an effect.
  const [prevSeeded, setPrevSeeded] = useState(seededBezier);
  if (seededBezier !== prevSeeded) {
    setPrevSeeded(seededBezier);
    if (dragHandle === null) setBezier(seededBezier);
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitEasing = useCallback(
    (easing: string) => {
      if (readOnly || isLast) return;
      setEasing.mutate({ overlayId: overlay.id, time: commitSeconds, easing });
    },
    [readOnly, isLast, setEasing, overlay.id, commitSeconds],
  );

  const commitBezierDebounced = useCallback(
    (b: BezierTuple) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        commitEasing(formatCubicBezier(b));
      }, COMMIT_DEBOUNCE_MS);
    },
    [commitEasing],
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // ── Handle dragging (Custom curve) ──────────────────────────────────────
  const svgRef = useRef<SVGSVGElement | null>(null);
  const svgUnitAt = useCallback((e: React.PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    // Client px → viewBox px → unit space.
    const vx = ((e.clientX - r.left) / r.width) * BOX.width;
    const vy = ((e.clientY - r.top) / r.height) * BOX.height;
    return svgToUnit(vx, vy, BOX);
  }, []);

  const onHandleDown = (handle: DragHandle) => (e: React.PointerEvent) => {
    if (readOnly || isLast) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragHandle(handle);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragHandle) return;
    const u = svgUnitAt(e);
    if (!u) return;
    // x is clamped to [0,1]; y is free (overshoot allowed, but bounded for sanity).
    const x = clamp(u.x, 0, 1);
    const y = clamp(u.y, -1, 2);
    setBezier((prev) => {
      // A drag can only start on a visible handle, which requires `bezier !== null`,
      // so `prev` is non-null here; the literal is a pure type-safety default.
      const base = prev ?? [0.42, 0, 0.58, 1];
      const next: BezierTuple =
        dragHandle === "c1" ? [x, y, base[2], base[3]] : [base[0], base[1], x, y];
      commitBezierDebounced(next);
      return next;
    });
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!dragHandle) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setDragHandle(null);
    // Flush a final commit immediately on pointer-up.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setBezier((b) => {
      if (b) commitEasing(formatCubicBezier(b));
      return b;
    });
  };

  // ── Curve rendering ─────────────────────────────────────────────────────
  // While dragging (or when Custom bézier is active) draw the live bezier;
  // otherwise sample the stored easing (covers fn-only presets too).
  const activeIsBezier = bezier !== null && (presetValue === "custom" || dragHandle !== null);
  const curveEasing = activeIsBezier ? formatCubicBezier(bezier as BezierTuple) : currentEasing;
  const curvePath = useMemo(() => polylinePath(sampleEasing(curveEasing, 48), BOX), [curveEasing]);

  const handles = bezier ? bezierHandlesSvg(bezier, BOX) : null;
  const showHandles = handles !== null && !isLast;

  // Grid lines (quarter divisions).
  const gridUnits = [0.25, 0.5, 0.75];

  const onPresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id === "custom") {
      // Seed a Custom curve from the current handles and commit it as a literal.
      const b = bezier ?? bezierForEasing(currentEasing) ?? [0.42, 0, 0.58, 1];
      setBezier(b as BezierTuple);
      commitEasing(formatCubicBezier(b as BezierTuple));
      return;
    }
    // A named preset — seed handles from its bezier (null for fn-only) + commit.
    setBezier(bezierForEasing(id));
    commitEasing(id);
  };

  const p0 = unitToSvg(0, 0, BOX);
  const p3 = unitToSvg(1, 1, BOX);

  return (
    <div className="flex min-h-0 flex-col gap-2 p-0.5" data-testid="keyframe-curve-editor">
      {isLast ? (
        <p className="rounded bg-black/20 px-2 py-1.5 text-center text-[11px] text-muted-foreground">
          No outgoing segment — easing applies between keyframes. Select an earlier keyframe to shape
          its curve.
        </p>
      ) : (
        <p className="text-center text-[11px] text-muted-foreground">
          Segment{" "}
          <span className="font-mono font-medium text-foreground">
            {frameToTimecode(Math.round(leftSec * fps), fps)}
          </span>
          {" → "}
          <span className="font-mono font-medium text-foreground">
            {frameToTimecode(Math.round(rightSec! * fps), fps)}
          </span>
        </p>
      )}

      {/* Preset dropdown — centered above the graph */}
      <label className="flex items-center justify-center gap-2 text-[11px]">
        <span className="text-muted-foreground">Easing</span>
        <select
          data-testid="keyframe-easing-preset"
          disabled={readOnly || isLast}
          value={presetValue}
          onChange={onPresetChange}
          className="cursor-pointer rounded border border-border bg-background px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {EASING_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {/* Bézier graph */}
      <div className="flex justify-center">
        <svg
          ref={svgRef}
          data-testid="keyframe-curve-svg"
          viewBox={`0 0 ${BOX.width} ${BOX.height}`}
          className="w-full max-w-[130px] touch-none select-none rounded bg-black/30"
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          role="img"
          aria-label="Easing curve editor"
        >
          {/* Frame */}
          <rect
            x={BOX.pad}
            y={BOX.pad}
            width={BOX.width - BOX.pad * 2}
            height={BOX.height - BOX.pad * 2}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.5}
            className="text-border"
          />
          {/* Grid */}
          {gridUnits.map((g) => {
            const v = unitToSvg(g, 0, BOX);
            const h = unitToSvg(0, g, BOX);
            return (
              <g key={g} className="text-border/60" stroke="currentColor" strokeWidth={0.3}>
                <line x1={v.x} y1={BOX.pad} x2={v.x} y2={BOX.height - BOX.pad} />
                <line x1={BOX.pad} y1={h.y} x2={BOX.width - BOX.pad} y2={h.y} />
              </g>
            );
          })}
          {/* Diagonal reference (linear) */}
          <line
            x1={p0.x}
            y1={p0.y}
            x2={p3.x}
            y2={p3.y}
            className="text-muted-foreground/40"
            stroke="currentColor"
            strokeWidth={0.4}
            strokeDasharray="2 2"
          />
          {/* Eased curve */}
          <path
            data-testid="keyframe-curve-path"
            d={curvePath}
            fill="none"
            className="text-primary"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          {/* Handles (only for bézier-representable easings) */}
          {showHandles && handles && (
            <g>
              {/* Control arms */}
              <line
                x1={handles.p0.x}
                y1={handles.p0.y}
                x2={handles.c1.x}
                y2={handles.c1.y}
                className="text-primary/50"
                stroke="currentColor"
                strokeWidth={0.5}
              />
              <line
                x1={handles.p3.x}
                y1={handles.p3.y}
                x2={handles.c2.x}
                y2={handles.c2.y}
                className="text-primary/50"
                stroke="currentColor"
                strokeWidth={0.5}
              />
              {/* Endpoints (fixed) */}
              <circle cx={handles.p0.x} cy={handles.p0.y} r={1.6} className="fill-muted-foreground" />
              <circle cx={handles.p3.x} cy={handles.p3.y} r={1.6} className="fill-muted-foreground" />
              {/* Draggable control points */}
              <circle
                data-testid="keyframe-handle-c1"
                cx={handles.c1.x}
                cy={handles.c1.y}
                r={3}
                className={`fill-primary ${readOnly ? "" : "cursor-pointer"}`}
                onPointerDown={onHandleDown("c1")}
              />
              <circle
                data-testid="keyframe-handle-c2"
                cx={handles.c2.x}
                cy={handles.c2.y}
                r={3}
                className={`fill-primary ${readOnly ? "" : "cursor-pointer"}`}
                onPointerDown={onHandleDown("c2")}
              />
            </g>
          )}
        </svg>
      </div>

      {!isLast && !showHandles && (
        <p className="text-center text-[10px] text-muted-foreground">
          This preset isn&apos;t bézier-shaped — pick Custom to drag handles.
        </p>
      )}
      {readOnly && (
        <p className="text-center text-[10px] text-muted-foreground">Snapshot view — read-only.</p>
      )}
    </div>
  );
}
