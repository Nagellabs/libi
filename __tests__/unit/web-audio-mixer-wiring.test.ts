/**
 * Mock the Web Audio API minimally and assert attachDuckGraph builds
 * the expected node graph: MediaElementSource(music) →
 * GainNode → destination, MediaElementSource(sidechain) → AudioWorklet
 * AND → destination, AudioWorklet → GainNode.gain.
 *
 * Doesn't exercise actual audio — that's the smoke step in Task 4.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { from: string; to: string }[] = [];
const setValueAtTimeMock = vi.fn();

class FakeNode {
  constructor(public kind: string) {}
  connect(target: unknown): unknown {
    const toKind = target instanceof FakeNode ? target.kind : "param";
    calls.push({ from: this.kind, to: toKind });
    return target;
  }
  disconnect(): void {}
}
class FakeGain extends FakeNode {
  gain = { value: 1, setValueAtTime: setValueAtTimeMock } as unknown as AudioParam;
  constructor() { super("gain"); }
}
class FakeWorklet extends FakeNode {
  parameters = new Map<string, { setValueAtTime: (v: number, w: number) => void }>([
    ["thresholdLinear", { setValueAtTime: setValueAtTimeMock }],
    ["ratio",           { setValueAtTime: setValueAtTimeMock }],
    ["attackCoeff",     { setValueAtTime: setValueAtTimeMock }],
    ["releaseCoeff",    { setValueAtTime: setValueAtTimeMock }],
    ["reductionMin",    { setValueAtTime: setValueAtTimeMock }],
  ]);
  constructor() { super("worklet"); }
}

beforeEach(() => {
  calls.length = 0;
  setValueAtTimeMock.mockReset();

  // Minimal AudioContext stub.
  vi.stubGlobal("AudioContext", class {
    state = "suspended";
    sampleRate = 48000;
    destination = new FakeNode("destination");
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    async resume() { this.state = "running"; }
    createMediaElementSource(el: HTMLAudioElement) {
      return new FakeNode(el.dataset.role ?? "media-element");
    }
    createGain() { return new FakeGain(); }
  });
  vi.stubGlobal("AudioWorkletNode", class extends FakeWorklet {
    constructor(_ctx: unknown, _name: string) { super(); }
  });
});

describe("attachDuckGraph", () => {
  it("wires MediaElementSource(music) → GainNode → destination, sidechain → worklet → GainNode.gain, sidechain → destination", async () => {
    const { attachDuckGraph } = await import("@/lib/audio/web-audio-mixer");
    const music = document.createElement("audio");
    music.dataset.role = "music";
    const sidechain = document.createElement("audio");
    sidechain.dataset.role = "sidechain";

    const graph = await attachDuckGraph(music, sidechain, {
      sidechainClipIds: ["vo"],
      thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12,
    });

    // Assert the connections we care about.
    expect(calls).toContainEqual({ from: "worklet", to: "param" });        // worklet → GainNode.gain
    expect(calls).toContainEqual({ from: "sidechain", to: "worklet" });    // sidechain → worklet input
    expect(calls).toContainEqual({ from: "sidechain", to: "destination" });
    expect(calls).toContainEqual({ from: "music", to: "gain" });
    expect(calls).toContainEqual({ from: "gain", to: "destination" });

    // applyDuckParams was invoked (5 setValueAtTime calls).
    expect(setValueAtTimeMock).toHaveBeenCalledTimes(5);

    graph.dispose();
  });
});
