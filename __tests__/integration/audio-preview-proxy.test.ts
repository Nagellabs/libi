/**
 * Integration (real ffmpeg, real mediabunny): an audio file the preview can't
 * play itself gets an AAC proxy, and the server tells the preview to prefer
 * it where mediabunny misreads without failing (review round 4). Before, the
 * preview played silence after a chained Ogg's first stream, and nothing at
 * all for FLAC in Ogg; audio files never had proxies to fall back to.
 *
 * - lib/ffmpeg/audio-preview.ts decides: chained Ogg, FLAC in Ogg, a codec
 *   the preview doesn't decode (ALAC here). A plain Ogg, an Ogg of two
 *   streams read together, and an MP3 are left alone.
 * - The timing route's `preferProxyAudio` is set for the two Ogg cases.
 * - The proxy (lib/proxy/args.ts buildAudioProxyArgs) carries ALL of a
 *   chained Ogg, as ffmpeg (and so the export) plays it, from 0, and
 *   mediabunny reads it: one AAC track as long as both streams.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS } from "mediabunny";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { audioProxyReason, oggIsChained } from "@/lib/ffmpeg/audio-preview";
import { fileTiming } from "@/lib/ffmpeg/file-timing";
import { buildAudioProxyArgs, proxyStreamsFor } from "@/lib/proxy/args";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

/** What the boot sweep hands the shared regeneration path (regen-once.ts). */
let swept: Array<{ id: string; pieceId: string | null }> | null = null;
vi.mock("@/lib/proxy/regen-once", () => ({
  runOnceSweep: vi.fn(async (_marker: string, _op: string, select: () => Promise<Array<{ id: string; pieceId: string | null }>>) => {
    swept = await select();
  }),
}));

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

skipIf("audio the preview can't play itself: detected, and proxied (real files, review round 4)", () => {
  let dir: string;
  const at = (name: string) => path.join(dir, name);
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-audio-preview-"));
    const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
    const tone = (f: number, d: number) => ["-f", "lavfi", "-i", `sine=f=${f}:sample_rate=48000:d=${d}`];
    ff([...tone(440, 2), "-c:a", "libopus", at("a.ogg")]);
    ff([...tone(660, 3), "-c:a", "libopus", at("b.ogg")]);
    // A chain: one Ogg stream after another, as `cat` (or a radio rip) makes it.
    fs.writeFileSync(at("chained.ogg"), Buffer.concat([fs.readFileSync(at("a.ogg")), fs.readFileSync(at("b.ogg"))]));
    ff([...tone(440, 2), "-c:a", "flac", at("flac.ogg")]);
    ff([...tone(440, 2), ...tone(660, 2), "-map", "0:a", "-map", "1:a", "-c:a", "libopus", at("two-streams.ogg")]);
    ff([...tone(440, 2), "-c:a", "alac", at("alac.m4a")]);
    ff([...tone(440, 2), "-c:a", "libmp3lame", at("plain.mp3")]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const reason = async (name: string) => audioProxyReason(at(name), await probeMedia(at(name)));

  it("names what the preview can't play, and nothing else", async () => {
    expect(await reason("chained.ogg")).toBe("chained-ogg");
    expect(await reason("flac.ogg")).toBe("ogg-flac");
    expect(await reason("alac.m4a")).toBe("codec");
    expect(await reason("a.ogg")).toBeNull();
    expect(await reason("two-streams.ogg")).toBeNull(); // read together, not a chain
    expect(await reason("plain.mp3")).toBeNull();
    expect(await oggIsChained(at("plain.mp3"))).toBe(false);
  });

  it("mediabunny misreads the two Ogg cases without failing: the timing route says to prefer the proxy", async () => {
    const chained = new Input({ source: new FilePathSource(at("chained.ogg")), formats: ALL_FORMATS });
    const [track] = await chained.getAudioTracks();
    expect(await track.computeDuration()).toBeLessThan(2.5); // the first stream only
    const flac = new Input({ source: new FilePathSource(at("flac.ogg")), formats: ALL_FORMATS });
    expect(await flac.getAudioTracks()).toHaveLength(0);
    expect((await fileTiming(at("chained.ogg")))!.preferProxyAudio).toBe(true);
    expect((await fileTiming(at("flac.ogg")))!.preferProxyAudio).toBe(true);
    // A codec the preview can't decode fails loudly (canDecode): the fallback it already had.
    expect((await fileTiming(at("alac.m4a")))!.preferProxyAudio).toBe(false);
    expect((await fileTiming(at("a.ogg")))!.preferProxyAudio).toBe(false);
  });

  it("the one-time boot sweep picks exactly the existing audio files that need a proxy", async () => {
    const prevHome = process.env.LIBI_HOME;
    const prevStorage = process.env.STORAGE_DIR;
    process.env.LIBI_HOME = dir;
    delete process.env.STORAGE_DIR;
    try {
      const db = createTestDb();
      seedPiece(db, { id: "p" });
      fs.mkdirSync(path.join(dir, "storage", "p"), { recursive: true });
      const names = ["chained.ogg", "flac.ogg", "alac.m4a", "a.ogg", "plain.mp3"];
      for (const name of names) {
        fs.copyFileSync(at(name), path.join(dir, "storage", "p", name));
        db.insert(files).values({ id: name, pieceId: "p", filename: name, name, description: "", type: "audio", storagePath: `p/${name}` }).run();
      }
      // One that already has its proxy is left alone.
      db.insert(files).values({
        id: "done", pieceId: "p", filename: "chained.ogg", name: "done", description: "", type: "audio",
        storagePath: "p/chained.ogg", proxyStatus: "ready", proxyFilename: "chained-proxy.m4a",
      }).run();
      const { sweepAudioPreviewProxies } = await import("@/lib/proxy/regen-audio-preview");
      await sweepAudioPreviewProxies();
      expect(swept!.map((f) => f.id).sort()).toEqual(["alac.m4a", "chained.ogg", "flac.ogg"]);
    } finally {
      resetTestDb();
      if (prevHome === undefined) delete process.env.LIBI_HOME;
      else process.env.LIBI_HOME = prevHome;
      if (prevStorage !== undefined) process.env.STORAGE_DIR = prevStorage;
    }
  });

  it("the proxy carries a chained Ogg whole, from 0, and mediabunny reads it", async () => {
    const out = at("chained-proxy.m4a");
    execFileSync(resolveFfmpegPath(), ["-v", "error", ...buildAudioProxyArgs(at("chained.ogg"), out, proxyStreamsFor(await probeMedia(at("chained.ogg"))))]);
    const probe = JSON.parse(execFileSync(resolveFfprobePath(), ["-v", "error", "-show_entries", "stream=codec_name:format=start_time,duration", "-of", "json", out]).toString());
    expect(probe.streams).toEqual([{ codec_name: "aac" }]);
    expect(Number(probe.format.start_time)).toBeCloseTo(0, 2);
    expect(Number(probe.format.duration)).toBeGreaterThan(4.9); // 2 s + 3 s
    const input = new Input({ source: new FilePathSource(out), formats: ALL_FORMATS });
    const [track] = await input.getAudioTracks();
    expect(await track.getCodec()).toBe("aac");
    expect(await track.computeDuration()).toBeGreaterThan(4.9);
  });
});
