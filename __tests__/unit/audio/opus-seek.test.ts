/**
 * Opus placed where ffmpeg's decode has it, from any start (lib/audio/opus-seek.ts).
 *
 * Chromium's Opus decoder discards the OpusHead's pre-skip after every
 * configure, and mediabunny configures one per run, at the packet a seek
 * lands on. Measured in Electron 36 against ffmpeg's decode, before: Ogg Opus
 * 6.5 ms early after a seek, WebM/MKV 1 ms late, MP4 6.5 ms early from
 * anywhere (its edit list already hides the priming). libi now decodes with
 * pre-skip 0 and moves each run by its packet's stored-time lead. The inputs
 * below are the packet times mediabunny 1.60 reports for ffmpeg-made files.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("mediabunny", () => {
  class EncodedPacketSink {
    constructor(private track: { packets: Array<{ timestamp: number; data: Uint8Array }> }) {}
    async getFirstPacket() {
      return this.track.packets[0] ?? null;
    }
    async getNextPacket(p: { timestamp: number }) {
      const i = this.track.packets.findIndex((q) => q.timestamp === p.timestamp);
      return this.track.packets[i + 1] ?? null;
    }
  }
  class IsobmffInputFormat {}
  class OggInputFormat {}
  return { EncodedPacketSink, IsobmffInputFormat, OggInputFormat };
});

import { IsobmffInputFormat } from "mediabunny";
import {
  opusLeads,
  opusPreSkip,
  withoutPreSkip,
  opusPacketSamples,
  opusSeekInfo,
  planOpusRun,
  trimChunk,
  SEEK_PREROLL_S,
} from "@/lib/audio/opus-seek";

/** An OpusHead: magic, version 1, 2 channels, pre-skip, 48 kHz, gain 0, family 0. */
function opusHead(preSkip: number): Uint8Array {
  const b = new Uint8Array(19);
  b.set([..."OpusHead"].map((c) => c.charCodeAt(0)));
  b[8] = 1;
  b[9] = 2;
  b[10] = preSkip & 0xff;
  b[11] = preSkip >> 8;
  new DataView(b.buffer).setUint32(12, 48000, true);
  return b;
}

/** A track as mediabunny 1.60 reports it: codec, config, packet times (20 ms CELT frames, TOC 0xfc). */
function track(times: number[], toc = 0xfc, isobmff = false, preSkip = 312) {
  return {
    input: { getFormat: async () => (isobmff ? Object.create(IsobmffInputFormat.prototype) : {}) },
    packets: times.map((timestamp) => ({ timestamp, data: new Uint8Array([toc, 0]) })),
    getCodec: async () => "opus",
    getDecoderConfig: async () => ({ codec: "opus", numberOfChannels: 2, sampleRate: 48000, description: opusHead(preSkip) }),
  };
}

