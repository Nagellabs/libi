import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { duckCoefficients, duckGainCurve } from "@/lib/audio/duck-law";
import { DEFAULT_DUCK, sanitizeDuck } from "@/lib/audio/duck-params";

/**
 * The duck's gain node has an intrinsic gain of 0 and the worklet is its SOLE
 * driver (`duckGain.gain.value = 0` in web-audio-engine), so whatever the
 * worklet writes IS the music's level. In a real session the music went silent
 * whenever the narration was not playing: with nothing flowing into the worklet
 * the browser hands `process()` an input with ZERO channels (`inputs[0] === []`),
 * the old early return wrote nothing, the output stayed at its zero fill, and
 * the music was multiplied by 0 — before the narration started, and for the
 * whole rest of the piece once it ended.
 *
 * These tests drive the worklet's own source with the shapes the browser
 * actually delivers: no channels, all-zero channels, a loud channel, and the
 * sidechain coming and going mid-stream.
 */

const SR = 44100;
const QUANTUM = 128;
const WORKLET = path.join(process.cwd(), "public", "worklets", "sidechain-envelope.js");

type Processor = {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
};

function loadProcessor(): new () => Processor {
  const source = fs.readFileSync(WORKLET, "utf8");
  let registered: unknown = null;
  const sandbox = {
    AudioWorkletProcessor: class {},
    registerProcessor: (_name: string, ctor: unknown) => { registered = ctor; },
    sampleRate: SR,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: WORKLET });
  return registered as new () => Processor;
}

const duck = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo"] });
const c = duckCoefficients(duck, SR);
const params = {
  thresholdLinear: new Float32Array([c.thresholdLinear]),
  ratio: new Float32Array([c.ratio]),
  attackCoeff: new Float32Array([c.attackCoeff]),
  releaseCoeff: new Float32Array([c.releaseCoeff]),
  reductionMin: new Float32Array([c.reductionMin]),
};

/** What the sidechain delivers for one render quantum. */
type Feed = "none" | "zero" | "loud";

function loudQuantum(offset: number): Float32Array {
  const q = new Float32Array(QUANTUM);
  for (let i = 0; i < QUANTUM; i++) q[i] = 0.5 * Math.sin((2 * Math.PI * 180 * (offset + i)) / SR);
  return q;
}

/**
 * Run `seconds` of quanta through one processor. Returns the output, laid out
 * flat, with a nonzero sentinel in every output buffer first so that "wrote
 * nothing" cannot pass as "wrote zero" — the browser zero-fills, the sentinel
 * does not, and either reading is a failure for an unwritten sample.
 */
function run(proc: Processor, feeds: Feed[], sentinel = -7): Float32Array {
  const out = new Float32Array(feeds.length * QUANTUM);
  feeds.forEach((feed, q) => {
    const input: Float32Array[] =
      feed === "none" ? [] : feed === "zero" ? [new Float32Array(QUANTUM)] : [loudQuantum(q * QUANTUM)];
    const outBuf = new Float32Array(QUANTUM).fill(sentinel);
    const ret = proc.process([input], [[outBuf]], params);
    expect(ret, "the processor must keep running").toBe(true);
    out.set(outBuf, q * QUANTUM);
  });
  return out;
}

const quanta = (seconds: number) => Math.ceil((seconds * SR) / QUANTUM);

/**
 * The first sample at or under zero, or -1. One `expect` per sample is ~1M
 * assertions for a 20 s run: 2.4 s on a Mac and past the 5 s budget on CI's
 * runner (14 s, release/0.1.19). The check is the same; it asserts once.
 */
function firstNonPositive(xs: ArrayLike<number>): number {
  for (let i = 0; i < xs.length; i++) if (!(xs[i] > 0)) return i;
  return -1;
}
const rep = (feed: Feed, seconds: number): Feed[] => Array.from({ length: quanta(seconds) }, () => feed);

describe("sidechain worklet — a sidechain that is not playing", () => {
  const Processor = loadProcessor();

  it("passes the music at full level when the input has no channels", () => {
    const out = run(new Processor(), rep("none", 0.5));
    for (const g of out) expect(g).toBeCloseTo(1, 6);
  });

  it("passes the music at full level when the input is all zeros", () => {
    const out = run(new Processor(), rep("zero", 0.5));
    for (const g of out) expect(g).toBeCloseTo(1, 6);
  });

  it("writes every output sample, including a first block that has no input", () => {
    const out = run(new Processor(), ["none"]);
    expect(out.length).toBe(QUANTUM);
    for (const g of out) expect(g).toBeCloseTo(1, 6);
  });

  it("still ducks to the floor under a loud sidechain", () => {
    const out = run(new Processor(), rep("loud", 1.5));
    const settled = out[out.length - 1];
    expect(settled).toBeGreaterThanOrEqual(c.reductionMin - 1e-6);
    expect(settled).toBeLessThan(0.45);
    for (const g of out) expect(g).toBeGreaterThanOrEqual(c.reductionMin - 1e-6);
  });

  it("recovers to full level after the narration ends — the reported bug", () => {
    // 3 s before the narration, 5 s of it, then 12 s of the music alone.
    const out = run(new Processor(), [...rep("none", 3), ...rep("loud", 5), ...rep("none", 12)]);
    const at = (s: number) => out[Math.floor(s * SR)];
    expect(at(1)).toBeCloseTo(1, 6);                    // before: full
    expect(at(7.9)).toBeLessThan(0.45);                 // during: ducked
    expect(at(8 + 4)).toBeGreaterThan(0.9);             // a few seconds after: back up
    expect(at(19.9)).toBeCloseTo(1, 3);                 // the rest of the piece: full
    expect(firstNonPositive(out), "never muted: index of the first sample <= 0").toBe(-1);
  });

  it("is continuous when the sidechain disappears and reappears", () => {
    // voice, gap of silent-input, voice, gap with NO channels at all.
    const feeds = [...rep("loud", 1), ...rep("none", 0.4), ...rep("loud", 1), ...rep("none", 0.4)];
    const out = run(new Processor(), feeds);
    // The gain never jumps: the 0.01 smoother bounds it per sample.
    let maxStep = 0;
    for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
    expect(maxStep).toBeLessThan(0.01);
    // A short gap releases only part of the way (release is slow), and the
    // second voice ducks again.
    const at = (s: number) => out[Math.floor(s * SR)];
    expect(at(1.4)).toBeGreaterThan(at(1.0));
    expect(at(2.4)).toBeLessThan(0.45);
  });

  it("treats a missing channel the same as an explicit silent one", () => {
    const feeds = [...rep("loud", 0.5), ...rep("none", 1)];
    const a = run(new Processor(), feeds);
    const b = run(new Processor(), [...rep("loud", 0.5), ...rep("zero", 1)]);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 7);
  });

  it("does not throw on a missing or empty output", () => {
    const proc = new Processor();
    expect(() => proc.process([[]], [], params)).not.toThrow();
    expect(() => proc.process([[]], [[]], params)).not.toThrow();
  });
});

