import { describe, it, expect } from "vitest";
import { ENVELOPE_SAMPLE_RATE } from "@/lib/export/duck-envelopes";
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
    expect(chain).toContain("[1:a]aresample=async=1:first_pts=0,atrim=3.5:7.5");
  });

  it("trimStart 0 keeps the legacy atrim=0:duration form (back-compat)", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a", trimStart: 0, duration: 10 })],
      inputIndex: new Map([["a", 1]]),
    });
    expect(chain).toContain("[1:a]aresample=async=1:first_pts=0,atrim=0:10");
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
    // amix feeds the peak guard, then an intermediate [apre] label, then
    // resamples to [aout].
    expect(longest).toContain("amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=");
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
    expect(chain).toContain("[0:a]aresample=async=1:first_pts=0,volume=0.8[a_base]");
    expect(chain).toContain("amix=inputs=2");
  });

  it("base audio alone (no clips) promotes [0:a] through the resample stage to [aout]", () => {
    const { chain } = buildAudioMixGraph({
      baseAudio: { volume: 1 },
      clips: [],
      inputIndex: new Map(),
    });
    expect(chain).toBe("[0:a]aresample=async=1:first_pts=0,volume=1[apre];[apre]aresample=async=1[aout]");
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
      duck: { sidechainClipIds: ["vo"], thresholdDb: -20, ratio: 6, attackMs: 40, releaseMs: 300, reductionDb: -12 },
    });
    const vo = clip({ id: "vo" });
    const inputIndex = new Map([["music", 1], ["vo", 2]]);

    // The duck is applied by MULTIPLYING a pre-rendered gain curve, not by
    // asking ffmpeg's compressor to re-derive it. See lib/audio/duck-law.ts —
    // sidechaincompress ducked 5.2 dB less than the preview on real material.
    const envelopeIndex = new Map([["music", 3]]);

    it("multiplies the ducked clip by its envelope input", () => {
      const { chain } = buildAudioMixGraph({ clips: [duckClip, vo], inputIndex, envelopeIndex });
      expect(chain).toContain("amultiply");
      expect(chain).toContain("[3:a]pan=stereo|c0=c0|c1=c0");
      expect(chain).not.toContain("sidechaincompress");
    });

    it("pins both amultiply inputs to one rate and layout", () => {
      // amultiply requires identical rate + layout on both sides.
      const { chain } = buildAudioMixGraph({ clips: [duckClip, vo], inputIndex, envelopeIndex });
      const fmts = [...chain!.matchAll(/aformat=sample_fmts=fltp:sample_rates=(\d+)/g)].map((m) => m[1]);
      expect(fmts.length).toBeGreaterThanOrEqual(1);
      for (const rate of fmts) expect(Number(rate)).toBe(ENVELOPE_SAMPLE_RATE);
      expect(chain).toContain("channel_layouts=stereo");
    });

    it("uses pan for the envelope, never an implicit mono upmix", () => {
      // ffmpeg's mono->stereo conversion applies 0.7071x (-3 dB), which would
      // quietly attenuate every ducked clip. `pan` duplicates at unity.
      const { chain } = buildAudioMixGraph({ clips: [duckClip, vo], inputIndex, envelopeIndex });
      expect(chain).toMatch(/\[3:a\]pan=stereo\|c0=c0\|c1=c0/);
    });

    it("mixes the clip UNDUCKED when no envelope was rendered for it", () => {
      // A missing envelope degrades the mix; it must not break the export.
      const { chain } = buildAudioMixGraph({ clips: [duckClip, vo], inputIndex });
      expect(chain).not.toContain("amultiply");
      expect(chain).not.toContain("sidechaincompress");
      expect(chain).toContain("[aout]");
    });

    it("leaves undicked clips untouched", () => {
      const { chain } = buildAudioMixGraph({ clips: [vo], inputIndex: new Map([["vo", 1]]) });
      expect(chain).not.toContain("amultiply");
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
      expect(chain).toContain("[1:a]aresample=async=1:first_pts=0,atrim=0.5:3.5");
      expect(chain).toContain("adelay=2000|2000");
      expect(chain).toContain("[aout]");
    });
  });
});

