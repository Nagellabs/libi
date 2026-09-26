/**
 * The Matroska tracks mediabunny drops (review M4), read from the file's own
 * Tracks element: a disabled track (FlagEnabled = 0), and one whose
 * ContentEncoding is anything but block-scoped header stripping. ffprobe lists
 * both, so the server passes over them the way the preview's demuxer does.
 * The real-file check is primary-track-parity.test.ts.
 */
import { describe, it, expect } from "vitest";
import { parseMatroskaTrackFlags, readMatroskaTrackFlags, unlistedStreamIndexes, codecDelayOfStream } from "@/lib/ffmpeg/matroska-tracks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { primaryStreamIndex } from "@/lib/ffmpeg/probe";

/** An EBML element: id bytes as written, 8-byte size, payload. */
function el(id: number[], ...children: Uint8Array[]): Uint8Array {
  const body = concat(...children);
  const size = [0x01, 0, 0, 0, 0, 0, 0, 0];
  let n = body.length;
  for (let i = 7; i > 0; i--) { size[i] = n & 0xff; n = Math.floor(n / 256); }
  return concat(new Uint8Array(id), new Uint8Array(size), body);
}
const uint = (id: number[], v: number) => el(id, new Uint8Array([v]));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const TRACK_TYPE = [0x83], FLAG_ENABLED = [0xb9];
const ENCODINGS = [0x6d, 0x80], ENCODING = [0x62, 0x40], SCOPE = [0x50, 0x32], TYPE = [0x50, 0x33];
const COMPRESSION = [0x50, 0x34], ALGO = [0x42, 0x54], ENCRYPTION = [0x50, 0x35], ORDER = [0x50, 0x31];
const CODEC_DELAY = [0x56, 0xaa];
/** A uint of up to 6 bytes. */
function uintN(id: number[], v: number): Uint8Array {
  const b: number[] = [];
  for (let x = v; b.length === 0 || x > 0; x = Math.floor(x / 256)) b.unshift(x % 256);
  return el(id, new Uint8Array(b));
}
const entry = (...c: Uint8Array[]) => el([0xae], ...c);
const compressed = (algo: number) =>
  el(ENCODINGS, el(ENCODING, uint(SCOPE, 1), uint(TYPE, 0), el(COMPRESSION, uint(ALGO, algo))));

function file(...entries: Uint8Array[]): Uint8Array {
  return concat(
    el([0x1a, 0x45, 0xdf, 0xa3], uint([0x42, 0x86], 1)),
    el([0x18, 0x53, 0x80, 0x67], el([0x15, 0x49, 0xa9, 0x66]), el([0x16, 0x54, 0xae, 0x6b], ...entries)),
  );
}

