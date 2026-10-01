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
import { audioProxyReason, mayNeedAudioPreviewProxy, oggIsChained, previewPrefersProxy } from "@/lib/ffmpeg/audio-preview";
import { fileTiming } from "@/lib/ffmpeg/file-timing";
import { buildAudioProxyArgs, proxyStreamsFor } from "@/lib/proxy/args";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

/** What the boot sweep hands the shared regeneration path (regen-once.ts). */
let swept: Array<{ id: string; pieceId: string | null }> | null = null;
vi.mock("@/lib/proxy/regen-once", () => ({
  runOnceSweep: vi.fn(async (_marker: string, _op: string, select: (done: ReadonlySet<string>) => Promise<import("@/lib/proxy/regen-once").SweepSelection>) => {
    const picked = await select(new Set());
    swept = Array.isArray(picked) ? picked : picked.files;
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

  // AUD-4: an audio-only AAC file whose MONO core carries SBR/PS. Chromium
  // decodes it to stereo, so a 1-channel config fails WebCodecs: the preview's
  // repair (lib/audio/he-aac-config.ts) fixes the config only when the ASC
  // SIGNALS SBR, and an in-band-only stream (LC-signalled ASC, as every ADTS
  // .aac is) is silent. A video has its proxy to fall back to; an audio file
  // had none. ffprobe decodes, so it names the profile either way.
  describe("HE-AAC on a mono core (AUD-4)", () => {
    const FIX = path.resolve(__dirname, "../fixtures/audio");
    beforeAll(() => {
      const ff = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-v", "error", "-y", ...args], { stdio: "ignore" });
      // The mono-core SBR fixture with its ASC's SBR sync extension blanked in
      // place: an LC-signalled config over the same SBR frames (in-band only).
      const src = fs.readFileSync(path.join(FIX, "he-aac-v1-mono-backcompat.m4a"));
      const at_ = src.indexOf(Buffer.from("138856e5a0", "hex"));
      expect(at_).toBeGreaterThan(0);
      fs.writeFileSync(
        at("inband-mono.m4a"),
        Buffer.concat([src.subarray(0, at_), Buffer.from("1388000000", "hex"), src.subarray(at_ + 5)]),
      );
      // ADTS can only say LC: HE-AAC in a .aac file is always in-band.
      ff(["-i", path.join(FIX, "he-aac-v1-mono-backcompat.m4a"), "-c:a", "copy", "-f", "adts", at("mono-sbr.aac")]);
    });
    const fixture = async (name: string) => {
      const p = path.join(FIX, name);
      return audioProxyReason(p, await probeMedia(p));
    };

    it("the mono-core SBR fixture gets a proxy reason, and the preview prefers the proxy", async () => {
      expect(await fixture("he-aac-v1-mono-backcompat.m4a")).toBe("he-aac-mono");
      expect(previewPrefersProxy("he-aac-mono")).toBe(true);
      expect((await fileTiming(path.join(FIX, "he-aac-v1-mono-backcompat.m4a")))!.preferProxyAudio).toBe(true);
    });

    it("in-band-only SBR (an LC-signalled ASC, or ADTS) is caught too", async () => {
      expect(await reason("inband-mono.m4a")).toBe("he-aac-mono");
      expect((await fileTiming(at("inband-mono.m4a")))!.preferProxyAudio).toBe(true);
      expect(mayNeedAudioPreviewProxy("mono-sbr.aac")).toBe(true);
      expect(await reason("mono-sbr.aac")).toBe("he-aac-mono");
      expect(await fixture("he-aac-v2-backcompat.m4a")).toBe("he-aac-mono"); // PS rides a mono core
    });

    it("leaves alone a stereo core, plain AAC-LC, and a video (which has its own proxy)", async () => {
      expect(await fixture("he-aac-v1-backcompat.m4a")).toBeNull();
      expect(await fixture("aac-lc-itunsmpb.m4a")).toBeNull();
      expect(await fixture("he-aac-v1-mono-video.mp4")).toBeNull();
      expect((await fileTiming(path.join(FIX, "he-aac-v1-mono-video.mp4")))!.preferProxyAudio).toBe(false);
    });

    it("its proxy is plain AAC-LC stereo, which WebCodecs decodes", async () => {
      const src = path.join(FIX, "he-aac-v1-mono-backcompat.m4a");
      const out = at("he-aac-mono-proxy.m4a");
      execFileSync(resolveFfmpegPath(), ["-v", "error", ...buildAudioProxyArgs(src, out, proxyStreamsFor(await probeMedia(src)))]);
      const probe = JSON.parse(
        execFileSync(resolveFfprobePath(), ["-v", "error", "-show_entries", "stream=codec_name,profile,channels", "-of", "json", out]).toString(),
      );
      expect(probe.streams).toEqual([{ codec_name: "aac", profile: "LC", channels: 2 }]);
    });
  });
});