describe("buildRenderMuxArgs", () => {
  it("stream-copies video, attaches the mixed audio, codec by container (mp4→aac)", () => {
    const args = buildRenderMuxArgs({
      inputPaths: ["/tmp/out.mp4", "/s/clip.mp3"],
      audioChain: "[1:a]aresample=async=1:first_pts=0,atrim=0:10,asetpts=PTS-STARTPTS,volume=1[aout]",
      format: "mp4",
      audioBitrate: 256000,
      outPath: "/tmp/out-audio.mp4",
    });
    const j = args.join(" ");
    expect(j).toContain("-i /tmp/out.mp4");
    expect(j).toContain("-i /s/clip.mp3");
    expect(j).toContain("-filter_complex [1:a]aresample=async=1:first_pts=0,atrim=0:10,asetpts=PTS-STARTPTS,volume=1[aout]");
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
      audioChain: "[1:a]aresample=async=1:first_pts=0,volume=1[aout]",
      format: "webm",
      outPath: "/tmp/out-audio.webm",
    });
    const j = args.join(" ");
    expect(j).toContain("-c:a libopus");
    expect(j).not.toContain("faststart");
    // Opus default, NOT the AAC one: libopus rejects >256k on a mono source.
    expect(j).toContain("-b:a 256000");
  });

  it("defaults mp4 (aac) to 320k when no bitrate is passed", () => {
    const args = buildRenderMuxArgs({
      inputPaths: ["/tmp/out.mp4", "/s/clip.mp3"],
      audioChain: "[1:a]aresample=async=1:first_pts=0,volume=1[aout]",
      format: "mp4",
      outPath: "/tmp/out-audio.mp4",
    });
    expect(args.join(" ")).toContain("-b:a 320000");
  });
});