describe("OpusHead and TOC", () => {
  it("reads the pre-skip, and zeroes it in a copy", async () => {
    const head = opusHead(312);
    expect(opusPreSkip(head)).toBe(312);
    const cfg = withoutPreSkip({ codec: "opus", numberOfChannels: 2, sampleRate: 48000, description: head });
    expect(opusPreSkip(cfg.description)).toBe(0);
    expect(opusPreSkip(head)).toBe(312); // the original is untouched
    expect(opusPreSkip(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("counts a packet's samples from its TOC byte (RFC 6716 §3.1)", () => {
    expect(opusPacketSamples(new Uint8Array([0xfc]))).toBe(960); // CELT 20 ms, 1 frame
    expect(opusPacketSamples(new Uint8Array([0xf4]))).toBe(480); // CELT 10 ms
    expect(opusPacketSamples(new Uint8Array([0xff, 0x03]))).toBe(2880); // CELT 20 ms × 3 (code 3)
    expect(opusPacketSamples(new Uint8Array([0x0d]))).toBe(1920); // SILK 20 ms × 2 (code 1)
    expect(opusPacketSamples(new Uint8Array([0x78]))).toBe(960); // hybrid 20 ms (config 15)
    expect(opusPacketSamples(new Uint8Array([0x18]))).toBe(2880); // SILK 60 ms (config 3)
    expect(opusPacketSamples(new Uint8Array([0x7b]))).toBeNull(); // code 3 without its count byte
    expect(opusPacketSamples(new Uint8Array([]))).toBeNull();
  });
});

describe("stored-time leads, per container (origin 0, pre-skip 312)", () => {
  const leads = async (t: ReturnType<typeof track>, origin = 0, audioLead = 0) =>
    opusLeads((await opusSeekInfo(t as never))!, { origin, audioLead });

  it("exact granule-like times (Ogg's later pages): the first packet reads 0 but starts 6.5 ms earlier; later packets are exact", async () => {
    const l = await leads(track([0, 0.0135, 0.0335]));
    expect(l.first).toBeCloseTo(0.0065, 9);
    expect(l.later).toBeCloseTo(0, 9);
  });

  it("WebM: stored whole-ms times lead by the CodecDelay and its rounding (7.5 ms)", async () => {
    const l = await leads(track([0, 0.021, 0.041]));
    expect(l.first).toBeCloseTo(0.0065, 9);
    expect(l.later).toBeCloseTo(0.0075, 9);
  });

  it("WebM with 10 ms frames: the TOC gives the first packet's length", async () => {
    expect((await leads(track([0, 0.011, 0.021], 0xf4))).later).toBeCloseTo(0.0075, 9);
  });

  it("the leads follow the origin (a file whose start is 1.5 s)", async () => {
    const l = await leads(track([1.5, 1.5135]), 1.5);
    expect(l.first).toBeCloseTo(0.0065, 9);
    expect(l.later).toBeCloseTo(0, 9);
  });

  it("a browser recording: the Opus track starts 0.343 s after the video (R3-C1), pre-skip 0, 60 ms frames", async () => {
    const mr = track([0.343, 0.403, 0.463], 0x18, false, 0);
    // The track's lead from the server: its packets are where they say.
    expect(await leads(mr, 0, 0.343)).toEqual({ first: expect.closeTo(0, 9), later: expect.closeTo(0, 9) });
    // Taking the first packet to start at the file's start put the voice 343 ms early.
    expect((await leads(mr, 0, 0)).first).toBeCloseTo(0.343, 9);
  });

  it("a WebM without CodecDelay: ffmpeg stamps its first kept sample the pre-skip in whole ms (7) after the first packet", async () => {
    // ffprobe -show_frames on such a file: the first frame 648 samples at 0.007 s.
    const info = (await opusSeekInfo(track([0, 0.021, 0.041]) as never))!;
    expect(opusLeads(info, { origin: 0, audioLead: 0, skipsPreSkip: false }).first).toBeCloseTo(-0.0005, 9);
    expect(opusLeads(info, { origin: 0, audioLead: 0 }).first).toBeCloseTo(0.0065, 9); // with a CodecDelay (the default)
  });

  it("MP4: mediabunny's times are presentation times, so both leads are 0", async () => {
    expect(await leads(track([-0.0065, 0.0135, 0.0335], 0xfc, true))).toEqual({ first: 0, later: 0 });
  });

  it("an MP4 stream-copied at a non-keyframe (pre-roll packets listed before 0): still 0, never inferred from the first packet", async () => {
    expect(await leads(track([-0.3065, -0.2865, -0.2665], 0xfc, true))).toEqual({ first: 0, later: 0 });
  });

  it("the decoder view carries pre-skip 0; the track itself keeps its own", async () => {
    const t = track([0, 0.0135]);
    const info = (await opusSeekInfo(t as never))!;
    expect(opusPreSkip((await info.noPreSkipTrack.getDecoderConfig())!.description)).toBe(0);
    expect(opusPreSkip((await t.getDecoderConfig()).description)).toBe(312);
  });

  it("is null for any other codec", async () => {
    expect(await opusSeekInfo({ ...track([0]), getCodec: async () => "aac" } as never)).toBeNull();
  });
});

describe("planOpusRun", () => {
  const info = {
    preSkip: 312, firstPacketTime: 0, firstPacketSamples: 960, secondPacketTime: 0.021,
    presentationTimes: false, ogg: null, noPreSkipTrack: {} as never,
  };
  const place = { origin: 0, audioLead: 0, seqShift: 0 };
  const packets = { getPacket: vi.fn(async (t: number) => ({ timestamp: Math.floor(t / 0.02) * 0.02 + 0.001 })) };

  it("a start within the pre-roll of the first packet decodes from the first packet, moved back by its lead", async () => {
    const a = await planOpusRun(info, packets as never, 0, place);
    expect(a.decodeFrom).toBe(0);
    expect(a.shift).toBeCloseTo(-0.0065, 9);
    expect((await planOpusRun(info, packets as never, SEEK_PREROLL_S - 0.001, place)).decodeFrom).toBe(0);
  });

  it("a later start decodes from the packet 80 ms earlier, moved back by the later-packet lead", async () => {
    const plan = await planOpusRun(info, packets as never, 2.5, place);
    expect(packets.getPacket).toHaveBeenCalledWith(2.5 - SEEK_PREROLL_S, { metadataOnly: true });
    expect(plan.shift).toBeCloseTo(-0.0075, 9);
    expect(plan.decodeFrom).toBeCloseTo(2.421, 9); // the packet holding 2.42 s
  });

  it("a browser recording's jittered stamps land on the frame grid (60 ms frames stamped 58/60/62 ms apart)", async () => {
    const mr = { ...info, preSkip: 0, firstPacketTime: 0.343, firstPacketSamples: 2880, secondPacketTime: 0.403 };
    const mrPlace = { origin: 0, audioLead: 0.343, seqShift: 0 };
    // The packet truly at 0.343 + 40 × 0.06 = 2.743 s is stamped 2.741 s.
    const jittered = { getPacket: vi.fn(async () => ({ timestamp: 2.741 })) };
    const plan = await planOpusRun(mr, jittered as never, 2.8, mrPlace);
    expect(plan.decodeFrom + plan.shift).toBeCloseTo(2.743, 9);
    // More than 5 ms off the grid is not jitter: the constant lead stands.
    const far = { getPacket: vi.fn(async () => ({ timestamp: 2.723 })) };
    expect((await planOpusRun(mr, far as never, 2.8, mrPlace)).shift).toBeCloseTo(0, 9);
  });

  it("Ogg: a start before the second page's granule decodes from the first packet on mediabunny's first timeline, moved by seqShift", async () => {
    const ogg = { ...info, secondPacketTime: 0.0135, ogg: { firstPacketTime: 0, secondPageEnd: 1.9935 } };
    const cut = { origin: -0.3, audioLead: 0, seqShift: -0.3 }; // an -ss 1.3 -c copy cut: ffmpeg starts it at -0.3 s
    const seek = { getPacket: vi.fn(async (t: number) => ({ timestamp: t - 0.01 })) };
    const early = await planOpusRun(ogg, seek as never, 1.2, cut);
    expect(early.decodeFrom).toBe(0);
    expect(early.shift).toBeCloseTo(-0.3 - 0.0065, 9);
    expect(seek.getPacket).not.toHaveBeenCalled();
    // Past the second page (1.9935 − 0.3 on ffmpeg's timeline): the granules' own times, unmoved.
    const late = await planOpusRun(ogg, seek as never, 2.5, cut);
    expect(seek.getPacket).toHaveBeenLastCalledWith(2.5 - SEEK_PREROLL_S, { metadataOnly: true });
    expect(late).toEqual({ decodeFrom: 2.5 - SEEK_PREROLL_S - 0.01, shift: 0, trims: [], audibleFrom: null });
  });

  // Review round 4: a packet of another length than the stream's frames is
  // off their grid (a file whose encoder changed frame size): no snap.
  it("snaps only a packet of the stream's own frame length (its TOC)", async () => {
    const mr = { ...info, preSkip: 0, firstPacketTime: 0.343, firstPacketSamples: 2880, secondPacketTime: 0.403 };
    const mrPlace = { origin: 0, audioLead: 0.343, seqShift: 0 };
    const toc = (samples: number) => new Uint8Array([samples === 2880 ? (3 << 3) : (1 << 3), 0]); // SILK 60 ms / 20 ms, one frame
    const sameLength = { getPacket: vi.fn(async () => ({ timestamp: 2.741, data: toc(2880) })) };
    expect((await planOpusRun(mr, sameLength as never, 2.8, mrPlace)).shift).toBeCloseTo(0.002, 9);
    const otherLength = { getPacket: vi.fn(async () => ({ timestamp: 2.741, data: toc(960) })) };
    expect((await planOpusRun(mr, otherLength as never, 2.8, mrPlace)).shift).toBeCloseTo(0, 9);
  });

  it("a MediaRecorder MP4 (pre-skip 3840, no edit list): anchored where ffmpeg keeps its first sample (review round 4)", async () => {
    // mr-av.mp4's packets: 0, 2879, 5631, 8510 (at 48 kHz), 60 ms each. ffmpeg
    // skips 3840 samples and keeps the first at 2879 + 960 = 3839.
    const stamps = [0, 2879, 5631, 8510].map((t) => t / 48000);
    const toc60 = new Uint8Array([3 << 3, 0]);
    const pk = (i: number) => ({ timestamp: stamps[i], data: toc60 });
    const mr = { ...info, preSkip: 3840, firstPacketTime: 0, firstPacketSamples: 2880, secondPacketTime: stamps[1], presentationTimes: true };
    const reader = {
      getPacket: vi.fn(async (t: number) => { let i = 0; stamps.forEach((s, k) => { if (s <= t + 1e-9) i = k; }); return pk(i); }),
      getNextPacket: vi.fn(async (p: { timestamp: number }) => { const i = stamps.indexOf(p.timestamp); return i + 1 < stamps.length ? pk(i + 1) : null; }),
    };
    const first = await planOpusRun(mr, reader as never, 0, place);
    expect(first.decodeFrom + first.shift).toBeCloseTo(-1 / 48000, 12);
    expect(first.audibleFrom).toBeCloseTo(3839 / 48000, 12);
    // A run from the third packet (stamped 128 samples early) lands on that grid.
    const later = await planOpusRun(mr, reader as never, 5631 / 48000 + SEEK_PREROLL_S, place);
    expect(later.decodeFrom).toBeCloseTo(5631 / 48000, 12);
    expect(later.decodeFrom + later.shift).toBeCloseTo(5759 / 48000, 12);
  });

  it("MP4: presentation times, snapped only to the frame grid from the first packet (a browser recording's jitter)", async () => {
    const mp4 = { ...info, presentationTimes: true, firstPacketTime: 0, firstPacketSamples: 2880 };
    const jittered = { getPacket: vi.fn(async () => ({ timestamp: 2.4021 })) }; // 40 frames of 60 ms = 2.4, stamped 2.1 ms late
    const plan = await planOpusRun(mp4, jittered as never, 2.5, place);
    expect(plan.decodeFrom).toBe(2.4021);
    expect(plan.decodeFrom + plan.shift).toBeCloseTo(2.4, 9);
    expect(plan.trims).toEqual([]);
    const onGrid = { getPacket: vi.fn(async () => ({ timestamp: 2.4 })) };
    expect((await planOpusRun(mp4, onGrid as never, 2.5, place)).shift).toBeCloseTo(0, 12);
  });
});

/**
 * A Matroska Opus stream joined from two encodes (`ffmpeg -f concat -c copy`):
 * 50 packets of 60 ms, the 51st cut to 312 samples by its DiscardPadding
 * (2568), then 20 ms packets. True starts count the pre-skip (the first
 * packet at −6.5 ms); the stored times are ffmpeg's rounded to whole ms,
 * plus the 7 ms CodecDelay, as mediabunny reports mixed-frames.webm.
 */
describe("a join of two Opus encodes (review round 4)", () => {
  const info = {
    preSkip: 312, firstPacketTime: 0.007, firstPacketSamples: 2880, secondPacketTime: 0.067,
    presentationTimes: false, ogg: null, noPreSkipTrack: {} as never,
  };
  const trueStarts: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i <= 50; i++) { trueStarts.push(-0.0065 + i * 0.06); sizes.push(2880); }
  for (let i = 0; i < 100; i++) { trueStarts.push(2.9935 + 312 / 48000 + i * 0.02); sizes.push(960); }
  // ffmpeg's times are the true ones plus the 6.5 ms pre-skip it skips.
  const stored = trueStarts.map((t) => Math.round((t + 0.0065) * 1000 + 1e-6) / 1000 + 0.007);
  const toc = (n: number) => new Uint8Array([n === 2880 ? (3 << 3) : (1 << 3), 0]);
  const packetAt = (i: number) => ({ timestamp: stored[i], data: toc(sizes[i]) });
  const packets = {
    getPacket: vi.fn(async (t: number) => {
      let i = -1;
      for (let k = 0; k < stored.length; k++) if (stored[k] <= t + 1e-9) i = k;
      return i < 0 ? null : packetAt(i);
    }),
    getNextPacket: vi.fn(async (p: { timestamp: number }) => {
      const i = stored.findIndex((s) => Math.abs(s - p.timestamp) < 1e-9);
      return i >= 0 && i + 1 < stored.length ? packetAt(i + 1) : null;
    }),
  };
  const place = { origin: 0, audioLead: 0, seqShift: 0, trims: [[3.0, 2568]] as Array<[number, number]> };

  it("a run across the join carries its trim, at the cut packet's true start", async () => {
    const plan = await planOpusRun(info, packets as never, 2.5, place);
    expect(plan.decodeFrom + plan.shift).toBeCloseTo(trueStarts[40], 9);
    expect(plan.trims).toHaveLength(1);
    expect(plan.trims[0].at).toBeCloseTo(trueStarts[50], 9);
    expect(plan.trims[0].discard).toBeCloseTo(2568 / 48000, 12);
  });

  it("a run after the join starts on the second encode's own grid, exactly", async () => {
    for (const from of [3.1, 3.3, 3.95]) {
      const plan = await planOpusRun(info, packets as never, from, place);
      const i = stored.findIndex((s) => Math.abs(s - plan.decodeFrom) < 1e-9);
      expect(i).toBeGreaterThan(50);
      expect(plan.decodeFrom + plan.shift).toBeCloseTo(trueStarts[i], 9);
      expect(plan.trims).toEqual([]);
    }
  });

  it("without the trims, a run after the join keeps its constant lead: the old grid is not snapped to", async () => {
    const plan = await planOpusRun(info, packets as never, 3.3, { ...place, trims: [] });
    const i = stored.findIndex((s) => Math.abs(s - plan.decodeFrom) < 1e-9);
    expect(Math.abs(plan.decodeFrom + plan.shift - trueStarts[i])).toBeLessThan(0.0015);
  });

  it("trimChunk cuts the trimmed packet's chunk, once, and nothing else", () => {
    const trims = [{ at: 2.9935, discard: 2568 / 48000 }];
    expect(trimChunk(trims, 2.9335)).toBe(0);
    expect(trimChunk(trims, 2.99352)).toBeCloseTo(2568 / 48000, 12);
    expect(trims).toHaveLength(0);
    expect(trimChunk(trims, 3.0535)).toBe(0);
    // A trim the run passed without a chunk at it is dropped, not applied later.
    const passed = [{ at: 1, discard: 0.01 }];
    expect(trimChunk(passed, 1.5)).toBe(0);
    expect(passed).toHaveLength(0);
  });

  it("nothing plays before ffmpeg's first kept sample: the pre-skip is priming", async () => {
    const plan = await planOpusRun(info, packets as never, 0, place);
    expect(plan.decodeFrom).toBe(0.007);
    expect(plan.decodeFrom + plan.shift).toBeCloseTo(-0.0065, 9);
    expect(plan.audibleFrom).toBeCloseTo(0, 12);
  });
});
