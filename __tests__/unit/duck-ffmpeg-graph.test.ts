import { describe, it, expect } from "vitest";
import { buildAudioFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import type { AudioClip } from "@/lib/engine/types";

const clip = (overrides: Partial<AudioClip> = {}): AudioClip => ({
  id: "c",
  kind: "standalone",
  fileId: "f",
  startTime: 0,
  duration: 10,
  trimStart: 0,
  volume: 1,
  enabled: true,
  ...overrides,
});

describe("buildAudioFilterChain — duck", () => {
  it("emits sidechaincompress when a clip has duck settings", () => {
    const music = clip({
      id: "music",
      duck: {
        sidechainClipId: "vo",
        thresholdDb: -25,
        ratio: 6,
        attackMs: 40,
        releaseMs: 300,
        reductionDb: -12,
      },
    });
    const vo = clip({ id: "vo" });
    const inputIndex = new Map<string, number>([["music", 1], ["vo", 2]]);
    const { chain } = buildAudioFilterChain({
      keepBaseAudio: false,
      baseVolume: 1,
      clips: [music, vo],
      inputIndex,
      sceneDuration: 10,
    });
    expect(chain).toBeTruthy();
    // The music label should be passed through sidechaincompress, with the
    // sidechain coming from the VO label.
    expect(chain).toContain("sidechaincompress");
    expect(chain).toContain("threshold=");
    expect(chain).toContain("ratio=6");
    // ffmpeg expects SECONDS — so 40 ms → 0.040, 300 ms → 0.300.
    // Plain "attack=40" would mean 40 SECONDS on strict ffmpeg builds.
    expect(chain).toContain("attack=0.040");
    expect(chain).toContain("release=0.300");
    // amix preserves per-clip volume (normalize=0 prevents 1/N dip).
    expect(chain).toContain("normalize=0");
  });

  it("skips ducking when the sidechain clip doesn't exist in the inputs", () => {
    const music = clip({
      id: "music",
      duck: { sidechainClipId: "missing", thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 },
    });
    const inputIndex = new Map<string, number>([["music", 1]]);
    const { chain } = buildAudioFilterChain({
      keepBaseAudio: false,
      baseVolume: 1,
      clips: [music],
      inputIndex,
      sceneDuration: 10,
    });
    expect(chain).toBeTruthy();
    expect(chain).not.toContain("sidechaincompress");
  });

  it("does not emit sidechaincompress for clips without duck", () => {
    const a = clip({ id: "a" });
    const inputIndex = new Map<string, number>([["a", 1]]);
    const { chain } = buildAudioFilterChain({
      keepBaseAudio: false,
      baseVolume: 1,
      clips: [a],
      inputIndex,
      sceneDuration: 10,
    });
    expect(chain).not.toContain("sidechaincompress");
  });
});

describe("buildAudioFilterChain — dB→linear conversion", () => {
  it("-20 dB threshold serializes as ~0.1 linear", () => {
    const music = clip({
      id: "music",
      duck: { sidechainClipId: "vo", thresholdDb: -20, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 },
    });
    const vo = clip({ id: "vo" });
    const inputIndex = new Map<string, number>([["music", 1], ["vo", 2]]);
    const { chain } = buildAudioFilterChain({
      keepBaseAudio: false, baseVolume: 1, clips: [music, vo], inputIndex, sceneDuration: 10,
    });
    // Find threshold=N in the chain
    const m = chain!.match(/threshold=([0-9.]+)/);
    expect(m).toBeTruthy();
    expect(parseFloat(m![1])).toBeCloseTo(0.1, 3);
  });

  it("0 dB threshold serializes as ~1.0", () => {
    const music = clip({
      id: "music",
      duck: { sidechainClipId: "vo", thresholdDb: 0, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 },
    });
    const vo = clip({ id: "vo" });
    const inputIndex = new Map<string, number>([["music", 1], ["vo", 2]]);
    const { chain } = buildAudioFilterChain({
      keepBaseAudio: false, baseVolume: 1, clips: [music, vo], inputIndex, sceneDuration: 10,
    });
    const m = chain!.match(/threshold=([0-9.]+)/);
    expect(parseFloat(m![1])).toBeCloseTo(1, 3);
  });

  it("makeup gain comes from the inverse of reductionDb", () => {
    const music = clip({
      id: "music",
      duck: { sidechainClipId: "vo", thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 },
    });
    const vo = clip({ id: "vo" });
    const inputIndex = new Map<string, number>([["music", 1], ["vo", 2]]);
    const { chain } = buildAudioFilterChain({
      keepBaseAudio: false, baseVolume: 1, clips: [music, vo], inputIndex, sceneDuration: 10,
    });
    expect(chain).toMatch(/makeup=12/);
  });
});