describe("single-clip mixes keep their duck", () => {
  // The solo branch (amix of one input is a no-op) used to emit only the FIRST
  // chain segment. A ducked clip emits four, so a composition with exactly one
  // clip in the mix silently lost its duck. Caught by the render-based test.
  const soloClip = {
    id: "music",
    kind: "standalone",
    fileId: "f",
    startTime: 0,
    duration: 10,
    trimStart: 0,
    volume: 1,
    enabled: true,
    duck: {
      sidechainClipIds: ["vo"],
      thresholdDb: -30,
      ratio: 4,
      attackMs: 50,
      releaseMs: 250,
      reductionDb: -12,
    },
  } as unknown as AudioClip;

  it("still multiplies by the envelope with only one clip in the mix", () => {
    const { chain } = buildAudioMixGraph({
      clips: [soloClip],
      inputIndex: new Map([["music", 1]]),
      envelopeIndex: new Map([["music", 2]]),
    });
    expect(chain).toContain("amultiply");
    expect(chain).toContain("[2:a]pan=stereo|c0=c0|c1=c0");
    expect(chain).toContain("[aout]");
    expect(chain).not.toContain("amix");
  });

  it("keeps every stage of the chain, not just the first", () => {
    const { chain } = buildAudioMixGraph({
      clips: [soloClip],
      inputIndex: new Map([["music", 1]]),
      envelopeIndex: new Map([["music", 2]]),
    });
    // pre-stage, format, envelope, amultiply, resample
    expect(chain!.split(";").length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * Channel layout. amix negotiates ONE format for all of its inputs and takes
 * the first input's layout and rate, so a mono narration listed first turned
 * the whole export mono (the Dreams / Ocean Spray pieces: a stereo clip and a
 * stereo music bed came out 44.1 kHz mono). ffmpeg's implicit mono→stereo
 * upmix is -3 dB per side, whereas the preview (Web Audio "speakers") copies a
 * mono source to both sides at unity — so a mono input is upmixed with an
 * explicit unity pan, never left to an auto-inserted aresample.
 * docs-local/qa/2026-09-25-dreams-audio-report.md (Fix round 1)
 */
describe("buildAudioMixGraph channel layout", () => {
  const UNITY_UPMIX = "pan=stereo|c0=c0|c1=c0";
  const PIN_STEREO = "aformat=channel_layouts=stereo";

  it("mono narration first + stereo music: both inputs reach amix as stereo", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "vo" }), clip({ id: "music", volume: 0.32 })],
      inputIndex: new Map([["vo", 1], ["music", 2]]),
      inputChannels: new Map([[1, 1], [2, 2]]),
      mixDuration: "longest",
    });
    expect(chain).toMatch(/\[1:a\]aresample=async=1:first_pts=0,atrim=[^;]*,pan=stereo\|c0=c0\|c1=c0\[a_c0\]/);
    expect(chain).toMatch(/\[2:a\]aresample=async=1:first_pts=0,atrim=[^;]*,aformat=channel_layouts=stereo\[a_c1\]/);
  });

  it("upmixes a mono base track when a clip is stereo", () => {
    const { chain } = buildAudioMixGraph({
      baseAudio: { volume: 1 },
      clips: [clip({ id: "music" })],
      inputIndex: new Map([["music", 1]]),
      inputChannels: new Map([[0, 1], [1, 2]]),
    });
    expect(chain).toContain(`[0:a]aresample=async=1:first_pts=0,volume=1,${UNITY_UPMIX}[a_base]`);
  });

  it("treats an unknown channel count as possibly stereo: the mix is pinned stereo", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "vo" }), clip({ id: "x" })],
      inputIndex: new Map([["vo", 1], ["x", 2]]),
      inputChannels: new Map([[1, 1]]), // input 2's probe failed
    });
    expect(chain).toMatch(/\[1:a\][^;]*pan=stereo\|c0=c0\|c1=c0\[a_c0\]/);
    // Unknown: a filter that is right for BOTH mono (FC → both sides at
    // unity) and stereo (FL/FR through) — never aformat, whose mono upmix is
    // -3 dB (Review M4). Rendered with real ffmpeg in
    // export-audio-stereo-mix.test.ts.
    expect(chain).toMatch(/\[2:a\][^;]*pan=stereo\|FL=FL\+FC\|FR=FR\+FC\[a_c1\]/);
    expect(chain).not.toMatch(/\[2:a\][^;]*aformat=channel_layouts=stereo\[a_c1\]/);
  });

  it("an all-mono mix stays mono and untouched", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a" }), clip({ id: "b" })],
      inputIndex: new Map([["a", 1], ["b", 2]]),
      inputChannels: new Map([[1, 1], [2, 1]]),
    });
    expect(chain).not.toContain("pan=");
    expect(chain).not.toContain(PIN_STEREO);
  });

  it("a ducked clip makes the mix stereo (its multiply stage is stereo), so a mono sibling is upmixed", () => {
    const { chain } = buildAudioMixGraph({
      clips: [
        clip({ id: "vo" }),
        clip({ id: "music", duck: { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 } } as Partial<AudioClip>),
      ],
      inputIndex: new Map([["vo", 1], ["music", 2]]),
      envelopeIndex: new Map([["music", 3]]),
      inputChannels: new Map([[1, 1], [2, 1]]),
    });
    expect(chain).toMatch(/\[1:a\][^;]*pan=stereo\|c0=c0\|c1=c0\[a_c0\]/);
    // The mono music is upmixed at unity BEFORE the duck's stereo aformat.
    expect(chain).toMatch(/\[2:a\][^;]*pan=stereo\|c0=c0\|c1=c0\[a_c1_pre\]/);
  });

  it("without channel info the graph is unchanged (callers that don't probe)", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a" }), clip({ id: "b" })],
      inputIndex: new Map([["a", 1], ["b", 2]]),
    });
    expect(chain).not.toContain("pan=");
    expect(chain).not.toContain(PIN_STEREO);
  });
});

/**
 * Peak guard (Review M3). amix runs with normalize=0 so each clip keeps the
 * level the preview plays it at, which means a sum can pass full scale. Now
 * that mono narration sits at unity on both sides of a stereo mix, that is
 * more likely. So a lookahead limiter at FULL SCALE (limit=1) follows amix.
 * It has no auto-level (level=0) and its delay is compensated (latency=1).
 * Anything that doesn't pass full scale, a lone loud source included, is
 * bit-transparent (Re-review R2); only a real summing overload is capped.
 * Rendered with real ffmpeg in export-audio-stereo-mix.test.ts. It isn't added
 * when there is one input, because clip volume is capped at 1.
 */
