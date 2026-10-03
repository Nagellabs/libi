/**
 * WebAudioEngine duck GRAPH integrity — the shapes that leave a ducked clip
 * routed through a duckGain nobody drives (intrinsic gain 0 = a muted clip),
 * checked against a Web Audio fake that tracks real edges (connect, and both
 * forms of disconnect), so a severed tap shows up as a missing edge.
 *
 * The worklet itself (silence in => full level out) is covered by
 * sidechain-worklet-silence.test.ts; this file is about the wiring around it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AudioClip } from "@/lib/engine/types";

vi.mock("mediabunny", () => ({
  Input: class { async getPrimaryAudioTrack() { return null; } dispose() {} },
  UrlSource: class {},
  AudioBufferSink: class {},
  ALL_FORMATS: [],
  Logging: { on: () => () => {} },
}));

let nodeSeq = 0;
let workletCount = 0;
let failNextWorklet = 0;
const worklets: FakeWorklet[] = [];

class FakeParam {
  value = 1;
  constructor(public owner: FakeNode) {}
  setValueAtTime() {}
  cancelScheduledValues() {}
  linearRampToValueAtTime() {}
}
class FakeNode {
  id: string;
  out = new Set<unknown>();
  constructor(public kind: string) { this.id = `${kind}#${nodeSeq++}`; }
  connect(target: unknown): unknown { this.out.add(target); return target; }
  disconnect(target?: unknown): void {
    if (target === undefined) this.out.clear();
    else this.out.delete(target);
  }
  feeds(target: unknown): boolean { return this.out.has(target); }
}
class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor() { super("gain"); this.gain = new FakeParam(this); }
}
class FakeWorklet extends FakeNode {
  parameters = new Map(
    ["thresholdLinear", "ratio", "attackCoeff", "releaseCoeff", "reductionMin"].map((n) => [n, { setValueAtTime: () => {} }]),
  );
  onprocessorerror: (() => void) | null = null;
  constructor() {
    super("worklet");
    if (failNextWorklet > 0) { failNextWorklet--; throw new Error("InvalidStateError"); }
    workletCount++;
    worklets.push(this);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  nodeSeq = 0; workletCount = 0; failNextWorklet = 0; worklets.length = 0;
  vi.stubGlobal("AudioContext", class {
    state = "running"; sampleRate = 48000; currentTime = 0;
    destination = new FakeNode("destination");
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    async resume() {}
    async close() {}
    createGain() { return new FakeGain(); }
    createBufferSource() { return new FakeNode("buffersource"); }
  });
  vi.stubGlobal("AudioWorkletNode", class extends FakeWorklet {
    constructor(_ctx: unknown, _name: string) { super(); }
  });
});

function clip(id: string, extra: Partial<AudioClip> = {}): AudioClip {
  return { id, fileId: `f-${id}`, kind: "standalone", startTime: 0, duration: 5, trimStart: 0, volume: 1, enabled: true, ...extra } as AudioClip;
}
const duck = (...ids: string[]) => ({ sidechainClipIds: ids, thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 });

type EC = { gain: FakeGain; duckGain: FakeGain | null; duckWorklet: FakeWorklet | null; duckSidechainGains: FakeGain[]; duckSig: string | null };
type Internal = { master: FakeNode; clips: Map<string, EC> };

async function engine() {
  const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
  const eng = new WebAudioEngine((fid) => `/${fid}`);
  return { eng, internal: eng as unknown as Internal };
}

/** A ducked clip is correctly wired: only route to master is through a driven duckGain. */
function expectDuckedWiring(internal: Internal, id: string, sidechainIds: string[]) {
  const ec = internal.clips.get(id)!;
  expect(ec.duckGain, `${id} has a duck stage`).toBeTruthy();
  expect(ec.gain.feeds(internal.master), `${id} must not also reach master directly`).toBe(false);
  expect(ec.gain.feeds(ec.duckGain)).toBe(true);
  expect(ec.duckGain!.feeds(internal.master)).toBe(true);
  expect(ec.duckWorklet!.feeds(ec.duckGain!.gain)).toBe(true);
  for (const sc of sidechainIds) expect(internal.clips.get(sc)!.gain.feeds(ec.duckWorklet), `${sc} taps ${id}'s worklet`).toBe(true);
}

