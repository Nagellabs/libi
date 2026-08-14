import { describe, it, expect } from "vitest";
import { parseWavHeader, assertWav } from "@/__tests__/helpers/audio-assert";

/** Build a minimal valid 16-bit PCM WAV with `frames` samples @ rate. */
function makeWav(rate: number, frames: number): Buffer {
  const dataLen = frames * 2; // mono 16-bit
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

describe("audio-assert", () => {
  it("parses sample rate + duration", () => {
    const wav = makeWav(24000, 24000); // 1.0 s
    const h = parseWavHeader(wav);
    expect(h.sampleRate).toBe(24000);
    expect(h.channels).toBe(1);
    expect(h.durationSeconds).toBeCloseTo(1.0, 2);
  });

  it("assertWav enforces rate + duration band", () => {
    const wav = makeWav(24000, 24000 * 3); // 3 s
    expect(() => assertWav(wav, { sampleRate: 24000, minSeconds: 1, maxSeconds: 10 })).not.toThrow();
    expect(() => assertWav(wav, { sampleRate: 16000 })).toThrow(/sample rate/i);
    expect(() =>
      assertWav(wav, { sampleRate: 24000, minSeconds: 5 }),
    ).toThrow(/duration/i);
    expect(() => assertWav(Buffer.from("not a wav"), {})).toThrow(/not a RIFF\/WAVE/i);
  });
});
