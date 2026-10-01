/**
 * `oggIsChained` is bounded (review round 5, M6): it read every page header
 * of the file (two reads a page), a 1 GB audiobook ~100k reads. It now reads
 * the first chain's opening pages, then the last 64 KiB once, looking for a
 * page that opens a stream (BOS) or belongs to one the first chain didn't open.
 * - a 50 MB single-chain Ogg (sparse, every page a valid header) resolves in
 *   fewer than 50 reads;
 * - real files (ffmpeg): a chained Ogg (cat a.ogg b.ogg), one whose second
 *   chain is longer than 64 KiB, FLAC in Ogg, and a two-stream Ogg read as
 *   before.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hasFfmpeg } from "../../helpers/media";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";
import { oggIsChained } from "@/lib/ffmpeg/audio-preview";

// Ogg's page CRC: polynomial 0x04c11db7, not reflected, initial 0.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function crc(bufs: Buffer[]): number {
  let c = 0;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

/** A page header + lacing for a body of `segments` × 255 zero bytes, CRC filled in. */
function pageHead(serial: number, seq: number, flags: number, segments: number, zeroBody: Buffer): Buffer {
  const h = Buffer.alloc(27 + segments);
  h.write("OggS", 0, "latin1");
  h[4] = 0;
  h[5] = flags;
  h.writeBigInt64LE(BigInt(seq * 1000), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h[26] = segments;
  for (let i = 0; i < segments; i++) h[27 + i] = 255;
  h.writeUInt32LE(crc([h, zeroBody.subarray(0, segments * 255)]), 22);
  return h;
}

describe("oggIsChained", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ogg-chain-"));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("a 50 MB single-chain Ogg resolves in fewer than 50 reads", async () => {
    const file = path.join(tmp, "long.ogg");
    const zero = Buffer.alloc(255 * 255);
    const fd = fs.openSync(file, "w");
    let offset = 0;
    let seq = 0;
    const SERIAL = 0x1234;
    // BOS page (a small body), then full 64 KiB data pages to 50 MB, headers only (bodies are holes).
    for (const [flags, segs] of [[0x02, 1], [0x00, 1]] as const) {
      fs.writeSync(fd, pageHead(SERIAL, seq++, flags, segs, zero), 0, undefined, offset);
      offset += 27 + segs + segs * 255;
    }
    while (offset < 50 * 1024 * 1024) {
      const h = pageHead(SERIAL, seq++, 0x00, 255, zero);
      fs.writeSync(fd, h, 0, h.length, offset);
      offset += h.length + 255 * 255;
    }
    fs.ftruncateSync(fd, offset);
    fs.closeSync(fd);

    const probe = await fsp.open(file, "r");
    const proto = Object.getPrototypeOf(probe) as { read: (...a: unknown[]) => unknown };
    await probe.close();
    const read = vi.spyOn(proto, "read");
    try {
      expect(await oggIsChained(file)).toBe(false);
      expect(read.mock.calls.length).toBeLessThan(50);
    } finally {
      read.mockRestore();
    }
  });

  const skipIf = hasFfmpeg() ? describe : describe.skip;
  skipIf("real files (ffmpeg)", () => {
    const at = (n: string) => path.join(tmp, n);
    beforeAll(() => {
      const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
      const tone = (f: number, d: number) => ["-f", "lavfi", "-i", `sine=f=${f}:sample_rate=48000:d=${d}`];
      ff([...tone(440, 2), "-c:a", "libopus", at("a.ogg")]);
      ff([...tone(660, 3), "-c:a", "libopus", at("b.ogg")]);
      ff([...tone(880, 60), "-c:a", "libopus", at("long-b.ogg")]);
      fs.writeFileSync(at("chained.ogg"), Buffer.concat([fs.readFileSync(at("a.ogg")), fs.readFileSync(at("b.ogg"))]));
      fs.writeFileSync(at("chained-long.ogg"), Buffer.concat([fs.readFileSync(at("a.ogg")), fs.readFileSync(at("long-b.ogg"))]));
      ff([...tone(440, 2), "-c:a", "flac", at("flac.ogg")]);
      ff([...tone(440, 2), ...tone(660, 2), "-map", "0:a", "-map", "1:a", "-c:a", "libopus", at("two-streams.ogg")]);
      ff([...tone(440, 90), "-c:a", "libvorbis", at("long-vorbis.ogg")]);
    });

    it("chained files read as chained, a second chain longer than the tail included", async () => {
      expect(fs.statSync(at("long-b.ogg")).size).toBeGreaterThan(64 * 1024);
      expect(await oggIsChained(at("chained.ogg"))).toBe(true);
      expect(await oggIsChained(at("chained-long.ogg"))).toBe(true);
    });

    it("single chains read as not chained: one stream, FLAC in Ogg, two streams together, a long Vorbis", async () => {
      for (const n of ["a.ogg", "long-b.ogg", "flac.ogg", "two-streams.ogg", "long-vorbis.ogg"]) {
        expect(await oggIsChained(at(n)), n).toBe(false);
      }
    });

    it("a file that isn't Ogg, or is missing, is not chained", async () => {
      fs.writeFileSync(at("not.ogg"), "hello world, not an ogg file at all");
      expect(await oggIsChained(at("not.ogg"))).toBe(false);
      expect(await oggIsChained(at("missing.ogg"))).toBe(false);
    });
  });
});
