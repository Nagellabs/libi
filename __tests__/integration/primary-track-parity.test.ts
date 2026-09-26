/**
 * Integration (real ffmpeg + real ffprobe + real mediabunny): the track the
 * preview decodes (`lib/engine/primary-track.ts`, over mediabunny's tracks) is
 * the stream the server maps for the proxy and the export mix
 * (`lib/ffmpeg/probe.ts#primaryStreamIndex`, over ffprobe's streams). One rule,
 * two demuxers; this runs both over files that stress where they differ.
 *
 * Tracks are told apart by shape: audio 1 ch / 44.1 kHz vs 2 ch / 48 kHz,
 * video 160×90 vs 320×180, still images 64×64.
 *
 * Expected, documented divergences, which still end on the server's stream:
 * - "via proxy": the preview's pick can't be decoded (codec null: a still image
 *   stored as Matroska V_MS/VFW/FOURCC, which only the codec private data
 *   names), so the preview plays the proxy, which carries the server's pick.
 * - "no listed track": mediabunny lists no audio at all (every audio track is
 *   disabled); the audio engine then plays the proxy's audio
 *   (web-audio-engine-fallback.test.ts, review M4).
 * The first 20 fixtures are the final review's parity set; the rest cover the
 * week's still-image rule, silent video, and the tracks mediabunny drops.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS, type InputAudioTrack, type InputVideoTrack } from "mediabunny";
import { primaryAudioTrack, primaryVideoTrack } from "@/lib/engine/primary-track";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

const V = ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=25:d=1"];
const V2 = ["-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=1"];
const A1 = ["-f", "lavfi", "-i", "sine=f=440:sample_rate=44100:d=1"];
const A2 = ["-f", "lavfi", "-i", "sine=f=880:sample_rate=48000:d=1"];
const X = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
const TWO = ["-c:a:0", "aac", "-b:a:0", "64k", "-ac:a:0", "1", "-c:a:1", "aac", "-b:a:1", "256k", "-ac:a:1", "2"];
const MAP3 = ["-map", "0", "-map", "1", "-map", "2"];

type Expect = "same" | "via proxy" | "no listed track";
interface Fixture {
  name: string;
  make: (dir: string, out: string) => void;
  audio?: Expect;
  video?: Expect;
}

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}

/** Replace the `n`-th occurrence of `find` with `repl` (same length) in a file. */
function patchNth(file: string, find: Buffer, repl: Buffer, n: number): void {
  const b = fs.readFileSync(file);
  let at = -1;
  for (let i = 0; i <= n; i++) {
    at = b.indexOf(find, at + 1);
    if (at < 0) throw new Error(`patch target ${i} not found in ${file}`);
  }
  repl.copy(b, at);
  fs.writeFileSync(file, b);
}

