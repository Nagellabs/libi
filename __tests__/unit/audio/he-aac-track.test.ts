/**
 * HE-AAC tracks through mediabunny's real MP4 demuxer and real
 * `AudioSampleSink`, with WebCodecs replaced by fakes.
 *
 * The config fake behaves the way Electron 36 was measured to. A 1-channel
 * config for SBR on a mono core fails with `OperationError: Unsupported
 * configuration`; a wrong sample rate alone is tolerated, as it is in Chromium.
 * Measured in Electron 36.9.5 (Chrome 136) on macOS, 2026-09-25.
 *
 * With mediabunny 1.60 the only config that still arrives that way is SBR on a
 * mono core with no PS signalled (a mono-source HE-AAC v1 file): 1.60 reports
 * the SBR output rate, and 2 channels when PS is signalled, so the Dreams clip
 * (HE-AACv2) decodes stock. `repairHeAacTrack` fixes the remaining case and
 * leaves every other config untouched. The baseline below fails the day
 * mediabunny reports that case as 2 channels too; then the repair can go.
 *
 * The "decoder fails" cases pin that an error surfaces promptly through the
 * wrapped track. An earlier version registered a CustomAudioDecoder instead,
 * which in mediabunny 1.40 hung the sample iterator forever on any file of
 * more than ~40 packets, so neither the proxy fallback nor the toast fired.
 * docs-local/qa/2026-09-25-dreams-audio-report.md (Review I1, Fixes after review),
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Input, BufferSource, ALL_FORMATS, AudioSampleSink } from "mediabunny";
import { repairHeAacTrack } from "@/lib/audio/he-aac-track";

const FIXTURES = join(__dirname, "../../fixtures/audio");

/** Fixtures whose ASC signals SBR on a MONO core (keyed by the first bytes). */
const MONO_CORE_SBR_STREAMS = new Set(["eb8a08", "138856"]);

const configured: AudioDecoderConfig[] = [];

class FakeAudioData {
  format = "f32-planar" as const;
  constructor(
    public sampleRate: number,
    public numberOfChannels: number,
    public numberOfFrames: number,
    public timestamp: number,
  ) {}
  close() {}
}

class FakeEncodedAudioChunk {
  type: string;
  timestamp: number;
  duration: number;
  byteLength: number;
  constructor(init: { type: string; timestamp: number; duration: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.byteLength = init.data.byteLength;
  }
}

/**
 * Spec-shaped fake: work happens on a later task; `dequeue` events fire; an
 * error closes the decoder and is reported through the error callback.
 * `failAfter` outputs before a decode error (null = never); `outputs: false`
 * = a slow decoder that produces nothing before it fails.
 */
function makeFakeDecoder(
  opts: { failAfter: number | null; outputs?: boolean; strictSupport?: boolean } = { failAfter: null },
) {
  return class FakeAudioDecoder extends EventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    decodeQueueSize = 0;
    private produced = 0;
    private cfg: AudioDecoderConfig | null = null;
    constructor(private readonly init: { output: (d: FakeAudioData) => void; error: (e: Error) => void }) {
      super();
    }
    static async isConfigSupported(config: AudioDecoderConfig) {
      // Chromium (Electron 36, macOS) says yes either way. `strictSupport`
      // models a platform that refuses the unrepaired config up front
      // (Re-review R3): a 1-channel config for SBR on a mono core.
      if (opts.strictSupport) {
        const desc = config.description as Uint8Array | undefined;
        const key = desc ? Buffer.from(desc.slice(0, 3)).toString("hex") : "";
        if (MONO_CORE_SBR_STREAMS.has(key) && config.numberOfChannels !== 2) return { supported: false, config };
      }
      return { supported: true, config };
    }
    configure(config: AudioDecoderConfig) {
      configured.push(config);
      this.cfg = config;
      this.state = "configured";
      const desc = config.description as Uint8Array | undefined;
      const key = desc ? Buffer.from(desc.slice(0, 3)).toString("hex") : "";
      if (MONO_CORE_SBR_STREAMS.has(key) && config.numberOfChannels !== 2) {
        setTimeout(() => this.fail(new DOMException(
          "Unsupported configuration. Check isConfigSupported() prior to calling configure().",
          "OperationError",
        )), 0);
      }
      if (opts.outputs === false && opts.failAfter !== null) {
        setTimeout(() => this.fail(new DOMException("Decoding error.", "EncodingError")), 300);
      }
    }
    private fail(err: Error) {
      if (this.state !== "configured") return;
      this.state = "closed";
      this.decodeQueueSize = 0;
      this.dispatchEvent(new Event("dequeue"));
      this.init.error(err);
    }
    decode(chunk: FakeEncodedAudioChunk) {
      if (this.state !== "configured") throw new DOMException("closed", "InvalidStateError");
      this.decodeQueueSize++;
      if (opts.outputs === false) return;
      setTimeout(() => {
        if (this.state !== "configured") return;
        if (opts.failAfter !== null && this.produced >= opts.failAfter) {
          this.fail(new DOMException("Decoding error.", "EncodingError"));
          return;
        }
        this.decodeQueueSize--;
        this.produced++;
        this.dispatchEvent(new Event("dequeue"));
        this.init.output(new FakeAudioData(this.cfg!.sampleRate, this.cfg!.numberOfChannels, 2048, chunk.timestamp));
      }, 0);
    }
    async flush() {
      // Like a real decoder, flush resolves only after every queued decode has
      // produced its output (a fixed 2 ms wait raced the output timers on a
      // busy machine and ended the iterator with 0 samples). A decoder that
      // never outputs (`outputs: false`) is failed by its own timer.
      while (this.state === "configured" && this.decodeQueueSize > 0 && opts.outputs !== false) {
        await new Promise((r) => setTimeout(r, 1));
      }
      await new Promise((r) => setTimeout(r, 2));
      if (this.state === "closed") throw new DOMException("Aborted due to close()", "AbortError");
    }
    close() {
      this.state = "closed";
    }
  };
}

