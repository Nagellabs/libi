import { describe, it, expect } from "vitest";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import { buildRenderMuxArgs } from "@/lib/export/render-audio-mux";
import type { AudioClip } from "@/lib/engine/types";

const clip = (o: Partial<AudioClip> = {}): AudioClip => ({
  id: "c",
  kind: "standalone",
  fileId: "f",
  startTime: 0,
  duration: 10,
  trimStart: 0,
  volume: 1,
  enabled: true,
  ...o,
});

describe("buildAudioMixGraph", () => {
  it("returns null when there is nothing to mix", () => {
    expect(buildAudioMixGraph({ clips: [], inputIndex: new Map() }).chain).toBeNull();
  });

  it("honours trimStart: atrim window is [trimStart, trimStart+duration]", () => {
    const c = clip({ id: "a", trimStart: 3.5, duration: 4 });
    const { chain } = buildAudioMixGraph({
      clips: [c],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("[1:a]atrim=3.5:7.5");
  });

  it("trimStart 0 keeps the legacy atrim=0:duration form (back-compat)", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a", trimStart: 0, duration: 10 })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("[1:a]atrim=0:10");
  });

  it("delays a clip by startTime via adelay (ms, both channels)", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a", startTime: 2.5 })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("adelay=2500|2500");
  });

  it("omits adelay when startTime is 0", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a", startTime: 0 })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).not.toContain("adelay");
  });

  it("applies per-clip volume", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a", volume: 0.4 })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("volume=0.4");
  });

  it("single clip promotes through the resample stage to [aout] (no amix)", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a" })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("[aout]");
    expect(chain).not.toContain("amix");
    // Even the solo path terminates with the timestamp-cleaning resample.
    expect(chain).toContain("aresample=async=1[aout]");
  });

  it("two clips amix with normalize=0 and the requested duration policy", () => {
    const inputIndex = new Map([["a", 1], ["b", 2]]);
    const longest = buildAudioMixGraph({
      clips: [clip({ id: "a" }), clip({ id: "b", startTime: 5 })],
      inputIndex,
      mixDuration: "longest",
    }).chain!;
    // amix now feeds an intermediate [apre] label, then resamples to [aout].
    expect(longest).toContain("amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[apre]");
    expect(longest).toContain("[apre]aresample=async=1[aout]");

    const first = buildAudioMixGraph({
      clips: [clip({ id: "a" }), clip({ id: "b" })],
      inputIndex,
      mixDuration: "first",
    }).chain!;
    expect(first).toContain("duration=first");
  });

  it("ALWAYS terminates with aresample=async=1[aout] (guards the non-zero-trimStart + adelay + amix DTS-poison bug → ffmpeg exit -22)", () => {
    // The real-world repro: clip A trimmed into the source (atrim=19.56:…) and
    // delayed onto the timeline, mixed with an at-zero clip B. Without the final
    // aresample, amix emits a near-INT64_MAX DTS that aborts the AAC mux.
    const a = clip({ id: "a", trimStart: 19.56, duration: 41.94, startTime: 15.009 });
    const b = clip({ id: "b", trimStart: 0, duration: 15.009, startTime: 0 });
    const { chain } = buildAudioMixGraph({
      clips: [a, b],
      inputIndex: new Map([["a", 1], ["b", 2]]),
      mixDuration: "longest",
    });
    expect(chain).not.toBeNull();
    expect(chain!.endsWith("aresample=async=1[aout]")).toBe(true);
  });

  it("includes base audio as [0:a] when provided", () => {
    const { chain } = buildAudioMixGraph({
      baseAudio: { volume: 0.8 },
      clips: [clip({ id: "a" })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("[0:a]volume=0.8[a_base]");
    expect(chain).toContain("amix=inputs=2");
  });

  it("base audio alone (no clips) promotes [0:a] through the resample stage to [aout]", () => {
    const { chain } = buildAudioMixGraph({
      baseAudio: { volume: 1 },
      clips: [],
      inputIndex: new Map(),
    });
    expect(chain).toBe("[0:a]volume=1[apre];[apre]aresample=async=1[aout]");
  });

  it("skips a clip whose input index is unknown", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "present" }), clip({ id: "absent" })],
      inputIndex: new Map([["present", 1]]),
    });
    // only one usable input -> promoted to [aout], no amix
    expect(chain).toContain("[aout]");
    expect(chain).not.toContain("amix");
  });

  describe("ducking", () => {
    const duckClip = clip({
      id: "music",
      duck: { sidechainClipId: "vo", thresholdDb: -20, ratio: 6, attackMs: 40, releaseMs: 300, reductionDb: -12 },
    });
    const vo = clip({ id: "vo" });
    const inputIndex = new Map([["music", 1], ["vo", 2]]);

    it("emits sidechaincompress driven by the sidechain input", () => {
      const { chain } = buildAudioMixGraph({ clips: [duckClip, vo], inputIndex });
      expect(chain).toContain("[2:a]sidechaincompress=");
      expect(chain).toContain("ratio=6");
      expect(chain).toContain("attack=0.040");
      expect(chain).toContain("release=0.300");
      expect(chain).toMatch(/makeup=12/);
    });

    it("dB threshold → linear (-20 dB ≈ 0.1)", () => {
      const { chain } = buildAudioMixGraph({ clips: [duckClip, vo], inputIndex });
      const m = chain!.match(/threshold=([0-9.]+)/);
      expect(parseFloat(m![1])).toBeCloseTo(0.1, 3);
    });

    it("skips ducking when the sidechain clip isn't an input", () => {
      const orphan = clip({ id: "music", duck: { sidechainClipId: "missing", thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 } });
      const { chain } = buildAudioMixGraph({ clips: [orphan], inputIndex: new Map([["music", 1]]) });
      expect(chain).not.toContain("sidechaincompress");
    });

    it("includes a clip linked only to a video overlay (linkedOverlayId)", () => {
      // Overlay-linked inline clips must mix exactly like any other enabled
      // clip — the graph builder doesn't look at linkedSceneId/linkedOverlayId.
      const overlayClip = clip({
        id: "ov",
        kind: "inline",
        linkedOverlayId: "vid-1",
        startTime: 2,
        trimStart: 0.5,
        duration: 3,
      });
      const { chain } = buildAudioMixGraph({
        clips: [overlayClip],
        inputIndex: new Map([["ov", 1]]),
      });
      expect(chain).toContain("[1:a]atrim=0.5:3.5");
      expect(chain).toContain("adelay=2000|2000");
      expect(chain).toContain("[aout]");
    });
  });
});