describe("parseMatroskaTrackFlags", () => {
  it("lists every track with its type, and which ones mediabunny keeps", () => {
    const bytes = file(
      entry(uint(TRACK_TYPE, 1)),
      entry(uint(TRACK_TYPE, 2), uint(FLAG_ENABLED, 0)),
      entry(uint(TRACK_TYPE, 2), compressed(0)), // zlib: dropped
      entry(uint(TRACK_TYPE, 2), compressed(3)), // header stripping: kept
      entry(uint(TRACK_TYPE, 2), uint(FLAG_ENABLED, 1)),
    );
    expect(parseMatroskaTrackFlags(bytes)?.map((t) => [t.type, t.listedByPreview])).toEqual([
      [1, true],
      [2, false],
      [2, false],
      [2, true],
      [2, true],
    ]);
  });

  it("follows mediabunny on malformed encodings (review M3): no compression/encryption child keeps the track; ContentEncodingType is not read", () => {
    const noChild = file(entry(uint(TRACK_TYPE, 2), el(ENCODINGS, el(ENCODING, uint(ORDER, 0)))));
    expect(parseMatroskaTrackFlags(noChild)?.[0].listedByPreview).toBe(true);
    const type1HeaderStrip = file(entry(uint(TRACK_TYPE, 2), el(ENCODINGS, el(ENCODING, uint(TYPE, 1), el(COMPRESSION, uint(ALGO, 3))))));
    expect(parseMatroskaTrackFlags(type1HeaderStrip)?.[0].listedByPreview).toBe(true);
    const encrypted = file(entry(uint(TRACK_TYPE, 2), el(ENCODINGS, el(ENCODING, uint(TYPE, 1), el(ENCRYPTION)))));
    expect(parseMatroskaTrackFlags(encrypted)?.[0].listedByPreview).toBe(false);
    const nonBlockScope = file(entry(uint(TRACK_TYPE, 2), el(ENCODINGS, el(ENCODING, uint(SCOPE, 2), el(COMPRESSION, uint(ALGO, 3))))));
    expect(parseMatroskaTrackFlags(nonBlockScope)?.[0].listedByPreview).toBe(false);
  });

  it("reads each track's CodecDelay (ns → s)", () => {
    const bytes = file(entry(uint(TRACK_TYPE, 1)), entry(uint(TRACK_TYPE, 2), uintN(CODEC_DELAY, 25_056_689)));
    const flags = parseMatroskaTrackFlags(bytes)!;
    expect(flags[0].codecDelay).toBe(0);
    expect(flags[1].codecDelay).toBeCloseTo(0.025057, 6);
    const streams = [{ index: 0, codec_type: "video" }, { index: 1, codec_type: "audio" }];
    expect(codecDelayOfStream(streams, flags, 1)).toBeCloseTo(0.025057, 6);
    expect(codecDelayOfStream(streams, flags, 0)).toBe(0);
  });

  it("is robust: truncations, bit flips and junk never throw; a 2 GB file costs one 1 MiB read", async () => {
    const real = file(entry(uint(TRACK_TYPE, 1)), entry(uint(TRACK_TYPE, 2), uintN(CODEC_DELAY, 6_500_000), compressed(3)));
    for (let len = 0; len <= real.length; len++) expect(() => parseMatroskaTrackFlags(real.subarray(0, len))).not.toThrow();
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 5000; k++) {
      const b = real.slice();
      for (let j = 0; j < 4; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      expect(() => parseMatroskaTrackFlags(b)).not.toThrow();
    }
    for (const fill of [0x00, 0xff, 0x80, 0x01]) expect(() => parseMatroskaTrackFlags(new Uint8Array(1 << 20).fill(fill))).not.toThrow();
    const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "libi-mkv-")), "big.mkv");
    const fd = fs.openSync(big, "w");
    fs.writeSync(fd, real, 0, real.length, 0);
    fs.ftruncateSync(fd, 2 * 1024 ** 3);
    fs.closeSync(fd);
    const t0 = performance.now();
    expect((await readMatroskaTrackFlags(big))?.length).toBe(2);
    expect(performance.now() - t0).toBeLessThan(1000);
    fs.rmSync(path.dirname(big), { recursive: true, force: true });
    expect(await readMatroskaTrackFlags("/nonexistent.mkv")).toBeNull();
    expect(await readMatroskaTrackFlags(os.tmpdir())).toBeNull();
  });

  it("answers null for a non-Matroska file, or when media comes before Tracks", () => {
    expect(parseMatroskaTrackFlags(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
    const clusterFirst = concat(
      el([0x1a, 0x45, 0xdf, 0xa3], uint([0x42, 0x86], 1)),
      el([0x18, 0x53, 0x80, 0x67], el([0x1f, 0x43, 0xb6, 0x75]), el([0x16, 0x54, 0xae, 0x6b], entry(uint(TRACK_TYPE, 2)))),
    );
    expect(parseMatroskaTrackFlags(clusterFirst)).toBeNull();
  });
});

describe("unlisted streams and the primary choice", () => {
  const streams: Array<{ index: number; codec_type: string; disposition: Record<string, number> }> = [
    { index: 0, codec_type: "video", disposition: { default: 1 } },
    { index: 1, codec_type: "audio", disposition: { default: 1 } },
    { index: 2, codec_type: "audio", disposition: { default: 1 } },
    { index: 3, codec_type: "video", disposition: { attached_pic: 1 } }, // an attachment, not an entry
  ];
  const flags = [
    { type: 1, listedByPreview: true, codecDelay: 0 },
    { type: 2, listedByPreview: false, codecDelay: 0 },
    { type: 2, listedByPreview: true, codecDelay: 0 },
  ];

  it("maps entries to ffprobe streams per type, in order", () => {
    expect([...unlistedStreamIndexes(streams, flags)]).toEqual([1]);
  });

  it("maps nothing when the counts disagree", () => {
    expect(unlistedStreamIndexes(streams, flags.slice(0, 2)).size).toBe(0);
  });

  it("the primary audio skips a dropped default track, as the preview does", () => {
    expect(primaryStreamIndex(streams, "audio")).toBe(1);
    expect(primaryStreamIndex(streams, "audio", new Set([1]))).toBe(2);
  });

  it("keeps a dropped track when it is the only one of its type (the preview then plays the proxy)", () => {
    expect(primaryStreamIndex(streams, "audio", new Set([1, 2]))).toBe(1);
  });
});