describe("buildAudioMixGraph peak guard", () => {
  it("follows amix with a full-scale limiter", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ id: "a" }), clip({ id: "b" })],
      inputIndex: new Map([["a", 1], ["b", 2]]),
    });
    expect(chain).toMatch(/amix=[^;]*,alimiter=limit=1:attack=5:release=50:level=0:latency=1\[apre\]/);
    expect(chain!.endsWith("[apre]aresample=async=1[aout]")).toBe(true);
  });

  it("a single input gets no limiter", () => {
    const { chain } = buildAudioMixGraph({ clips: [clip({ id: "a" })], inputIndex: new Map([["a", 1]]) });
    expect(chain).not.toContain("alimiter");
  });
});

describe("buildAudioMixGraph audio stream selection (Review M6)", () => {
  it("reads each input's primary audio stream by index, and [n:a] when it is unknown", () => {
    const { chain } = buildAudioMixGraph({
      baseAudio: { volume: 1 },
      clips: [clip({ id: "a" }), clip({ id: "b" })],
      inputIndex: new Map([["a", 1], ["b", 2]]),
      inputAudioStream: new Map([[0, 2], [1, 3]]),
    });
    expect(chain).toContain("[0:2]aresample=async=1:first_pts=0,volume=1");
    expect(chain).toContain("[1:3]aresample=async=1:first_pts=0,atrim=");
    expect(chain).toContain("[2:a]aresample=async=1:first_pts=0,atrim=");
  });
});

// A track that starts after its file (docs-local/qa/2026-09-25-mediabunny-upgrade-report.md,
// Export lead fix). Rendered with real ffmpeg in export-source-lead.test.ts.
describe("buildAudioMixGraph keeps a late track's lead", () => {
  it("pads every clip onto its file's timeline before trimming it", () => {
    const { chain } = buildAudioMixGraph({ clips: [clip({ trimStart: 0.2, duration: 2 })], inputIndex: new Map([["c", 1]]) });
    expect(chain).toContain("[1:a]aresample=async=1:first_pts=0,atrim=0.2:2.2,asetpts=PTS-STARTPTS");
  });
  it("pads the base audio, and cuts what the input seek didn't", () => {
    const seeked = buildAudioMixGraph({ baseAudio: { volume: 1 }, clips: [], inputIndex: new Map() }).chain!;
    expect(seeked).toContain("[0:a]aresample=async=1:first_pts=0,volume=1");
    const unseeked = buildAudioMixGraph({ baseAudio: { volume: 1, trimStart: 0.2 }, clips: [], inputIndex: new Map() }).chain!;
    expect(unseeked).toContain("[0:a]atrim=start=0.2,asetpts=PTS-round(0.2/TB),aresample=async=1:first_pts=0,volume=1");
  });
});

// Review round 3: an input ffmpeg reads off its file's timeline (an Ogg or
// MPEG-TS read for its audio alone, a FLAC-in-MP4 cut): its timestamps are
// moved before the pad. Rendered with real ffmpeg in export-source-lead.test.ts.
describe("buildAudioMixGraph: an input read through its probe's fix", () => {
  it("moves the clip input's timestamps before padding it onto its file's timeline", () => {
    const { chain } = buildAudioMixGraph({
      clips: [clip({ trimStart: 0.2, duration: 2 })], inputIndex: new Map([["c", 1]]), inputPtsShift: new Map([[1, 0.4]]),
    });
    expect(chain).toContain("[1:a]asetpts=PTS+round(0.4/TB),aresample=async=1:first_pts=0,atrim=0.2:2.2");
    const back = buildAudioMixGraph({ clips: [clip()], inputIndex: new Map([["c", 1]]), inputPtsShift: new Map([[1, -0.425333]]) }).chain!;
    expect(back).toContain("[1:a]asetpts=PTS-round(0.425333/TB),aresample=async=1:first_pts=0,atrim=");
  });
});
