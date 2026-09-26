/**
 * Integration (real ffmpeg): every export backend keeps a stream that starts
 * after its file does where the preview plays it, for every trim point.
 *
 * libi measures source time from the file's start as ffmpeg defines it
 * (`format.start_time`), and so does the preview (source-time-origin.ts). A
 * stream can start later than its file: after a subtitle or the other stream,
 * or when a camera or a microphone started late. Before this fix:
 * - a clip's `atrim` + `asetpts=PTS-STARTPTS` dropped the audio's lead, so a
 *   clip trimmed inside it played early by what was left of it (400 ms at
 *   trim 0 and 200 ms at trim 0.2 on a file whose audio starts 0.4 s in), in
 *   the ffmpeg-overlay mix, the chromium-render mux and the duck envelopes;
 * - a base whose streams all start late came out of stream-copy-trim and
 *   ffmpeg-overlay starting late, so every reader of the file played it early;
 * - a cut inside the video's lead (`-ss`, even `-ss 0`) seeked the demuxer to
 *   the video's first keyframe and dropped the audio before it;
 * - a video overlay played its source from the composition's start rather
 *   than its own (a separate bug found while checking the overlays).
 *
 * Fixtures, made here with libi's ffmpeg: a luma ramp (each frame's
 * brightness says which frame it is) and seeded noise (one correlation peak).
 * - `subearly.mkv`: both streams at 1.0 s, a subtitle at 0.6 s. The file
 *   starts at 0.6: the audio and the video both lead by 0.4 s.
 * - `alate.mp4`: the audio starts 0.4 s after the video.
 * - `vlate.mp4` / `vlate.mkv`: the video starts 0.4 s after the audio.
 * The reference is ffmpeg's decode of the source on its own timeline (a lead
 * padded with silence), which is what the preview plays.
 * docs-local/qa/2026-09-25-mediabunny-upgrade-report.md (Export lead fix)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import type { AudioClip, Composition, DuckSettings, Overlay } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { StreamCopyTrimBackend } from "@/lib/export/backends/stream-copy-trim";
import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import { muxAudioIntoRender } from "@/lib/export/render-audio-mux";
import { renderDuckEnvelopes, ENVELOPE_SAMPLE_RATE } from "@/lib/export/duck-envelopes";
import { extractAudio } from "@/lib/analysis/manager";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { buildProxyArgs, proxyStreamsFor } from "@/lib/proxy/args";
import { fallbackOrigin } from "@/lib/engine/source-time-origin";
import { Input, FilePathSource, ALL_FORMATS } from "mediabunny";

const FF = resolveFfmpegPath();
const FP = resolveFfprobePath();
const R = 48000;
const FPS = 25;
const DUR = 3;
const PIECE = "p-lead";
const SETTINGS = { format: "mp4" as const, codec: "avc" as const, bitrate: 0, width: 32, height: 32, fps: FPS };
// Frame n has luma 40 + 6n (mod 180): a frame names itself within 1.2 s.
const RAMP = `nullsrc=s=32x32:r=${FPS}:d=${DUR},geq=lum='40+mod(N*6\\,180)':cb=128:cr=128`;
const NOISE = `anoisesrc=d=${DUR}:c=white:seed=7:a=0.3:r=${R}`;
const ENC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", String(FPS), "-c:a", "aac", "-b:a", "192k"];
const TRIMS = [0, 0.2, 1.37]; // inside the 0.4 s lead, and past it

const ff = (args: string[]) => execFileSync(FF, ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
const probe = (args: string[]) => execFileSync(FP, ["-v", "error", ...args]).toString().trim();
const num = (s: string) => parseFloat(s);

const formatStart = (f: string) => num(probe(["-show_entries", "format=start_time", "-of", "csv=p=0", f])) || 0;

/** Mono PCM on the file's own timeline: a stream that starts late is preceded by silence. */
function pcm(file: string): Float32Array {
  // -copyts, then back by the file's start: an Ogg or MPEG-TS input read for
  // its audio alone would otherwise have its start moved to the audio's.
  const start = formatStart(file);
  const b = execFileSync(FF, ["-v", "error", "-copyts", "-i", file, "-map", "0:a:0", "-af", `asetpts=PTS-(${start})/TB,aresample=async=1:first_pts=0`,
    "-ac", "1", "-ar", String(R), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
const firstSound = (x: Float32Array) => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-3) return i / R; return Infinity; };

/**
 * Lag (ms) of `out` against `src` placed at `clipStart` from `trim`, over
 * [from, from + len) of the output; positive = the export is early. Coarse
 * search over ±500 ms, then to the sample.
 */
function lagMs(out: Float32Array, src: Float32Array, clipStart: number, trim: number, from: number, len: number): { ms: number; corr: number } {
  const a = Math.round(from * R), n = Math.round(len * R), off = Math.round((trim - clipStart) * R);
  const corr = (L: number) => {
    let x = 0, xx = 0, yy = 0;
    for (let i = a; i < a + n; i += 2) { const u = out[i] ?? 0, v = src[i + off + L] ?? 0; x += u * v; xx += u * u; yy += v * v; }
    return xx && yy ? x / Math.sqrt(xx * yy) : -1;
  };
  let best = { c: -2, lag: 0 };
  for (let L = -R / 2; L <= R / 2; L += 8) { const c = corr(L); if (c > best.c) best = { c, lag: L }; }
  for (let L = best.lag - 8; L <= best.lag + 8; L++) { const c = corr(L); if (c > best.c) best = { c, lag: L }; }
  return { ms: (best.lag / R) * 1000, corr: best.c };
}

/** The export's audio against the source's: in place to the sample, silent until the source's audio starts. */
function expectAudioInPlace(out: string, src: string | Float32Array, clipStart: number, trim: number, minCorr = 0.95) {
  const o = pcm(out);
  const s = typeof src === "string" ? pcm(src) : src;
  const { ms, corr } = lagMs(o, s, clipStart, trim, clipStart + 0.9, 0.5);
  expect(corr).toBeGreaterThan(minCorr);
  expect(Math.abs(ms)).toBeLessThan(0.5); // Matroska stores whole milliseconds
  // The lead left after the trim point is silence, in the export as in the source.
  expect(firstSound(o)).toBeCloseTo(clipStart + Math.max(0, firstSound(s) - trim), 2);
}

/**
 * The export's picture: each frame is the source frame the preview shows at
 * that time (within a frame), the source's first frame while the source's
 * video hasn't started, and the file's timeline starts at the composition's 0.
 */
function expectVideoInPlace(out: string, src: string, clipStart: number, trim: number, rect = { x: 8, y: 8, w: 16, h: 16 }) {
  expect(formatStart(out)).toBeLessThan(0.001);
  const times = probe(["-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", out]).split("\n").map(num);
  const W = SETTINGS.width, H = SETTINGS.height;
  const y = execFileSync(FF, ["-v", "error", "-i", out, "-map", "0:v:0", "-fps_mode", "passthrough", "-vf", "extractplanes=y", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const vStart = num(probe(["-select_streams", "v:0", "-show_entries", "stream=start_time", "-of", "csv=p=0", src])) - formatStart(src);
  let checked = 0;
  for (let k = 0; k < times.length; k++) {
    // Frames inside the layer's 2 s window only.
    if (times[k] < clipStart - 1e-6 || times[k] > clipStart + 2 - 0.05) continue;
    const source = times[k] - clipStart + trim; // the source time the preview shows
    if (source > DUR - 0.2) continue;
    let m = 0;
    for (let r = rect.y; r < rect.y + rect.h; r++) for (let c = rect.x; c < rect.x + rect.w; c++) m += y[k * W * H + r * W + c];
    m /= rect.w * rect.h;
    const frame = Math.round((m - 40) / 6); // mod 30
    // Inside the video's lead: its first frame, as the preview and the canvas export show.
    const expected = source < vStart ? 0 : Math.floor((source - vStart) * FPS + 1e-6);
    const d = ((((frame - expected) % 30) + 45) % 30) - 15;
    expect(Math.abs(d), `frame at ${times[k].toFixed(3)} s shows source frame ${frame}, expected ${expected} (mod 30)`).toBeLessThanOrEqual(1);
    checked++;
  }
  expect(checked).toBeGreaterThan(20);
}

skipIf("export keeps a stream that starts after its file does (real ffmpeg)", () => {
  let dir: string;
  let render: string;
  const FILES = ["subearly.mkv", "alate.mp4", "vlate.mp4", "vlate.mkv"];

  beforeAll(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    ff(["-f", "lavfi", "-i", RAMP, "-itsoffset", "0.4", "-f", "lavfi", "-i", NOISE, "-map", "0:v", "-map", "1:a", ...ENC, path.join(dir, "alate.mp4")]);
    for (const ext of ["mp4", "mkv"]) {
      ff(["-itsoffset", "0.4", "-f", "lavfi", "-i", RAMP, "-f", "lavfi", "-i", NOISE, "-map", "0:v", "-map", "1:a", ...ENC, path.join(dir, `vlate.${ext}`)]);
    }
    fs.writeFileSync(path.join(dir, "early.srt"), "1\n00:00:00,600 --> 00:00:02,000\nhi\n");
    ff(["-itsoffset", "1", "-f", "lavfi", "-i", RAMP, "-itsoffset", "1", "-f", "lavfi", "-i", NOISE, "-i", path.join(dir, "early.srt"),
      "-map", "0:v", "-map", "1:a", "-map", "2:s", ...ENC, "-c:s", "srt", path.join(dir, "subearly.mkv")]);
    ff(["-f", "lavfi", "-i", `color=c=black:s=32x32:r=${FPS}:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "black.mp4")]);
    ff(["-f", "lavfi", "-i", "color=c=white:s=4x4", "-frames:v", "1", path.join(dir, "dot.png")]);
    render = path.join(dir, "render.mp4");
    fs.copyFileSync(path.join(dir, "black.mp4"), render);
    const rows: Array<[string, "video" | "image"]> = [...FILES.map((f): [string, "video"] => [f, "video"]), ["black.mp4", "video"], ["dot.png", "image"]];
    testDb.insert(files).values(rows.map(([name, type]) => ({
      id: name, pieceId: PIECE, filename: name, name, description: "", type, storagePath: `${PIECE}/${name}`,
      contentType: type === "video" ? "video/mp4" : "image/png", size: fs.statSync(path.join(dir, name)).size,
    }))).run();
  });
  afterAll(() => cleanupTempDir(tempDir));

  const src = (f: string) => path.join(dir, f);
  const out = (name: string) => path.join(tempDir, name);
  const base = (fileId: string, trim: number, dur = 2): Overlay => ({
    id: "o-base", kind: "video", fileId, videoUrl: "", startTime: 0, duration: dur, z: 0, opacity: 1, fit: "cover",
    rect: { x: 0, y: 0, width: 32, height: 32 }, sourceWidth: 32, sourceHeight: 32, trim: { start: trim, end: trim + dur },
  } as Overlay);
  const baseAudio = (fileId: string, trim: number, volume = 1, dur = 2): AudioClip => ({
    id: "base-audio", kind: "inline", fileId, linkedOverlayId: "o-base", startTime: 0, duration: dur, trimStart: trim, volume, enabled: true,
  });
  const clip = (fileId: string, trim: number): AudioClip =>
    ({ id: "c1", kind: "standalone", fileId, startTime: 0.5, duration: 2, trimStart: trim, volume: 1, enabled: true });
  const dot = { id: "o-dot", kind: "image", fileId: "dot.png", rect: { x: 0, y: 0, width: 4, height: 4 }, startTime: 0, duration: 2, z: 1, opacity: 1 } as Overlay;
  const comp = (overlays: Overlay[], audioClips: AudioClip[]) =>
    ({ id: "c", name: "c", width: 32, height: 32, fps: FPS, overlays, audioClips }) as Composition;

  it("fixtures: the streams really start 0.4 s after their file", () => {
    const lead = (f: string, sel: string) =>
      num(probe(["-select_streams", sel, "-show_entries", "stream=start_time", "-of", "csv=p=0", src(f)])) - formatStart(src(f));
    expect(lead("subearly.mkv", "v:0")).toBeCloseTo(0.4, 2);
    expect(lead("subearly.mkv", "a:0")).toBeCloseTo(0.4, 2);
    expect(lead("vlate.mp4", "v:0")).toBeCloseTo(0.4, 2);
    expect(firstSound(pcm(src("alate.mp4")))).toBeGreaterThan(0.37);
  });

  it("probeMedia reports each primary stream's lead from the file's start", async () => {
    const sub = await probeMedia(src("subearly.mkv"));
    expect(sub.startTime).toBeCloseTo(0.6, 3);
    expect(sub.videoLead).toBeCloseTo(0.4, 3);
    expect(sub.audioLead).toBeCloseTo(0.4, 2);
    const v = await probeMedia(src("vlate.mkv"));
    expect(v.videoLead).toBeCloseTo(0.4, 3);
    expect(v.audioLead).toBe(0);
    const a = await probeMedia(src("alate.mp4"));
    expect(a.videoLead).toBe(0);
    expect(a.audioLead).toBeGreaterThan(0.37); // 0.4 less the AAC priming the edit list covers
  });

  describe.each(["subearly.mkv", "alate.mp4", "vlate.mp4"])("%s", (f) => {
    it.each(TRIMS)("stream-copy-trim, trim %s", async (trim) => {
      const o = out(`sct-${f}-${trim}.mp4`);
      await new StreamCopyTrimBackend().run({ composition: comp([base(f, trim)], [baseAudio(f, trim)]), settings: SETTINGS, outputPath: o });
      expectAudioInPlace(o, src(f), 0, trim);
      // Cut at 0 with the audio there, a copy keeps the video's lead as the
      // source has it (and as the preview plays the source). Everywhere else
      // the output starts with a picture.
      if (f === "vlate.mp4" && trim === 0) expect(formatStart(o)).toBeLessThan(0.001);
      else expectVideoInPlace(o, src(f), 0, trim);
    }, 60_000);

    it.each(TRIMS)("ffmpeg-overlay, the base video and its audio, trim %s", async (trim) => {
      const o = out(`ovl-${f}-${trim}.mp4`);
      await new FfmpegOverlayBackend().run({ composition: comp([base(f, trim), dot], [baseAudio(f, trim, 0.8)]), settings: SETTINGS, outputPath: o });
      expectAudioInPlace(o, src(f), 0, trim);
      expectVideoInPlace(o, src(f), 0, trim);
    }, 60_000);

    it.each(TRIMS)("ffmpeg-overlay, a standalone clip at 0.5 s, trim %s", async (trim) => {
      const o = out(`clip-${f}-${trim}.mp4`);
      await new FfmpegOverlayBackend().run({ composition: comp([base("black.mp4", 0, DUR), dot], [clip(f, trim)]), settings: SETTINGS, outputPath: o });
      expectAudioInPlace(o, src(f), 0.5, trim);
    }, 60_000);

    it.each([...TRIMS, 0.45])("chromium-render audio mux, a clip at 0.5 s, trim %s", async (trim) => {
      const o = await muxAudioIntoRender({
        videoPath: render, audioClips: [clip(f, trim)], format: "mp4", durationSeconds: DUR,
        files: [{ id: f, pieceId: PIECE, filename: f, name: f, type: "video" } as FileRecord],
      });
      expectAudioInPlace(o, src(f), 0.5, trim);
      fs.rmSync(o, { force: true });
    }, 60_000);
  });

  it.each(TRIMS)("stream-copy-trim of a muted base whose video starts late, trim %s", async (trim) => {
    const o = out(`sctm-${trim}.mp4`);
    await new StreamCopyTrimBackend().run({ composition: comp([base("vlate.mkv", trim)], []), settings: SETTINGS, outputPath: o });
    expectVideoInPlace(o, src("vlate.mkv"), 0, trim);
  }, 60_000);

  it.each([
    ["vlate.mkv", 0], ["vlate.mkv", 0.5], ["subearly.mkv", 0.5], ["alate.mp4", 0.5],
  ] as const)("ffmpeg-overlay, %s as a video overlay starting at %s s", async (f, at) => {
    const o = out(`asset-${f}-${at}.mp4`);
    const overlay = { ...base(f, 0), id: "o-asset", z: 1, trim: undefined, startTime: at, duration: 2 } as Overlay;
    await new FfmpegOverlayBackend().run({ composition: comp([base("black.mp4", 0, DUR), overlay], []), settings: SETTINGS, outputPath: o });
    expectVideoInPlace(o, src(f), at, 0);
  }, 60_000);

  it.each(["subearly.mkv", "vlate.mkv", "alate.mp4"])("the proxy of %s starts where its source does", async (f) => {
    // The preview reads a proxy from its first timestamp (no server timing):
    // that must be 0, with the source's leads kept inside the proxy.
    const proxy = out(`proxy-${f}.mp4`);
    execFileSync(FF, ["-v", "error", ...buildProxyArgs(src(f), proxy, { fps: FPS, ...proxyStreamsFor(await probeMedia(src(f))) })]);
    const input = new Input({ source: new FilePathSource(proxy), formats: ALL_FORMATS });
    expect(await fallbackOrigin(input)).toBe(0);
    input.dispose();
    expectAudioInPlace(proxy, src(f), 0, 0, 0.85); // a proxy is 128 kb/s AAC of the source's AAC
    expectVideoInPlace(proxy, src(f), 0, 0);
  }, 60_000);

  it.each(TRIMS)("duck envelope: a sidechain trimmed at %s ducks when its audio starts", async (trim) => {
    // Reference: the same audio as a WAV that starts with its file.
    const ref = path.join(dir, "subearly-ref.wav");
    if (!fs.existsSync(ref)) ff(["-i", src("subearly.mkv"), "-map", "0:a:0", "-af", "aresample=async=1:first_pts=0", "-c:a", "pcm_f32le", ref]);
    const duck: DuckSettings = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: -12 };
    const curve = async (p: string, tag: string) => {
      const d = path.join(tempDir, `duck-${tag}-${trim}`);
      fs.mkdirSync(d, { recursive: true });
      const wav = (await renderDuckEnvelopes({
        inputs: [{ clipId: "music", duck, sidechains: [{ path: p, startTime: 0.5, trimStart: trim, duration: 1.5, volume: 1 }] }],
        timelineSeconds: DUR, outDir: d,
      })).get("music")!;
      const b = fs.readFileSync(wav);
      return new Float32Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.byteLength));
    };
    const got = await curve(src("subearly.mkv"), "mkv");
    const want = await curve(ref, "ref");
    const firstDuck = (c: Float32Array) => c.findIndex((g) => g < 0.9) / ENVELOPE_SAMPLE_RATE;
    expect(firstDuck(want)).toBeCloseTo(0.5 + Math.max(0, 0.4 - trim), 1);
    expect(Math.abs(firstDuck(got) - firstDuck(want))).toBeLessThan(0.002);
  }, 60_000);

  describe("files ffmpeg reads off their timeline (review round 3)", () => {
    // - MPEG-TS and Ogg: read for its audio alone, the ffmpeg CLI moves an
    //   input's start to the audio's ("Correcting start time"), so a clip, a
    //   duck sidechain or a transcription extract of a file whose audio starts
    //   after its video lost that lead: 400 ms early here.
    // - FLAC in MP4 behind an edit list (a -c copy cut): ffmpeg's decode
    //   repeats and skips 85 ms frames (20 → −236 ms over 3 s); the preview
    //   (mediabunny) decodes it right. Read with -advanced_editlist 0 and moved
    //   back by the edit's media time, ffmpeg's decode is right too.
    const LONG = 5;
    const RAMP5 = RAMP.replace(`d=${DUR}`, `d=${LONG}`);
    const NOISE5 = NOISE.replace(`d=${DUR}`, `d=${LONG}`);
    let flacSource: Float32Array;
    beforeAll(() => {
      ff(["-f", "lavfi", "-i", RAMP5, "-itsoffset", "0.4", "-f", "lavfi", "-i", NOISE5, "-map", "0:v", "-map", "1:a", ...ENC, path.join(dir, "lead.ts")]);
      ff(["-f", "lavfi", "-i", RAMP5, "-itsoffset", "0.4", "-f", "lavfi", "-i", NOISE5, "-map", "0:v", "-map", "1:a",
        "-c:v", "libtheora", "-c:a", "libopus", path.join(dir, "lead.ogg")]);
      // Lossless white noise has a one-sample correlation peak the coarse search
      // can step over; band-limited, it doesn't.
      ff(["-f", "lavfi", "-i", RAMP5, "-f", "lavfi", "-i", `${NOISE5},lowpass=f=3000`, "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", String(FPS), "-c:a", "flac", path.join(dir, "s-flac.mp4")]);
      ff(["-ss", "1.3", "-to", "4.3", "-i", path.join(dir, "s-flac.mp4"), "-c", "copy", path.join(dir, "t-flac.mp4")]);
      flacSource = pcm(path.join(dir, "s-flac.mp4")); // the uncut file decodes right
      testDb.insert(files).values(["lead.ts", "lead.ogg", "t-flac.mp4"].map((name) => ({
        id: name, pieceId: PIECE, filename: name, name, description: "", type: "video" as const, storagePath: `${PIECE}/${name}`,
        contentType: "video/mp4", size: fs.statSync(path.join(dir, name)).size,
      }))).run();
    });
    /** The cut's source time t is the uncut file's 1.3 + t. */
    const FLAC_CUT_AT = 1.3;

    it("the probe says how to read each", async () => {
      // The audio's start: 0.4 s less the AAC priming ffmpeg keeps in MPEG-TS (1024 samples).
      expect((await probeMedia(src("lead.ts"))).audioRead).toEqual({ inputArgs: [], ptsShift: expect.closeTo(0.4, 1) });
      expect((await probeMedia(src("lead.ogg"))).audioRead).toEqual({ inputArgs: [], ptsShift: expect.closeTo(0.4, 2) });
      // Moved back by where ffmpeg starts the file without its edit list: the pre-roll the cut kept.
      const plain = num(probe(["-advanced_editlist", "0", "-show_entries", "format=start_time", "-of", "csv=p=0", src("t-flac.mp4")]));
      expect(plain).toBeLessThan(0);
      expect((await probeMedia(src("t-flac.mp4"))).audioRead).toEqual({ inputArgs: ["-advanced_editlist", "0"], ptsShift: expect.closeTo(plain, 6) });
      expect((await probeMedia(src("s-flac.mp4"))).audioRead).toBeUndefined();
      expect((await probeMedia(src("subearly.mkv"))).audioRead).toBeUndefined();
    });

    it("the reference: ffmpeg's own decode of the FLAC cut is off the cut's samples (why audioRead exists)", () => {
      const cut = pcm(src("t-flac.mp4"));
      const at = (t: number) => lagMs(cut, flacSource, 0, FLAC_CUT_AT, t, 0.3).ms;
      // HOW it is off depends on the build: macOS's 9.0.1 (martin-riedl)
      // starts in place and is whole 85 ms frames off by 2.5 s; BtbN's n9.0
      // on Linux (CI, and libi's own Linux install) is ~64 ms off from the
      // first window. Either way the plain decode is not the cut's samples.
      expect(Math.max(Math.abs(at(0.1)), Math.abs(at(2.5)))).toBeGreaterThan(40);
    });

    it.each(["lead.ts", "lead.ogg"])("%s: a clip keeps the audio's lead, in the ffmpeg-overlay mix and the chromium-render mux", async (f) => {
      for (const trim of [0, 0.2]) {
        const o = out(`ts-clip-${f}-${trim}.mp4`);
        await new FfmpegOverlayBackend().run({ composition: comp([base("black.mp4", 0, DUR), dot], [clip(f, trim)]), settings: SETTINGS, outputPath: o });
        expectAudioInPlace(o, src(f), 0.5, trim);
        const m = await muxAudioIntoRender({
          videoPath: render, audioClips: [clip(f, trim)], format: "mp4", durationSeconds: DUR,
          files: [{ id: f, pieceId: PIECE, filename: f, name: f, type: "video" } as FileRecord],
        });
        expectAudioInPlace(m, src(f), 0.5, trim);
        fs.rmSync(m, { force: true });
      }
    }, 120_000);

    it("the FLAC cut: a clip, the base's own audio, and the chromium-render mux play the cut's samples in place", async () => {
      for (const trim of [0, 1.0]) {
        const c = out(`flac-clip-${trim}.mp4`);
        await new FfmpegOverlayBackend().run({ composition: comp([base("black.mp4", 0, DUR), dot], [clip("t-flac.mp4", trim)]), settings: SETTINGS, outputPath: c });
        expectAudioInPlace(c, flacSource, 0.5, trim + FLAC_CUT_AT);
        const m = await muxAudioIntoRender({
          videoPath: render, audioClips: [clip("t-flac.mp4", trim)], format: "mp4", durationSeconds: DUR,
          files: [{ id: "t-flac.mp4", pieceId: PIECE, filename: "t-flac.mp4", name: "t-flac.mp4", type: "video" } as FileRecord],
        });
        expectAudioInPlace(m, flacSource, 0.5, trim + FLAC_CUT_AT);
        fs.rmSync(m, { force: true });
      }
      const b = out("flac-base.mp4");
      await new FfmpegOverlayBackend().run({ composition: comp([base("t-flac.mp4", 0.5), dot], [baseAudio("t-flac.mp4", 0.5, 0.8)]), settings: SETTINGS, outputPath: b });
      expectAudioInPlace(b, flacSource, 0, 0.5 + FLAC_CUT_AT);
    }, 120_000);

    it("the FLAC cut's proxy plays its samples in place", async () => {
      const proxy = out("flac-proxy.mp4");
      execFileSync(FF, ["-v", "error", ...buildProxyArgs(src("t-flac.mp4"), proxy, { fps: FPS, ...proxyStreamsFor(await probeMedia(src("t-flac.mp4"))) })]);
      expectAudioInPlace(proxy, flacSource, 0, FLAC_CUT_AT, 0.85);
    }, 60_000);

    it.each(["alate.mp4", "lead.ts", "t-flac.mp4"])("%s: the transcription extract (audio.wav) is on the file's timeline", async (f) => {
      const { audioPath } = await extractAudio({ fileId: f, sampleRate: R });
      const wav = execFileSync(FF, ["-v", "error", "-i", audioPath, "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
      const got = new Float32Array(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
      if (f === "t-flac.mp4") {
        const { ms, corr } = lagMs(got, flacSource, 0, FLAC_CUT_AT, 1.5, 0.5);
        expect(corr).toBeGreaterThan(0.95);
        expect(Math.abs(ms)).toBeLessThan(0.5);
      } else {
        expect(firstSound(got)).toBeCloseTo(firstSound(pcm(src(f))), 2); // the lead kept, 0.38–0.4 s
        expect(firstSound(got)).toBeGreaterThan(0.35);
      }
    }, 60_000);

    it.each(["lead.ts", "t-flac.mp4"])("%s: a duck sidechain read through the probe's fix ducks when its audio starts", async (f) => {
      const duck: DuckSettings = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: -12 };
      const read = (await probeMedia(src(f))).audioRead;
      const d = path.join(tempDir, `duck-read-${f}`);
      fs.mkdirSync(d, { recursive: true });
      const wav = (await renderDuckEnvelopes({
        inputs: [{ clipId: "music", duck, sidechains: [{ path: src(f), startTime: 0.5, trimStart: 0, duration: 2, volume: 1, read }] }],
        timelineSeconds: DUR, outDir: d,
      })).get("music")!;
      const b = fs.readFileSync(wav);
      const curve = new Float32Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.byteLength));
      const firstDuck = curve.findIndex((g) => g < 0.9) / ENVELOPE_SAMPLE_RATE;
      // The TS audio starts 0.4 s in; the FLAC cut's at once.
      expect(firstDuck).toBeCloseTo(0.5 + (f === "lead.ts" ? 0.4 : 0), 1);
    }, 60_000);
  });
});