describe("duck graph: several ducked clips", () => {
  it("two music clips ducked under one narration are each wired and each driven", async () => {
    const { eng, internal } = await engine();
    eng.setClips([clip("m1", { duck: duck("vo") }), clip("m2", { duck: duck("vo") }), clip("vo")]);
    await tick(); await tick();
    expect(workletCount).toBe(2);
    expectDuckedWiring(internal, "m1", ["vo"]);
    expectDuckedWiring(internal, "m2", ["vo"]);
    // The narration itself is never routed through a duck stage.
    expect(internal.clips.get("vo")!.gain.feeds(internal.master)).toBe(true);
  });

  it("a clip ducked under two sidechains keeps both taps when one of them goes away", async () => {
    const { eng, internal } = await engine();
    eng.setClips([clip("m", { duck: duck("vo1", "vo2") }), clip("vo1"), clip("vo2")]);
    await tick(); await tick();
    expectDuckedWiring(internal, "m", ["vo1", "vo2"]);
    eng.setClips([clip("m", { duck: duck("vo1", "vo2") }), clip("vo1")]);
    await tick(); await tick();
    expectDuckedWiring(internal, "m", ["vo1"]);
  });

  it("a duck whose every sidechain is gone is torn down to a plain gain → master route", async () => {
    const { eng, internal } = await engine();
    eng.setClips([clip("m", { duck: duck("vo") }), clip("vo")]);
    await tick(); await tick();
    eng.setClips([clip("m", { duck: duck("vo") })]);
    await tick(); await tick();
    const m = internal.clips.get("m")!;
    expect(m.duckGain).toBeNull();
    expect(m.gain.feeds(internal.master)).toBe(true);
  });

  it("a ducked clip that is itself a sidechain keeps the taps it feeds into other ducks", async () => {
    // a ducks under b, b ducks under c. `a` is reconciled FIRST, tapping b's
    // gain; b's own rebuild must not sever that tap with a bare disconnect().
    const { eng, internal } = await engine();
    eng.setClips([clip("a", { duck: duck("b") }), clip("b", { duck: duck("c") }), clip("c")]);
    await tick(); await tick(); await tick();
    expectDuckedWiring(internal, "a", ["b"]);
    expectDuckedWiring(internal, "b", ["c"]);
    // And again after b's duck is edited and rebuilt.
    eng.setClips([clip("a", { duck: duck("b") }), clip("b", { duck: { ...duck("c"), reductionDb: -6 } }), clip("c")]);
    await tick(); await tick(); await tick();
    expectDuckedWiring(internal, "a", ["b"]);
    expectDuckedWiring(internal, "b", ["c"]);
  });
});

describe("duck graph: rebuild races and failures", () => {
  it("overlapping setClips calls build ONE worklet per ducked clip", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("AudioContext", class {
      state = "running"; sampleRate = 48000; currentTime = 0;
      destination = new FakeNode("destination");
      audioWorklet = { addModule: () => gate };
      async resume() {}
      async close() {}
      createGain() { return new FakeGain(); }
      createBufferSource() { return new FakeNode("buffersource"); }
    });
    const { eng, internal } = await engine();
    const clips = [clip("m", { duck: duck("vo") }), clip("vo")];
    eng.setClips(clips);
    eng.setClips(clips);
    eng.setClips([clip("m", { duck: { ...duck("vo"), releaseMs: 400 } }), clip("vo")]);
    release();
    await tick(); await tick(); await tick();
    expect(workletCount).toBe(1);
    expectDuckedWiring(internal, "m", ["vo"]);
    // No orphan: the narration feeds exactly one worklet.
    const vo = internal.clips.get("vo")!;
    expect([...vo.gain.out].filter((t) => t instanceof FakeWorklet).length).toBe(1);
  });

  it("one clip's failed duck build does not strand the ducked clips after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      failNextWorklet = 1; // m1's AudioWorkletNode constructor throws
      const { eng, internal } = await engine();
      eng.setClips([clip("m1", { duck: duck("vo") }), clip("m2", { duck: duck("vo") }), clip("vo")]);
      await tick(); await tick();
      // m1 stays a plain, audible gain → master (un-ducked, NOT muted)...
      expect(internal.clips.get("m1")!.gain.feeds(internal.master)).toBe(true);
      expect(internal.clips.get("m1")!.duckGain).toBeNull();
      // ...and m2 still got its duck.
      expectDuckedWiring(internal, "m2", ["vo"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a worklet that dies (processorerror) is un-ducked, not left muting the clip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { eng, internal } = await engine();
      const clips = [clip("m", { duck: duck("vo") }), clip("vo")];
      eng.setClips(clips);
      await tick(); await tick();
      worklets[0].onprocessorerror!();
      const m = internal.clips.get("m")!;
      expect(m.duckGain).toBeNull();
      expect(m.gain.feeds(internal.master)).toBe(true);
      // The same duck is not rebuilt on the next reconcile (it would die again)…
      eng.setClips(clips);
      await tick(); await tick();
      expect(workletCount).toBe(1);
      expect(m.duckGain).toBeNull();
      // …but an edited duck gets a fresh worklet.
      eng.setClips([clip("m", { duck: { ...duck("vo"), reductionDb: -6 } }), clip("vo")]);
      await tick(); await tick();
      expect(workletCount).toBe(2);
      expectDuckedWiring(internal, "m", ["vo"]);
    } finally {
      warn.mockRestore();
    }
  });
});