/**
 * The worklet's input is whatever the sidechain's source delivers — one channel
 * for a mono file, two for stereo, more for a surround one. The export decodes
 * the sidechain `-ac 1` (the mean of its channels), so the preview must listen to
 * every channel and take the same mean: reading channel 0 alone left a voice
 * recorded or panned to the RIGHT inaudible to the duck, and ducked a voice that
 * sat in both channels no differently from one in the left.
 */
describe("sidechain worklet — which channels it listens to", () => {
  const Processor = loadProcessor();
  const SECONDS = 1.5;
  const total = quanta(SECONDS) * QUANTUM;

  const tone = (): Float32Array => {
    const x = new Float32Array(total);
    for (let i = 0; i < total; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 180 * i) / SR);
    return x;
  };
  const scaled = (x: Float32Array, k: number): Float32Array => x.map((v) => v * k);

  /** Feed per-channel signals (one Float32Array per channel) through a fresh processor. */
  function runChannels(channels: Float32Array[]): Float32Array {
    const proc = new Processor();
    const out = new Float32Array(total);
    for (let q = 0; q < total / QUANTUM; q++) {
      const input = channels.map((ch) => ch.slice(q * QUANTUM, (q + 1) * QUANTUM));
      const buf = new Float32Array(QUANTUM).fill(-7);
      expect(proc.process([input], [[buf]], params)).toBe(true);
      out.set(buf, q * QUANTUM);
    }
    return out;
  }

  const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

  it("ducks for a voice that is only in the RIGHT channel", () => {
    const x = tone();
    const right = runChannels([new Float32Array(total), x]);
    expect(right[right.length - 1]).toBeLessThan(0.7);
    // …exactly as the export's mono mix of it (the mean) would.
    expect(maxDiff(right, duckGainCurve(scaled(x, 0.5), duck, SR))).toBeLessThan(1e-6);
  });

  it("a voice in the left channel only ducks the same as the same voice in the right", () => {
    const x = tone();
    const left = runChannels([x, new Float32Array(total)]);
    const right = runChannels([new Float32Array(total), x]);
    expect(maxDiff(left, right)).toBeLessThan(1e-7);
  });

  it("a voice in both channels is the mono voice — the export's -ac 1 of identical channels", () => {
    const x = tone();
    expect(maxDiff(runChannels([x, x]), runChannels([x]))).toBeLessThan(1e-6);
    expect(maxDiff(runChannels([x, x]), duckGainCurve(x, duck, SR))).toBeLessThan(1e-6);
  });

  it("is the mean of every channel, however many there are", () => {
    const x = tone();
    const z = new Float32Array(total);
    // 5.1-style: the voice in one channel of six → a sixth of its level.
    expect(maxDiff(runChannels([z, z, x, z, z, z]), duckGainCurve(scaled(x, 1 / 6), duck, SR))).toBeLessThan(1e-6);
  });

  it("channels that cancel in a mono mix cancel here too (what the export hears)", () => {
    const x = tone();
    const out = runChannels([x, scaled(x, -1)]);
    for (const g of out) expect(g).toBeCloseTo(1, 6);
  });

  it("silent channels are still silence: full level, every sample written", () => {
    const z = new Float32Array(total);
    const out = runChannels([z, z]);
    for (const g of out) expect(g).toBeCloseTo(1, 6);
  });

  it("a stereo sidechain that stops delivering channels returns to full level", () => {
    const proc = new Processor();
    const x = tone();
    const stereo = (q: number) => [x.slice(q * QUANTUM, (q + 1) * QUANTUM), x.slice(q * QUANTUM, (q + 1) * QUANTUM)];
    let g = 0;
    for (let q = 0; q < quanta(1.5); q++) {
      const buf = new Float32Array(QUANTUM).fill(-7);
      proc.process([stereo(q % (total / QUANTUM))], [[buf]], params);
      g = buf[QUANTUM - 1];
    }
    expect(g).toBeLessThan(0.45);
    let firstBad = -1;
    for (let q = 0; q < quanta(20); q++) {
      const buf = new Float32Array(QUANTUM).fill(-7);
      proc.process([[]], [[buf]], params);
      g = buf[QUANTUM - 1];
      const i = firstNonPositive(buf);
      if (firstBad < 0 && i >= 0) firstBad = q * QUANTUM + i;
    }
    expect(firstBad, "every sample written and above zero: index of the first that is not").toBe(-1);
    expect(g).toBeCloseTo(1, 3);
  });
});
