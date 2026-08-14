// lib/effects/__tests__/effect-harness.ts
import { expect } from "vitest";
import type { EffectDef, EffectPhase, ResolvedParams, TransformDelta } from "@/lib/effects/types";
import { drawOverlay, type DrawOverlayContext } from "@/lib/engine/overlay-renderer";
import type { TextOverlay } from "@/lib/engine/types";

type DeltaKey = keyof TransformDelta;

export interface FieldExpectation {
  /** Sampled value should be non-decreasing ("up") or non-increasing ("down"). */
  monotonic?: "up" | "down";
  /** Approx value at p=0. */
  from?: number;
  /** Approx value at p=1. */
  to?: number;
  /** Some sampled value strictly exceeds this. */
  overshootAbove?: number;
  /** Some sampled value strictly below this. */
  undershootBelow?: number;
  /** Value at p=1 equals this (within tol). */
  settleTo?: number;
  /** value(p=0) ≈ value(p=1) — seamless loop. */
  seamless?: boolean;
}

export type MotionSignature = Partial<Record<DeltaKey, FieldExpectation>>;

const SAMPLES = 21; // p = 0, 0.05, … 1
const TOL = 1e-6;

function sample(def: EffectDef, params: ResolvedParams): TransformDelta[] {
  const out: TransformDelta[] = [];
  for (let i = 0; i < SAMPLES; i++) out.push(def.animate(i / (SAMPLES - 1), params));
  return out;
}

function val(d: TransformDelta, key: DeltaKey, fallback: number): number {
  const v = d[key];
  return typeof v === "number" ? v : fallback;
}

/** Identity for the field (opacity/scale default 1; translate/rotate/blur default 0). */
function identityFor(key: DeltaKey): number {
  return key === "opacity" || key === "scale" || key === "scaleX" || key === "scaleY" ? 1 : 0;
}

export function assertMotionSignature(
  def: EffectDef,
  _phase: EffectPhase,
  signature: MotionSignature,
  params: ResolvedParams = {},
): void {
  const series = sample(def, params);
  for (const k of Object.keys(signature) as DeltaKey[]) {
    const exp = signature[k]!;
    const id = identityFor(k);
    const vals = series.map((d) => val(d, k, id));
    const first = vals[0];
    const last = vals[vals.length - 1];

    if (exp.from !== undefined) expect(first).toBeCloseTo(exp.from, 4);
    if (exp.to !== undefined) expect(last).toBeCloseTo(exp.to, 4);
    if (exp.settleTo !== undefined) expect(last).toBeCloseTo(exp.settleTo, 4);
    if (exp.overshootAbove !== undefined)
      expect(Math.max(...vals)).toBeGreaterThan(exp.overshootAbove + TOL);
    if (exp.undershootBelow !== undefined)
      expect(Math.min(...vals)).toBeLessThan(exp.undershootBelow - TOL);
    if (exp.seamless) expect(first).toBeCloseTo(last, 4);
    if (exp.monotonic) {
      for (let i = 1; i < vals.length; i++) {
        if (exp.monotonic === "up") expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1] - TOL);
        else expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + TOL);
      }
    }
  }
}

/** Asserts an in/out effect settles to identity at p=1, which (given compose's
 *  out-reversal) guarantees a correct out: displaced at the element end, home at
 *  the out-window start. Use in every in/out effect's curve test. */
export function assertSettlesToIdentity(def: EffectDef, params: ResolvedParams = {}): void {
  const d = def.animate(1, params);
  for (const k of Object.keys(d) as (keyof TransformDelta)[]) {
    const v = d[k];
    if (typeof v !== "number") continue;
    const id = k === "opacity" || k === "scale" || k === "scaleX" || k === "scaleY" ? 1 : 0;
    expect(v).toBeCloseTo(id, 4);
  }
}

export interface ProofFrame { time: number; alpha: number; translated: boolean; scaled: boolean; }

/**
 * Drives the REAL `drawOverlay` with an instrumented ctx recorder to prove
 * effects composite at render time. Returns one ProofFrame per sampled time
 * across the overlay's duration.
 */
export function renderProof(effectId: string, phase: "in" | "out" | "loop"): ProofFrame[] {
  const frames: ProofFrame[] = [];
  const duration = 2;
  const overlay: TextOverlay = {
    id: "proof", kind: "text", startTime: 0, duration, z: 0,
    rect: { x: 50, y: 25, width: 100, height: 50 }, opacity: 1,
    content: "Aa", font: "24px Inter", color: "#fff", align: "left",
    effects: { [phase]: { effectId, durationMs: 1000 } },
  };
  for (let i = 0; i <= 10; i++) {
    const time = (i / 10) * duration;
    let alpha = 1; let translated = false; let scaled = false;
    const ctx = {
      save() {}, restore() {},
      translate() { translated = true; }, rotate() {}, scale() { scaled = true; },
      set globalAlpha(v: number) { alpha = v; }, get globalAlpha() { return alpha; },
      set filter(_v: string) {}, get filter() { return "none"; },
      fillText() {}, measureText() { return { width: 10 } as TextMetrics; },
      fillRect() {}, beginPath() {}, rect() {}, clip() {}, fill() {}, stroke() {},
      set font(_v: string) {}, get font() { return "10px sans"; },
      set fillStyle(_v: string) {}, get fillStyle() { return "#000"; },
      set textAlign(_v: string) {}, get textAlign() { return "left" as CanvasTextAlign; },
      set textBaseline(_v: string) {}, get textBaseline() { return "alphabetic" as CanvasTextBaseline; },
      set globalCompositeOperation(_v: string) {}, get globalCompositeOperation() { return "source-over" as GlobalCompositeOperation; },
    } as unknown as CanvasRenderingContext2D;
    const drawCtx = { ctx, width: 200, height: 100, fps: 30, totalFrames: 60, frame: Math.round(time * 30), time, assets: {} } as DrawOverlayContext;
    drawOverlay(overlay, drawCtx);
    frames.push({ time, alpha, translated, scaled });
  }
  return frames;
}
