/**
 * WebAudioEngine sidechain-duck wiring. Mocks the Web Audio API + mediabunny
 * and asserts the duck graph the engine builds in setClips:
 *
 *   clipGain → duckGain(intrinsic 0) → master
 *   sidechainGain → worklet → duckGain.gain
 *
 * plus reconcile semantics: idempotent on unchanged params, teardown when the
 * duck is removed or the sidechain disappears (restoring gain → master).
 *
 * Real ducking audio (the compressor curve) is verified by ear with the user
 * and by the existing applyDuckParams math test — not here.
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
}));

interface Conn { from: string; to: string }
const conns: Conn[] = [];
let nodeSeq = 0;
let workletCount = 0;

class FakeNode {
  id: string;
  constructor(public kind: string) { this.id = `${kind}#${nodeSeq++}`; }
  connect(target: unknown): unknown {
    const to = target instanceof FakeNode ? target.id
      : (target as { _paramOf?: FakeNode })._paramOf ? `param:${(target as { _paramOf: FakeNode })._paramOf.id}` : "param";
    conns.push({ from: this.id, to });
    return target;
  }
  disconnect(target?: unknown): void {
    const to = target instanceof FakeNode ? target.id
      : target ? "param" : "*";
    conns.push({ from: this.id, to: `DISC:${to}` });
  }
}
class FakeGain extends FakeNode {
  gain: { value: number; setValueAtTime: () => void } & { _paramOf: FakeNode };
  constructor() {
    super("gain");
    this.gain = { value: 1, setValueAtTime: () => {}, _paramOf: this } as never;
  }
}
class FakeWorklet extends FakeNode {
  parameters = new Map([
    ["thresholdLinear", { setValueAtTime: () => {} }],
    ["ratio", { setValueAtTime: () => {} }],
    ["attackCoeff", { setValueAtTime: () => {} }],
    ["releaseCoeff", { setValueAtTime: () => {} }],
    ["reductionMin", { setValueAtTime: () => {} }],
  ]);
  constructor() { super("worklet"); workletCount++; }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  conns.length = 0;
  nodeSeq = 0;
  workletCount = 0;
  vi.stubGlobal("AudioContext", class {
    state = "running";
    sampleRate = 48000;
    currentTime = 0;
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
  return {
    id,
    fileId: `f-${id}`,
    kind: "standalone",
    startTime: 0,
    duration: 5,
    trimStart: 0,
    volume: 1,
    enabled: true,
    ...extra,
  } as AudioClip;
}

const DUCK = { sidechainClipId: "vo", thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 };

// Bracket access to private engine internals for white-box assertions.
type Internal = {
  master: FakeNode;
  clips: Map<string, { gain: FakeGain; duckGain: FakeGain | null; duckWorklet: FakeWorklet | null; duckSidechainGain: FakeGain | null; duckSig: string | null }>;
};

describe("WebAudioEngine sidechain ducking", () => {
  it("builds duckGain(0) ← worklet ← sidechain, and reroutes music → duckGain → master", async () => {
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const eng = new WebAudioEngine((fid) => `/${fid}`);
    const internal = eng as unknown as Internal;

    eng.setClips([clip("music", { duck: DUCK }), clip("vo")]);
    await tick();
    await tick();

    const music = internal.clips.get("music")!;
    const vo = internal.clips.get("vo")!;

    expect(music.duckGain).toBeTruthy();
    expect(music.duckGain!.gain.value).toBe(0); // worklet is the sole driver
    expect(music.duckWorklet).toBeTruthy();
    expect(music.duckSidechainGain).toBe(vo.gain);
    expect(music.duckSig).toContain("vo");
    expect(workletCount).toBe(1);

    // worklet → duckGain.gain (AudioParam)
    expect(conns).toContainEqual({ from: music.duckWorklet!.id, to: `param:${music.duckGain!.id}` });
    // sidechain gain → worklet input
    expect(conns).toContainEqual({ from: vo.gain.id, to: music.duckWorklet!.id });
    // music gain → duckGain → master
    expect(conns).toContainEqual({ from: music.gain.id, to: music.duckGain!.id });
    expect(conns).toContainEqual({ from: music.duckGain!.id, to: internal.master.id });
  });

  it("is idempotent — re-applying identical clips does not rebuild the worklet", async () => {
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const eng = new WebAudioEngine((fid) => `/${fid}`);
    eng.setClips([clip("music", { duck: DUCK }), clip("vo")]);
    await tick(); await tick();
    expect(workletCount).toBe(1);
    eng.setClips([clip("music", { duck: DUCK }), clip("vo")]);
    await tick(); await tick();
    expect(workletCount).toBe(1); // no rebuild
  });

  it("tears down the duck graph when the duck is removed, restoring gain → master", async () => {
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const eng = new WebAudioEngine((fid) => `/${fid}`);
    const internal = eng as unknown as Internal;
    eng.setClips([clip("music", { duck: DUCK }), clip("vo")]);
    await tick(); await tick();
    const music = internal.clips.get("music")!;
    const gainId = music.gain.id;

    conns.length = 0;
    eng.setClips([clip("music"), clip("vo")]); // duck removed
    await tick(); await tick();

    expect(music.duckGain).toBeNull();
    expect(music.duckWorklet).toBeNull();
    expect(music.duckSig).toBeNull();
    // gain reconnected directly to master
    expect(conns).toContainEqual({ from: gainId, to: internal.master.id });
  });

  it("tears down when the sidechain clip disappears", async () => {
    const { WebAudioEngine } = await import("@/lib/audio/web-audio-engine");
    const eng = new WebAudioEngine((fid) => `/${fid}`);
    const internal = eng as unknown as Internal;
    eng.setClips([clip("music", { duck: DUCK }), clip("vo")]);
    await tick(); await tick();
    expect(internal.clips.get("music")!.duckGain).toBeTruthy();

    eng.setClips([clip("music", { duck: DUCK })]); // vo gone
    await tick(); await tick();
    expect(internal.clips.get("music")!.duckGain).toBeNull();
  });
});
