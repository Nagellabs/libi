import { describe, it, expect } from "vitest";
import { buildAudioFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import { ENVELOPE_SAMPLE_RATE } from "@/lib/export/duck-envelopes";
import type { AudioClip, DuckSettings } from "@/lib/engine/types";

/**
 * The ffmpeg-overlay backend's audio adapter, on the duck path.
 *
 * This file used to assert the shape of a `sidechaincompress` filter — right
 * down to a case named "makeup gain comes from the inverse of reductionDb"
 * expecting `makeup=12`, which locked in the bug that amplified every ducked
 * mix 12x. The duck is no longer re-derived by ffmpeg at all: the preview's own
 * gain curve is rendered to a track and multiplied in. The curve's arithmetic
 * is covered by `duck-law-parity.test.ts`; what belongs here is only that the
 * graph wires the envelope up correctly.
 */

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

const DUCK: DuckSettings = {
  sidechainClipIds: ["vo"],
  thresholdDb: -25,
  ratio: 6,
  attackMs: 40,
  releaseMs: 300,
  reductionDb: -12,
};

function build(clips: AudioClip[], inputIndex: Map<string, number>, envelopeIndex?: Map<string, number>) {
  return buildAudioFilterChain({
    keepBaseAudio: false,
    baseVolume: 1,
    clips,
    inputIndex,
    envelopeIndex,
    sceneDuration: 10,
  });
}

describe("buildAudioFilterChain — duck", () => {
  const music = clip({ id: "music", duck: DUCK });
  const vo = clip({ id: "vo" });
  const inputIndex = new Map<string, number>([["music", 1], ["vo", 2]]);

  it("multiplies the ducked clip by its rendered envelope", () => {
    const { chain } = build([music, vo], inputIndex, new Map([["music", 3]]));
    expect(chain).toBeTruthy();
    expect(chain).toContain("amultiply");
    expect(chain).toContain("[3:a]pan=stereo|c0=c0|c1=c0");
  });

  it("never emits sidechaincompress — the duck is not re-derived by ffmpeg", () => {
    const { chain } = build([music, vo], inputIndex, new Map([["music", 3]]));
    expect(chain).not.toContain("sidechaincompress");
    expect(chain).not.toContain("makeup");
  });

  it("pins both multiply inputs to the envelope's rate and to stereo", () => {
    const { chain } = build([music, vo], inputIndex, new Map([["music", 3]]));
    expect(chain).toContain(`sample_rates=${ENVELOPE_SAMPLE_RATE}`);
    expect(chain).toContain("channel_layouts=stereo");
  });

  it("mixes the clip UNDUCKED when its envelope is missing, rather than failing", () => {
    const { chain } = build([music, vo], inputIndex);
    expect(chain).toBeTruthy();
    expect(chain).not.toContain("amultiply");
    expect(chain).toContain("[aout]");
  });

  it("does not touch clips without duck settings", () => {
    const plain = clip({ id: "plain" });
    const { chain } = build([plain], new Map([["plain", 1]]));
    expect(chain).not.toContain("amultiply");
    expect(chain).not.toContain("sidechaincompress");
  });

  it("still mixes both clips — the sidechain plays normally in its own right", () => {
    const { chain } = build([music, vo], inputIndex, new Map([["music", 3]]));
    expect(chain).toContain("[1:a]atrim");
    expect(chain).toContain("[2:a]atrim");
    expect(chain).toContain("amix=inputs=2");
  });
});
