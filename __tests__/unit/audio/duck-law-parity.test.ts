import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { duckGainCurve, duckCoefficients } from "@/lib/audio/duck-law";
import { DEFAULT_DUCK, sanitizeDuck } from "@/lib/audio/duck-params";
import type { DuckSettings } from "@/lib/engine/types";

/**
 * The preview runs the duck in `public/worklets/sidechain-envelope.js`; the
 * export runs it through `duckGainCurve`. This test loads the WORKLET'S OWN
 * SOURCE and drives it sample-for-sample against the module, so the two cannot
 * drift. They already drifted once by 5.2 dB, which is what buried the voice in
 * every exported file.
 */

const SR = 44100;
const WORKLET = path.join(process.cwd(), "public", "worklets", "sidechain-envelope.js");

/**
 * Evaluate the worklet file with the AudioWorklet globals stubbed, and return
 * the processor class it registers.
 */
function loadWorkletProcessor(): new () => {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean;
} {
  const source = fs.readFileSync(WORKLET, "utf8");
  let registered: unknown = null;
  const sandbox = {
    AudioWorkletProcessor: class {},
    registerProcessor: (_name: string, ctor: unknown) => {
      registered = ctor;
    },
    sampleRate: SR,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: WORKLET });
  expect(registered, "worklet must call registerProcessor").not.toBeNull();
  return registered as new () => {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      params: Record<string, Float32Array>,
    ): boolean;
  };
}

/** Run the worklet over a signal in 128-sample render quanta, as the browser does. */
function workletGain(sidechain: Float32Array, duck: DuckSettings): Float32Array {
  const Processor = loadWorkletProcessor();
  const proc = new Processor();
  const c = duckCoefficients(duck, SR);
  const params = {
    thresholdLinear: new Float32Array([c.thresholdLinear]),
    ratio: new Float32Array([c.ratio]),
    attackCoeff: new Float32Array([c.attackCoeff]),
    releaseCoeff: new Float32Array([c.releaseCoeff]),
    reductionMin: new Float32Array([c.reductionMin]),
  };
  const QUANTUM = 128;
  const out = new Float32Array(sidechain.length);
  for (let off = 0; off + QUANTUM <= sidechain.length; off += QUANTUM) {
    const inBuf = sidechain.subarray(off, off + QUANTUM);
    const outBuf = new Float32Array(QUANTUM);
    proc.process([[inBuf]], [[outBuf]], params);
    out.set(outBuf, off);
  }
  return out;
}

/** Speech-like sidechain: bursts of tone separated by silence. */
function sidechainSignal(seconds = 3): Float32Array {
  const n = Math.floor(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const speaking = t % 1.0 < 0.45;
    x[i] = speaking ? 0.35 * Math.sin(2 * Math.PI * 180 * t) : 0;
  }
  return x;
}

/**
 * One voice-over line: a tone burst that occupies [start, start+length) of an
 * otherwise silent `seconds`-long timeline — i.e. one sidechain clip already
 * placed on the timeline, which is what `placeOnTimeline` produces.
 */
function voiceLine(start: number, length: number, seconds: number, freq = 180, amp = 0.35): Float32Array {
  const n = Math.floor(seconds * SR);
  const x = new Float32Array(n);
  const from = Math.floor(start * SR);
  const to = Math.min(n, Math.floor((start + length) * SR));
  for (let i = from; i < to; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * (i / SR));
  return x;
}

/** Sum N timeline-placed sidechains into the one mono buffer the law reads. */
function sumSidechains(lines: Float32Array[]): Float32Array {
  const n = Math.max(...lines.map((l) => l.length));
  const out = new Float32Array(n);
  for (const line of lines) for (let i = 0; i < line.length; i++) out[i] += line[i];
  return out;
}

/** Largest per-sample gap between the module's curve and the worklet's. */
function maxParityDiff(sidechain: Float32Array, duck: DuckSettings): number {
  const mine = duckGainCurve(sidechain, duck, SR);
  const theirs = workletGain(sidechain, duck);
  const n = Math.floor(sidechain.length / 128) * 128;
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - theirs[i]));
  return maxDiff;
}