async function openTrack(fixture: string, repair: boolean) {
  const input = new Input({ source: new BufferSource(readFileSync(join(FIXTURES, fixture))), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("no audio track");
  if (repair) repairHeAacTrack(track);
  return { input, track };
}

async function decodeAll(fixture: string, repair = true) {
  const { input, track } = await openTrack(fixture, repair);
  const sink = new AudioSampleSink(track);
  let count = 0;
  let sampleRate = 0;
  let channels = 0;
  try {
    for await (const s of sink.samples()) {
      count++;
      sampleRate = s.sampleRate;
      channels = s.numberOfChannels;
      s.close();
    }
  } finally {
    input.dispose();
  }
  return { sampleRate, channels, count };
}

/** Settles with the iterator's outcome, or "HUNG" after `ms`. */
async function outcomeWithin(fixture: string, ms: number): Promise<string> {
  const run = decodeAll(fixture).then(
    (r) => `resolved:${r.count}`,
    (e: { name?: string }) => `rejected:${e?.name}`,
  );
  return Promise.race([run, new Promise<string>((r) => setTimeout(() => r("HUNG"), ms))]);
}

beforeEach(() => {
  configured.length = 0;
  vi.stubGlobal("AudioDecoder", makeFakeDecoder());
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("EncodedAudioChunk", FakeEncodedAudioChunk);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("repairHeAacTrack through mediabunny's real sink", () => {
  it.each([
    ["backward-compatible signalling", "he-aac-v1-mono-backcompat.m4a"],
    ["in a video", "he-aac-v1-mono-video.mp4"],
  ])("baseline (%s): stock mediabunny still says 1 channel for SBR on a mono core, and it fails", async (_label, fixture) => {
    // Only the channel count is asserted: that is the defect the repair
    // exists for. If this starts failing, mediabunny now reports the case
    // itself: delete repairHeAacTrack / he-aac-config.ts and their call site.
    // A change to the reported rate or codec string alone must not trip it
    // (review M1).
    await expect(decodeAll(fixture, false)).rejects.toThrow(/Unsupported configuration/);
    expect(configured[0].numberOfChannels).toBe(1);
  });

  it("mono-source HE-AAC v1 (SBR on a mono core, no PS) decodes as stereo with the repair", async () => {
    const out = await decodeAll("he-aac-v1-mono-backcompat.m4a");
    expect(configured.at(-1)).toMatchObject({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100 });
    expect(out).toMatchObject({ sampleRate: 44100, channels: 2 });
  });

  it.each([
    ["explicit HE-AACv2 (the Dreams clip's signalling)", "he-aac-v2-explicit.m4a", "mp4a.40.29"],
    ["backward-compatible HE-AACv2", "he-aac-v2-backcompat.m4a", "mp4a.40.2"],
    ["stereo HE-AAC v1", "he-aac-v1-backcompat.m4a", "mp4a.40.2"],
  ])("%s decodes stock as 44100 Hz stereo, and the repair leaves its config alone", async (_label, fixture, codec) => {
    const stock = await openTrack(fixture, false);
    const stockConfig = await stock.track.getDecoderConfig();
    stock.input.dispose();
    expect(stockConfig).toMatchObject({ codec, numberOfChannels: 2, sampleRate: 44100 });

    const repaired = await openTrack(fixture, true);
    expect(await repaired.track.getDecoderConfig()).toEqual(stockConfig);
    repaired.input.dispose();

    const out = await decodeAll(fixture, false);
    expect(out.count).toBeGreaterThan(0);
    expect(out).toMatchObject({ sampleRate: 44100, channels: 2 });
  });

  it("is idempotent and keeps canDecode true", async () => {
    const { input, track } = await openTrack("he-aac-v1-mono-backcompat.m4a", true);
    repairHeAacTrack(track);
    expect(await track.getDecoderConfig()).toMatchObject({ numberOfChannels: 2, sampleRate: 44100 });
    expect(await track.canDecode()).toBe(true);
    input.dispose();
  });

  describe.each([
    ["the repaired case (mono-source HE-AAC v1)", "he-aac-v1-mono-long-backcompat.m4a"],
    ["a config upstream gets right (HE-AACv2)", "he-aac-v2-long-backcompat.m4a"],
  ])("a decoder that fails on a long file (111 packets, over mediabunny's 40-deep queue): %s", (_label, fixture) => {
    it.each([
      ["mid-stream, after 3 outputs", { failAfter: 3 }],
      ["at the start, before any output", { failAfter: 0 }],
      ["on a slow decoder that produced nothing yet", { failAfter: 0, outputs: false }],
    ])("rejects promptly %s — never hangs", async (_l, opts) => {
      vi.stubGlobal("AudioDecoder", makeFakeDecoder(opts));
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", onUnhandled);
      try {
        const outcome = await outcomeWithin(fixture, 2000);
        expect(outcome).toBe("rejected:EncodingError");
        await new Promise((r) => setTimeout(r, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("control: a healthy decoder reads the whole long file", async () => {
      const outcome = await outcomeWithin(fixture, 2000);
      expect(outcome).toMatch(/^resolved:1\d\d$/);
    });
  });

  describe("a platform whose isConfigSupported refuses the unrepaired config (Re-review R3)", () => {
    // mediabunny checks decodability (canDecode → AudioDecoder.isConfigSupported)
    // before it creates a decoder, and it reads the config for that check
    // through its internal backing, not the public getDecoderConfig(). The
    // repair has to reach that check too, or such a platform never decodes.
    // With mediabunny 1.60 only mono-source HE-AAC v1 still arrives as the
    // refused 1-channel config, so that is what these cases use.
    it.each([
      ["audio-only HE-AAC", "he-aac-v1-mono-backcompat.m4a"],
      ["video + HE-AAC", "he-aac-v1-mono-video.mp4"],
    ])("%s: canDecode is true and the sink decodes as 44.1 kHz stereo", async (_label, fixture) => {
      vi.stubGlobal("AudioDecoder", makeFakeDecoder({ failAfter: null, strictSupport: true }));
      const { input, track } = await openTrack(fixture, true);
      expect(await track.canDecode()).toBe(true);
      input.dispose();
      const out = await decodeAll(fixture);
      expect(out.count).toBeGreaterThan(0);
      expect(out).toMatchObject({ sampleRate: 44100, channels: 2 });
    });

    it("control: unrepaired, the same platform refuses it", async () => {
      vi.stubGlobal("AudioDecoder", makeFakeDecoder({ failAfter: null, strictSupport: true }));
      const { input, track } = await openTrack("he-aac-v1-mono-video.mp4", false);
      expect(await track.canDecode()).toBe(false);
      input.dispose();
    });

    it.each([
      ["stereo HE-AAC v1", "he-aac-v1-backcompat.m4a"],
      ["the Dreams clip's HE-AACv2, in a video", "he-aac-v2-explicit-video.mp4"],
    ])("a config that needs no repair (%s) still gets mediabunny's own answer", async (_label, fixture) => {
      vi.stubGlobal("AudioDecoder", makeFakeDecoder({ failAfter: null, strictSupport: true }));
      for (const repair of [false, true]) {
        const { input, track } = await openTrack(fixture, repair);
        expect(await track.canDecode()).toBe(true);
        input.dispose();
      }
    });
  });
});