const FIXTURES: Fixture[] = [
  { name: "noaudio.mp4", make: (_d, o) => ff([...V, ...X, o]) },
  { name: "single.mp4", make: (_d, o) => ff([...V, ...A1, "-map", "0", "-map", "1", ...X, "-c:a", "aac", o]) },
  { name: "twodefault.mp4", make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "default", "-disposition:a:1", "default", o]) },
  { name: "twodefault.mkv", make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "default", "-disposition:a:1", "default", o]) },
  { name: "nodefault.mkv", make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:v", "0", "-disposition:a:0", "0", "-disposition:a:1", "0", o]) },
  { name: "seconddefault.mp4", make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "0", "-disposition:a:1", "default", o]) },
  { name: "nodefault.mp4", make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "0", "-disposition:a:1", "0", o]) },
  {
    // Every tkhd disabled: patch the "enabled" flag byte of each tkhd.
    name: "noenabled.mp4",
    make: (_d, o) => {
      ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "default", "-disposition:a:1", "default", o]);
      const b = fs.readFileSync(o);
      for (let at = b.indexOf("tkhd"); at >= 0; at = b.indexOf("tkhd", at + 4)) b[at + 7] &= ~1;
      fs.writeFileSync(o, b);
    },
  },
  { name: "timecode.mov", make: (_d, o) => ff([...V, ...A1, "-map", "0", "-map", "1", ...X, "-c:a", "aac", "-timecode", "01:00:00:00", o]) },
  { name: "timecode.mp4", make: (_d, o) => ff([...V, ...A1, "-map", "0", "-map", "1", ...X, "-c:a", "aac", "-timecode", "01:00:00:00", "-write_tmcd", "1", o]) },
  {
    name: "cover.mp4",
    make: (d, o) => ff([...V, ...A1, "-i", path.join(d, "cover.jpg"), ...MAP3, "-c:v:0", "libx264", "-pix_fmt", "yuv420p", "-c:v:1", "mjpeg", "-c:a", "aac", "-disposition:v:1", "attached_pic", o]),
  },
  {
    name: "coverfirst.mp4",
    make: (d, o) => ff(["-i", path.join(d, "cover.jpg"), ...V, ...A1, ...MAP3, "-c:v:0", "mjpeg", "-c:v:1", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-disposition:v:0", "attached_pic", o]),
  },
  { name: "cover.mkv", make: (d, o) => ff([...V, ...A1, "-map", "0", "-map", "1", ...X, "-c:a", "aac", "-attach", path.join(d, "cover.jpg"), "-metadata:s:t", "mimetype=image/jpeg", o]) },
  { name: "cover.mp3", make: (d, o) => ff([...A1, "-i", path.join(d, "cover.jpg"), "-map", "0", "-map", "1", "-c:a", "libmp3lame", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-id3v2_version", "3", o]) },
  { name: "cover.m4a", make: (d, o) => ff([...A1, "-i", path.join(d, "cover.jpg"), "-map", "0", "-map", "1", "-c:a", "aac", "-c:v", "mjpeg", "-disposition:v", "attached_pic", o]) },
  { name: "twovideo.mkv", make: (_d, o) => ff([...V, ...V2, "-map", "0", "-map", "1", ...X, "-disposition:v:0", "0", "-disposition:v:1", "default", o]) },
  { name: "twovideo.mp4", make: (_d, o) => ff([...V, ...V2, "-map", "0", "-map", "1", ...X, "-disposition:v:0", "0", "-disposition:v:1", "default", o]) },
  { name: "audiofirst.mov", make: (_d, o) => ff([...A1, ...V, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "default", "-disposition:a:1", "default", o]) },
  {
    name: "twodefault.webm",
    make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, "-c:v", "libvpx-vp9", "-b:v", "200k", "-deadline", "realtime", "-c:a:0", "libopus", "-b:a:0", "32k", "-ac:a:0", "1", "-c:a:1", "libopus", "-b:a:1", "128k", "-ac:a:1", "2", o]),
  },
  { name: "twoaudio.ts", make: (_d, o) => ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, o]) },
  // The week's still-image rule (0410fc71): a cover stored as a plain video track.
  {
    name: "coverfirst.mkv",
    make: (d, o) => ff(["-i", path.join(d, "cover.jpg"), ...V, ...A1, ...MAP3, "-c:v:0", "mjpeg", "-c:v:1", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-disposition:v:0", "attached_pic", o]),
  },
  {
    name: "pngfirst.mkv",
    make: (d, o) => ff(["-i", path.join(d, "cover.png"), ...V, ...A1, ...MAP3, "-c:v:0", "png", "-c:v:1", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-disposition:v:0", "attached_pic", o]),
    video: "via proxy",
  },
  {
    name: "mjpegfirst.mov",
    make: (d, o) => ff(["-loop", "1", "-i", path.join(d, "cover.jpg"), ...V, ...A1, ...MAP3, "-t", "1", "-c:v:0", "mjpeg", "-c:v:1", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", o]),
  },
  { name: "mjpegonly.mkv", make: (_d, o) => ff([...V, ...A1, "-map", "0", "-map", "1", "-c:v", "mjpeg", "-c:a", "aac", o]) },
  { name: "mjpegonly.mov", make: (_d, o) => ff([...V, ...A1, "-map", "0", "-map", "1", "-c:v", "mjpeg", "-c:a", "pcm_s16le", o]) },
  // A silent video (d8e70b8d): no audio on either side.
  { name: "silent.mov", make: (_d, o) => ff([...V, ...X, o]) },
  // Review M4: an MP4 audio track with an objectTypeIndication mediabunny
  // doesn't know (0xA5). It is still listed (codec null), so both sides agree.
  {
    name: "oti-first.mp4",
    make: (_d, o) => {
      ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "default", "-disposition:a:1", "default", o]);
      // The first esds' DecoderConfigDescriptor: tag 0x04, size, OTI 0x40.
      const b = fs.readFileSync(o);
      const esds = b.indexOf("esds");
      const tag = b.indexOf(Buffer.from([0x04]), esds + 12);
      for (let i = tag + 1; i < tag + 6; i++) if (b[i] === 0x40) { b[i] = 0xa5; break; }
      fs.writeFileSync(o, b);
    },
  },
  // Review M4: a Matroska track with FlagEnabled = 0, which mediabunny drops
  // and ffprobe lists. ffmpeg writes FlagLacing (9C 81 00) per track; turning
  // the audio's into FlagEnabled (B9 81 00) keeps every size.
  {
    name: "disabled-first.mkv",
    make: (_d, o) => {
      ff([...V, ...A1, ...A2, ...MAP3, ...X, ...TWO, "-disposition:a:0", "default", "-disposition:a:1", "default", o]);
      patchNth(o, Buffer.from([0x9c, 0x81, 0x00]), Buffer.from([0xb9, 0x81, 0x00]), 1);
    },
  },
  {
    name: "disabled-only.mkv",
    make: (_d, o) => {
      ff([...V, ...A1, "-map", "0", "-map", "1", ...X, "-c:a", "aac", o]);
      patchNth(o, Buffer.from([0x9c, 0x81, 0x00]), Buffer.from([0xb9, 0x81, 0x00]), 1);
    },
    audio: "no listed track",
  },
];

interface Stream { index: number; codec_type: string; channels?: number; sample_rate?: string; width?: number; height?: number; disposition?: Record<string, number> }

function ffprobeStreams(file: string): Stream[] {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()).streams;
}

const audioShape = async (t: InputAudioTrack | null) => (t ? `${await t.getNumberOfChannels()}ch/${await t.getSampleRate()}` : "none");
const videoShape = async (t: InputVideoTrack | null) => (t ? `${await t.getCodedWidth()}x${await t.getCodedHeight()}` : "none");

skipIf("the preview's primary tracks are the server's primary streams (real ffprobe + mediabunny)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-track-parity-"));
    ff(["-f", "lavfi", "-i", "color=red:s=64x64:d=1", "-frames:v", "1", path.join(dir, "cover.jpg")]);
    ff(["-f", "lavfi", "-i", "color=red:s=64x64:d=1", "-frames:v", "1", path.join(dir, "cover.png")]);
    for (const f of FIXTURES) f.make(dir, path.join(dir, f.name));
  }, 120_000);
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", async (_name, f) => {
    const file = path.join(dir, f.name);
    const streams = ffprobeStreams(file);
    const probed = await probeMedia(file);
    const sa = streams.find((s) => s.index === probed.primaryAudioStreamIndex);
    const sv = streams.find((s) => s.index === probed.primaryVideoStreamIndex);
    const serverA = sa ? `${sa.channels}ch/${sa.sample_rate}` : "none";
    const serverV = sv && sv.disposition?.attached_pic !== 1 ? `${sv.width}x${sv.height}` : "none";

    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    try {
      const pa = await primaryAudioTrack(input);
      const pv = await primaryVideoTrack(input);
      const previewA = await audioShape(pa);
      const previewV = await videoShape(pv);

      switch (f.audio ?? "same") {
        case "same":
          expect(previewA).toBe(serverA);
          break;
        case "no listed track":
          expect(previewA).toBe("none");
          expect(serverA).not.toBe("none");
          break;
        case "via proxy":
          throw new Error("not used for audio");
      }
      switch (f.video ?? "same") {
        case "same":
          expect(previewV).toBe(serverV);
          break;
        case "via proxy":
          expect(await pv!.getCodec()).toBeNull(); // undecodable: the preview plays the proxy
          expect(serverV).not.toBe(previewV);
          break;
        case "no listed track":
          throw new Error("not used for video");
      }
    } finally {
      input.dispose();
    }
  });
});