describe("duck law parity: worklet vs duckGainCurve", () => {
  const duck = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo"] });

  it("produces the same gain, sample for sample", () => {
    const sc = sidechainSignal();
    const mine = duckGainCurve(sc, duck, SR);
    const theirs = workletGain(sc, duck);

    const n = Math.floor(sc.length / 128) * 128;
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - theirs[i]));
    // Float32 rounding only — the arithmetic is identical.
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it.each([-6, -12, -24])("agrees at reductionDb %d", (reductionDb) => {
    const d = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo"], reductionDb });
    expect(maxParityDiff(sidechainSignal(2), d)).toBeLessThan(1e-6);
  });

  /**
   * N sidechains change WHAT FEEDS the curve — the export sums the placed
   * clips into one mono buffer and runs the law once — so parity has to hold
   * on a summed signal too, at the same bound. It is the summed buffer the
   * worklet sees as well: Web Audio sums fan-in on the worklet's single input.
   */
  it.each([2, 3, 6])("holds with %d summed sidechains", (count) => {
    const seconds = count + 2;
    const lines = Array.from({ length: count }, (_, i) =>
      voiceLine(0.5 + i * 1.0, 0.6, seconds, 180 + i * 40),
    );
    expect(maxParityDiff(sumSidechains(lines), duck)).toBeLessThan(1e-6);
  });

  it("holds where two sidechains OVERLAP and the sum exceeds either alone", () => {
    // Overlapping speech is the case that would expose an averaged or
    // per-clip-multiplied duck: the summed level is what both engines must see.
    const a = voiceLine(0.5, 2.0, 4, 180, 0.35);
    const b = voiceLine(1.0, 2.0, 4, 300, 0.35);
    expect(maxParityDiff(sumSidechains([a, b]), duck)).toBeLessThan(1e-6);
  });
});

describe("duckGainCurve", () => {
  const duck = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo"] });

  it("never exceeds 1 — a duck attenuates, it does not boost", () => {
    const sc = sidechainSignal();
    for (const g of duckGainCurve(sc, duck, SR)) expect(g).toBeLessThanOrEqual(1);
  });

  it("never goes below the reduction floor", () => {
    const floor = duckCoefficients(duck, SR).reductionMin;
    const loud = new Float32Array(SR).fill(0.9);
    for (const g of duckGainCurve(loud, duck, SR)) {
      expect(g).toBeGreaterThanOrEqual(floor - 1e-6);
    }
  });

  it("stays at unity for a silent sidechain", () => {
    const silence = new Float32Array(SR);
    const g = duckGainCurve(silence, duck, SR);
    expect(g[0]).toBeCloseTo(1, 6);
    expect(g[g.length - 1]).toBeCloseTo(1, 6);
  });

  it("actually ducks a loud sidechain — and by more than ffmpeg's compressor managed", () => {
    const loud = new Float32Array(SR).fill(0.3);
    const g = duckGainCurve(loud, duck, SR);
    const settled = 20 * Math.log10(g[g.length - 1]);
    // The shipped sidechaincompress reached only about -1.8 dB on real material.
    expect(settled).toBeLessThan(-4);
  });

  it("returns one gain per sidechain sample", () => {
    expect(duckGainCurve(new Float32Array(1234), duck, SR).length).toBe(1234);
  });

  it("ducks under every sidechain clip, and between them lets go", () => {
    // Two 1 s voice lines at t=1 and t=5 of an 8 s timeline, summed the way
    // the export sums placed sidechains. Both must duck; the gap must not.
    const summed = sumSidechains([
      voiceLine(1, 1, 8, 180),
      voiceLine(5, 1, 8, 260),
    ]);
    const gain = duckGainCurve(summed, duck, SR);
    expect(gain[Math.floor(1.5 * SR)]).toBeLessThan(0.5);
    expect(gain[Math.floor(5.5 * SR)]).toBeLessThan(0.5);
    expect(gain[Math.floor(3.0 * SR)]).toBeGreaterThan(0.95);
  });

  it("does not double-duck where two sidechains overlap", () => {
    // Summing then curving once must stay above the reduction floor and above
    // what multiplying two independent curves would give (floor²).
    const floor = duckCoefficients(duck, SR).reductionMin;
    const overlapped = sumSidechains([voiceLine(0.5, 3, 4, 180), voiceLine(0.5, 3, 4, 300)]);
    const gain = duckGainCurve(overlapped, duck, SR);
    let min = Infinity;
    for (const g of gain) min = Math.min(min, g);
    expect(min).toBeGreaterThanOrEqual(floor - 1e-6);
    expect(min).toBeGreaterThan(floor * floor);
  });
});
