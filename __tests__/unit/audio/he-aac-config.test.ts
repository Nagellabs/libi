/**
 * HE-AAC decoder config repair.
 *
 * Chromium (Electron 36) decodes SBR on a mono core to stereo and rejects a
 * decoder config that says 1 channel for it (`OperationError: Unsupported
 * configuration`), leaving the clip silent in the preview. mediabunny 1.40 sent
 * the core layer's values for every HE-AAC track (the Dreams clip reached
 * WebCodecs as { mp4a.40.29, 1 ch, 22050 Hz }). mediabunny 1.60 reports the
 * SBR output rate, and 2 channels when PS is signalled, but still 1 channel
 * for SBR on a mono core with no PS (a mono-source HE-AAC v1 file). The inputs
 * below are the configs 1.60 builds.
 *
 * Fixture: the real AudioSpecificConfig of the Dreams / Ocean Spray TikTok clip
 * (`eb 8a 08 00` — AOT 29, core 22050 Hz mono, extension 44100 Hz).
 * docs-local/qa/2026-09-25-dreams-audio-report.md,
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
import { describe, it, expect } from "vitest";
import { parseAacAudioSpecificConfig, repairHeAacDecoderConfig } from "@/lib/audio/he-aac-config";

const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Dreams clip: AOT 29 (HE-AACv2), core 22050 Hz mono, SBR to 44100 Hz. */
const DREAMS_ASC = hex("eb8a0800");

/** Build an explicit-signalling ASC: AOT, core freq index, channel config,
 *  extension freq index, then the underlying AOT 2 (LC) and a zeroed GASpecificConfig. */
