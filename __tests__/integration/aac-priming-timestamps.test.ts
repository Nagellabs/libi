/**
 * Integration (real ffmpeg + real mediabunny demux and sample sink, WebCodecs
 * faked): decoded audio keeps the timestamp of an encoder-priming packet.
 *
 * An AAC track starts with priming packets at negative timestamps. Chromium's
 * AudioDecoder relabels the output of such a packet to 0. mediabunny 1.40
 * took that 0 as the start of its timestamp accumulator, so a run decoded from
 * a priming packet played late by the packet's offset: 21.81 ms on the Dreams
 * original, measured in Electron 36. libi used to avoid it by never starting a
 * decode before the first packet at or after 0. mediabunny 1.60 restores the
 * packet's own timestamp (`AudioDecoderWrapper`'s `expectedFirstTimestamp`),
 * measured at 0 ms in Electron, and the workaround is gone. This pins the
 * upstream behaviour the audio engine now relies on.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS, AudioSampleSink, EncodedPacketSink } from "mediabunny";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

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

/** Chromium-shaped: output timestamps run on from the first input timestamp
 *  after configure, clamped at 0, one frame per output. So a run that starts
 *  on a priming packet comes out shifted late by that packet's offset. */
class ChromiumLikeAudioDecoder extends EventTarget {
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  decodeQueueSize = 0;
  private cfg: AudioDecoderConfig | null = null;
  private base: number | null = null;
  private produced = 0;
  constructor(private readonly init: { output: (d: FakeAudioData) => void; error: (e: Error) => void }) {
    super();
  }
  static async isConfigSupported(config: AudioDecoderConfig) {
    return { supported: true, config };
  }
  configure(config: AudioDecoderConfig) {
    this.cfg = config;
    this.state = "configured";
    this.base = null;
    this.produced = 0;
  }
  decode(chunk: FakeEncodedAudioChunk) {
    this.decodeQueueSize++;
    setTimeout(() => {
      if (this.state !== "configured") return;
      this.base ??= Math.max(0, chunk.timestamp);
      const ts = this.base + (this.produced++ * 1024 * 1e6) / this.cfg!.sampleRate;
      this.decodeQueueSize--;
      this.dispatchEvent(new Event("dequeue"));
      this.init.output(new FakeAudioData(this.cfg!.sampleRate, this.cfg!.numberOfChannels, 1024, ts));
    }, 0);
  }
  async flush() {
    await new Promise((r) => setTimeout(r, 2));
  }
  reset() {
    this.base = null;
    this.produced = 0;
  }
  close() {
    this.state = "closed";
  }
}

skipIf("decoded AAC keeps an encoder-priming packet's timestamp (real mediabunny demux)", () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-aac-priming-"));
    file = path.join(dir, "tone.m4a");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1:r=44100", "-c:a", "aac", file], {
      stdio: "ignore",
      timeout: 60_000,
    });
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    vi.stubGlobal("AudioDecoder", ChromiumLikeAudioDecoder);
    vi.stubGlobal("AudioData", FakeAudioData);
    vi.stubGlobal("EncodedAudioChunk", FakeEncodedAudioChunk);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a run decoded from the first (priming) packet is labelled with the packets' own timestamps", async () => {
    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    try {
      const track = (await input.getPrimaryAudioTrack())!;
      const packets: number[] = [];
      for await (const p of new EncodedPacketSink(track).packets()) {
        packets.push(p.timestamp);
        if (packets.length === 4) break;
      }
      expect(packets[0]).toBeLessThan(0); // ffmpeg's AAC priming: -1024 / 44100 s

      const samples: number[] = [];
      for await (const s of new AudioSampleSink(track).samples()) {
        samples.push(s.timestamp);
        s.close();
        if (samples.length === 4) break;
      }
      // 1.40 labelled this run [0, 0.0232, …]: every sample one priming packet late.
      for (let k = 0; k < 4; k++) expect(samples[k]).toBeCloseTo(packets[k], 4);
    } finally {
      input.dispose();
    }
  });
});