describe("buildRenderMuxArgs", () => {
  it("stream-copies video, attaches the mixed audio, codec by container (mp4→aac)", () => {
    const args = buildRenderMuxArgs({
      inputPaths: ["/tmp/out.mp4", "/s/clip.mp3"],
      audioChain: "[1:a]atrim=0:10,asetpts=PTS-STARTPTS,volume=1[aout]",
      format: "mp4",
      audioBitrate: 256000,
      outPath: "/tmp/out-audio.mp4",
    });
    const j = args.join(" ");
    expect(j).toContain("-i /tmp/out.mp4");
    expect(j).toContain("-i /s/clip.mp3");
    expect(j).toContain("-filter_complex [1:a]atrim=0:10,asetpts=PTS-STARTPTS,volume=1[aout]");
    expect(j).toContain("-map 0:v:0");
    expect(j).toContain("-map [aout]");
    expect(j).toContain("-c:v copy");
    expect(j).toContain("-c:a aac");
    expect(j).toContain("-b:a 256000");
    expect(j).toContain("-movflags +faststart");
    expect(args[args.length - 1]).toBe("/tmp/out-audio.mp4");
  });

  it("uses libopus + no faststart for webm", () => {
    const args = buildRenderMuxArgs({
      inputPaths: ["/tmp/out.webm", "/s/clip.ogg"],
      audioChain: "[1:a]volume=1[aout]",
      format: "webm",
      outPath: "/tmp/out-audio.webm",
    });
    const j = args.join(" ");
    expect(j).toContain("-c:a libopus");
    expect(j).not.toContain("faststart");
    expect(j).toContain("-b:a 192000"); // default bitrate
  });
});