function explicitAsc(aot: number, coreFreqIdx: number, chanCfg: number, extFreqIdx: number): Uint8Array {
  const bits = [
    aot.toString(2).padStart(5, "0"),
    coreFreqIdx.toString(2).padStart(4, "0"),
    chanCfg.toString(2).padStart(4, "0"),
    extFreqIdx.toString(2).padStart(4, "0"),
    (2).toString(2).padStart(5, "0"),
    "000",
  ].join("");
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  return new Uint8Array(padded.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}

describe("parseAacAudioSpecificConfig", () => {
  it("reads the Dreams clip's explicit HE-AACv2 header", () => {
    expect(parseAacAudioSpecificConfig(DREAMS_ASC)).toEqual({
      objectType: 29,
      coreSampleRate: 22050,
      coreChannels: 1,
      sbrSampleRate: 44100,
      psPresent: true,
    });
  });

  it("reads a plain AAC-LC header with no extension", () => {
    // The Dreams proxy: AOT 2, 44100 Hz, stereo.
    expect(parseAacAudioSpecificConfig(hex("121056e500"))).toEqual({
      objectType: 2,
      coreSampleRate: 44100,
      coreChannels: 2,
      sbrSampleRate: null,
      psPresent: false,
    });
  });

  it("reads backward-compatible HE-AACv2 signalling (sync extensions 0x2b7 + 0x548)", () => {
    // afconvert -d aacp: AOT 2 core at 22050 Hz mono, then SBR → 44100 and PS.
    expect(parseAacAudioSpecificConfig(hex("138856e5a54880"))).toEqual({
      objectType: 2,
      coreSampleRate: 22050,
      coreChannels: 1,
      sbrSampleRate: 44100,
      psPresent: true,
    });
  });

  it("reads backward-compatible HE-AAC v1 signalling (sync extension 0x2b7, no PS)", () => {
    expect(parseAacAudioSpecificConfig(hex("139056e5a0"))).toEqual({
      objectType: 2,
      coreSampleRate: 22050,
      coreChannels: 2,
      sbrSampleRate: 44100,
      psPresent: false,
    });
  });

  it("reads an explicit 24-bit sample rate (frequency index 15)", () => {
    // AOT 2, idx 15, rate 0x00_BB80 (48000), chan 2.
    const bits = "00010" + "1111" + (48000).toString(2).padStart(24, "0") + "0010" + "000";
    const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
    const bytes = new Uint8Array(padded.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    expect(parseAacAudioSpecificConfig(bytes)).toMatchObject({ objectType: 2, coreSampleRate: 48000, coreChannels: 2 });
  });

  it("returns null for a description too short to be an ASC", () => {
    expect(parseAacAudioSpecificConfig(new Uint8Array([0x12]))).toBeNull();
    expect(parseAacAudioSpecificConfig(new Uint8Array())).toBeNull();
  });
});

/** Mono-source HE-AAC v1: AOT 2 core at 22050 Hz mono, SBR → 44100, no PS. */
const MONO_HE_AAC_V1_ASC = hex("138856e5a0");

describe("repairHeAacDecoderConfig", () => {
  it("repairs mono-source HE-AAC v1 as mediabunny 1.60 reports it (1 ch) to stereo", () => {
    // SBR signalled on a mono core, no PS. A decoder must assume PS may be
    // present and output stereo (ISO 14496-3 §1.6.5.3); Chromium does, and
    // rejects a 1-channel config for it.
    const stock = { codec: "mp4a.40.2", numberOfChannels: 1, sampleRate: 44100, description: MONO_HE_AAC_V1_ASC };
    const repaired = repairHeAacDecoderConfig(stock);
    expect(repaired).toEqual({ ...stock, numberOfChannels: 2 });
    // The description is passed through untouched; it was never wrong.
    expect(repaired!.description).toBe(MONO_HE_AAC_V1_ASC);
  });

  it("repairs explicit SBR (AOT 5) on a mono core the same way", () => {
    const asc = explicitAsc(5, 7 /* 22050 */, 1, 4 /* 44100 */);
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.5", numberOfChannels: 1, sampleRate: 44100, description: asc }),
    ).toMatchObject({ codec: "mp4a.40.5", numberOfChannels: 2, sampleRate: 44100 });
  });

  it("stays off for every HE-AAC config mediabunny 1.60 already gets right", () => {
    // The Dreams clip (explicit HE-AACv2), backward-compatible HE-AACv2, and
    // stereo HE-AAC v1, each as 1.60 reports it.
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.29", numberOfChannels: 2, sampleRate: 44100, description: DREAMS_ASC }),
    ).toBeNull();
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100, description: hex("138856e5a54880") }),
    ).toBeNull();
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100, description: hex("139056e5a0") }),
    ).toBeNull();
  });

  it("leaves a rate-only discrepancy alone: stereo HE-AAC v1 at its core rate already decodes in Chromium", () => {
    const asc = explicitAsc(5, 6 /* 24000 */, 2, 3 /* 48000 */);
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.5", numberOfChannels: 2, sampleRate: 24000, description: asc }),
    ).toBeNull();
  });

  it("returns null for plain AAC-LC — nothing to repair", () => {
    // Mono LC stays mono: the stereo rule applies only when SBR is signalled.
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.2", numberOfChannels: 1, sampleRate: 44100, description: hex("1208") }),
    ).toBeNull();
    expect(
      repairHeAacDecoderConfig({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 44100, description: hex("121056e500") }),
    ).toBeNull();
  });

  it("returns null without a description, or for a non-AAC codec", () => {
    expect(repairHeAacDecoderConfig({ codec: "mp4a.40.2", numberOfChannels: 1, sampleRate: 44100 })).toBeNull();
    expect(repairHeAacDecoderConfig({ codec: "opus", numberOfChannels: 1, sampleRate: 48000, description: MONO_HE_AAC_V1_ASC })).toBeNull();
  });

  it("accepts an ArrayBuffer or a DataView description", () => {
    const buf = MONO_HE_AAC_V1_ASC.slice().buffer;
    const cfg = { codec: "mp4a.40.2", numberOfChannels: 1, sampleRate: 44100 };
    expect(repairHeAacDecoderConfig({ ...cfg, description: buf })).toMatchObject({ numberOfChannels: 2 });
    expect(repairHeAacDecoderConfig({ ...cfg, description: new DataView(buf) })).toMatchObject({ numberOfChannels: 2 });
  });
});
