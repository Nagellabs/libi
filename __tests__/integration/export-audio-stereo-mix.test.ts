/**
 * Integration: an export mix is stereo when any input is stereo, and a mono
 * input is upmixed at unity, as the preview plays it.
 *
 * Found on the Dreams / Ocean Spray pieces: the clip and the music bed are
 * stereo, the narration is mono and listed first, and the export came out
 * 44.1 kHz MONO. amix negotiates one format for all its inputs and takes the
 * first input's layout (ffmpeg -v verbose shows an auto_aresample
 * `ch:2 chl:stereo … -> ch:1 chl:mono` on the stereo input). The mix's order
 * decided the export's layout.
 *
 * Both server audio paths are rendered with real ffmpeg and read back as
 * samples, never as a filter string:
 *   - `muxAudioIntoRender` (the chromium-render path's audio mux),
 *   - `FfmpegOverlayBackend` (the single-video path, including base audio).
 * stream-copy-trim never mixes (`-c copy`, or `-an`), and canvas-source runs
 * in the browser with no audio stage.
 *
 * Fixtures are made here: narration = mono 300 Hz at amplitude 0.25; music =
 * stereo, 500 Hz LEFT only and 900 Hz RIGHT only, 0.2 each. Levels are read
 * with a Goertzel filter per channel over whole 0.1 s windows, so each tone
 * sits exactly on a bin.
 * docs-local/qa/2026-09-25-dreams-audio-report.md (Fix round 1)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import type { AudioClip, Composition } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { muxAudioIntoRender } from "@/lib/export/render-audio-mux";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";

const RATE = 48000;
const DUR = 2;
const VO_AMP = 0.25;
const MUSIC_AMP = 0.2;
const PIECE = "p-stereo";

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 30_000 });
}

function channelsOf(file: string): number {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file,
  ]).toString().trim();
  return Number(out);
}

/** The audio as it is, NATIVE channel count (no -ac: that would hide a mono mix). */
function decodeChannels(file: string, channels: number): Float32Array[] {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", file, "-vn", "-ar", String(RATE), "-f", "f32le", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(Math.floor(all.length / channels));
    for (let i = 0; i < ch.length; i++) ch[i] = all[i * channels + c];
    out.push(ch);
  }
  return out;
}

/** Amplitude of a sine at `freq` in `x[from, from+n)` (Goertzel; freq on a bin). */
function toneAmp(x: Float32Array, freq: number, from: number, n: number): number {
  const w = (2 * Math.PI * freq) / RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(power, 0))) / n;
}

/** Per-channel amplitudes of the three tones, over the steady middle of the mix. */
function levels(file: string) {
  const ch = channelsOf(file);
  const data = decodeChannels(file, ch);
  const n = RATE / 10; // 0.1 s: 300, 500 and 900 Hz all sit on bins
  const from = Math.round(RATE * 0.7);
  return {
    channels: ch,
    perChannel: data.map((x) => ({
      vo: toneAmp(x, 300, from, n),
      left: toneAmp(x, 500, from, n),
      right: toneAmp(x, 900, from, n),
    })),
  };
}

function expectStereoMix(l: ReturnType<typeof levels>) {
  expect(l.channels).toBe(2);
  const [L, R] = l.perChannel;
  // The music's stereo image survives: 500 Hz only on the left, 900 Hz only on the right.
  expect(L.left).toBeGreaterThan(MUSIC_AMP * 0.85);
  expect(R.right).toBeGreaterThan(MUSIC_AMP * 0.85);
  expect(L.right).toBeLessThan(0.01);
  expect(R.left).toBeLessThan(0.01);
  // The mono narration sits on BOTH sides at unity, not ffmpeg's -3 dB upmix
  // (0.25 → 0.177), which would make the export quieter than the preview.
  for (const side of [L, R]) {
    expect(side.vo).toBeGreaterThan(VO_AMP * 0.9);
    expect(side.vo).toBeLessThan(VO_AMP * 1.1);
  }
}

function record(id: string, filename: string, type: "audio" | "video"): FileRecord {
  return { id, pieceId: PIECE, filename, name: filename, type } as FileRecord;
}

skipIf("export audio mix channel layout (real ffmpeg)", () => {
  let dir: string;

  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    ff(["-f", "lavfi", "-i", `aevalsrc=${VO_AMP}*sin(2*PI*300*t):s=${RATE}:d=${DUR}:c=mono`,
      "-c:a", "pcm_s16le", path.join(dir, "vo.wav")]);
    ff(["-f", "lavfi", "-i",
      `aevalsrc=${MUSIC_AMP}*sin(2*PI*500*t)|${MUSIC_AMP}*sin(2*PI*900*t):s=${RATE}:d=${DUR}:c=stereo`,
      "-c:a", "pcm_s16le", path.join(dir, "music.wav")]);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const clips: AudioClip[] = [
    { id: "vo", kind: "standalone", fileId: "f-vo", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true },
    { id: "music", kind: "standalone", fileId: "f-music", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true },
  ];

  it("fixtures: narration is mono, music is stereo with its tones split left/right", () => {
    expect(channelsOf(path.join(dir, "vo.wav"))).toBe(1);
    const m = levels(path.join(dir, "music.wav"));
    expect(m.channels).toBe(2);
    expect(m.perChannel[0].left).toBeGreaterThan(MUSIC_AMP * 0.95);
    expect(m.perChannel[1].right).toBeGreaterThan(MUSIC_AMP * 0.95);
  });

  it("chromium-render audio mux: mono narration FIRST + stereo music → stereo, image kept, narration at unity", async () => {
    const videoOnly = path.join(dir, "render.mp4");
    ff(["-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", videoOnly]);
    const out = await muxAudioIntoRender({
      videoPath: videoOnly,
      audioClips: clips,
      files: [record("f-vo", "vo.wav", "audio"), record("f-music", "music.wav", "audio")],
      format: "mp4",
      durationSeconds: DUR,
    });
    expect(out).not.toBe(videoOnly);
    expectStereoMix(levels(out));
  });

  it("a failed channel probe (unknown count) still upmixes a mono input at unity and keeps a stereo one intact (M4)", () => {
    // Both counts unknown, as if both ffprobes had timed out.
    const { chain } = buildAudioMixGraph({
      clips,
      inputIndex: new Map([["vo", 0], ["music", 1]]),
      inputChannels: new Map(),
      mixDuration: "longest",
    });
    const out = path.join(dir, "unknown.wav");
    ff(["-i", path.join(dir, "vo.wav"), "-i", path.join(dir, "music.wav"),
      "-filter_complex", chain!, "-map", "[aout]", "-c:a", "pcm_s16le", out]);
    expectStereoMix(levels(out));
  });

  /** Float samples of a WAV written by ffmpeg (walks the RIFF chunks). */
  function readF32(file: string): Float32Array {
    const buf = fs.readFileSync(file);
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === "data") {
        const data = buf.subarray(pos + 8, pos + 8 + size);
        return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
      pos += 8 + size + (size % 2);
    }
    throw new Error(`no data chunk in ${file}`);
  }

  function renderFloat(inputs: string[], chain: string, out: string): Float32Array {
    ff([...inputs.flatMap((i) => ["-i", i]), "-filter_complex", chain, "-map", "[aout]", "-c:a", "pcm_f32le", out]);
    return readF32(out);
  }

  it("a mix that sums past full scale is capped at full scale, never clipped (M3)", () => {
    // Narration 0.7 + a 0.6 stereo bed: the sum peaks at ~1.2.
    ff(["-f", "lavfi", "-i", `aevalsrc=0.7*sin(2*PI*300*t):s=${RATE}:d=${DUR}:c=mono`, "-c:a", "pcm_s16le", path.join(dir, "vo-loud.wav")]);
    ff(["-f", "lavfi", "-i", `aevalsrc=0.6*sin(2*PI*500*t)|0.6*sin(2*PI*900*t):s=${RATE}:d=${DUR}:c=stereo`,
      "-c:a", "pcm_s16le", path.join(dir, "bed-loud.wav")]);
    const { chain } = buildAudioMixGraph({
      clips,
      inputIndex: new Map([["vo", 0], ["music", 1]]),
      inputChannels: new Map([[0, 1], [1, 2]]),
      mixDuration: "longest",
    });
    const inputs = [path.join(dir, "vo-loud.wav"), path.join(dir, "bed-loud.wav")];
    const unguarded = renderFloat(inputs, chain!.replace(/,alimiter=[^[;]*/, ""), path.join(dir, "loud-raw.wav"));
    const guarded = renderFloat(inputs, chain!, path.join(dir, "loud.wav"));
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // The fixture really does overload without the guard…
    expect(peak(unguarded)).toBeGreaterThan(1.1);
    // …and with it nothing passes full scale.
    expect(peak(guarded)).toBeLessThanOrEqual(1);
    expect(guarded.filter((v) => Math.abs(v) > 1).length).toBe(0);
  });

  it("a lone loud source is never touched: a 0.95-peak bed stays 0.95 beside narration that doesn't overlap it (Re-review R2)", () => {
    // The bed plays 0–1 s, the narration 1.2–2 s: nothing ever sums. The old
    // -1 dBFS guard cut this bed from 0.95 to 0.891 only because the piece
    // also had narration.
    ff(["-f", "lavfi", "-i", `aevalsrc=0.95*sin(2*PI*500*t)|0.95*sin(2*PI*900*t):s=${RATE}:d=${DUR}:c=stereo`,
      "-c:a", "pcm_f32le", path.join(dir, "bed-hot.wav")]);
    const hotClips: AudioClip[] = [
      { ...clips[1], id: "bed", startTime: 0, duration: 1 },
      { ...clips[0], id: "vo", startTime: 1.2, duration: 0.8 },
    ];
    const { chain } = buildAudioMixGraph({
      clips: hotClips,
      inputIndex: new Map([["bed", 0], ["vo", 1]]),
      inputChannels: new Map([[0, 2], [1, 1]]),
      mixDuration: "longest",
    });
    expect(chain).toContain("alimiter=");
    const inputs = [path.join(dir, "bed-hot.wav"), path.join(dir, "vo.wav")];
    const without = renderFloat(inputs, chain!.replace(/,alimiter=[^[;]*/, ""), path.join(dir, "hot-raw.wav"));
    const withGuard = renderFloat(inputs, chain!, path.join(dir, "hot.wav"));
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(withGuard)).toBeGreaterThan(0.949);
    expect(withGuard.length).toBe(without.length);
    let maxDiff = 0;
    for (let i = 0; i < without.length; i++) maxDiff = Math.max(maxDiff, Math.abs(without[i] - withGuard[i]));
    expect(maxDiff).toBe(0);
  });

  it("below the limit the guard is bit-transparent and adds no delay — the export stays level-matched to the preview (M3)", () => {
    const { chain } = buildAudioMixGraph({
      clips,
      inputIndex: new Map([["vo", 0], ["music", 1]]),
      inputChannels: new Map([[0, 1], [1, 2]]),
      mixDuration: "longest",
    });
    expect(chain).toContain("alimiter=");
    const inputs = [path.join(dir, "vo.wav"), path.join(dir, "music.wav")];
    const without = renderFloat(inputs, chain!.replace(/,alimiter=[^[;]*/, ""), path.join(dir, "q-raw.wav"));
    const withGuard = renderFloat(inputs, chain!, path.join(dir, "q.wav"));
    expect(withGuard.length).toBe(without.length);
    let maxDiff = 0;
    for (let i = 0; i < without.length; i++) maxDiff = Math.max(maxDiff, Math.abs(without[i] - withGuard[i]));
    expect(maxDiff).toBe(0);
  });

  it("ffmpeg-overlay: a mono BASE track + stereo music → stereo, base upmixed at unity", async () => {
    // A base video whose own audio is the mono narration tone.
    ff(["-f", "lavfi", "-i", `color=c=red:s=64x64:r=10:d=${DUR}`,
      "-i", path.join(dir, "vo.wav"),
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
      path.join(dir, "base.mp4")]);
    const seeded: Array<[string, string, "video" | "audio"]> = [
      ["f-base", "base.mp4", "video"],
      ["f-music", "music.wav", "audio"],
    ];
    testDb.insert(files).values(seeded.map(([id, name, type]) => ({
      id, pieceId: PIECE, filename: name, name, description: "", type,
      storagePath: `${PIECE}/${name}`, contentType: type === "video" ? "video/mp4" : "audio/wav",
      size: fs.statSync(path.join(dir, name)).size,
    }))).run();

    const composition: Composition = {
      id: "c", name: "c", width: 64, height: 64, fps: 10,
      overlays: [{
        id: "o-base", kind: "video", fileId: "f-base", videoUrl: "", startTime: 0, duration: DUR, z: 0,
        opacity: 1, fit: "cover", rect: { x: 0, y: 0, width: 64, height: 64 },
        sourceWidth: 64, sourceHeight: 64, trim: { start: 0, end: DUR },
      }],
      audioClips: [
        // The base's own (mono) audio, kept through the inline clip linked to it.
        { id: "base-audio", kind: "inline", fileId: "f-base", linkedOverlayId: "o-base", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true },
        clips[1],
      ],
    } as Composition;
    const outPath = path.join(tempDir, "overlay-out.mp4");
    await new FfmpegOverlayBackend().run({
      composition,
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 64, height: 64, fps: 10 },
      outputPath: outPath,
    });
    expectStereoMix(levels(outPath));
  });

  describe("files with two audio streams (Review M6)", () => {
    /** video + a:0 mono 300 Hz + a:1 stereo 500/900 Hz flagged default — the
     *  preview (mediabunny) plays a:1; a filter's `[n:a]` would read a:0. */
    function twoTrack(name: string): string {
      const out = path.join(dir, name);
      ff(["-f", "lavfi", "-i", `color=c=blue:s=64x64:r=10:d=${DUR}`,
        "-i", path.join(dir, "vo.wav"), "-i", path.join(dir, "music.wav"),
        "-map", "0:v", "-map", "1:a", "-map", "2:a", "-disposition:a:0", "0", "-disposition:a:1", "default",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k", out]);
      return out;
    }

    it("chromium-render mux exports the track the preview plays", async () => {
      twoTrack("two.mp4");
      const videoOnly = path.join(dir, "render2.mp4");
      ff(["-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", videoOnly]);
      const out = await muxAudioIntoRender({
        videoPath: videoOnly,
        audioClips: [{ ...clips[1], id: "clip", fileId: "f-two" }],
        files: [record("f-two", "two.mp4", "video")],
        format: "mp4",
        durationSeconds: DUR,
      });
      const l = levels(out);
      expect(l.channels).toBe(2);
      expect(l.perChannel[0].left).toBeGreaterThan(MUSIC_AMP * 0.85); // the stereo track…
      expect(l.perChannel[0].vo).toBeLessThan(0.01); // …not the mono one listed first
    });

    it("ffmpeg-overlay exports the base's track the preview plays", async () => {
      twoTrack("base2.mp4");
      testDb.insert(files).values([{
        id: "f-base2", pieceId: PIECE, filename: "base2.mp4", name: "base2.mp4", description: "", type: "video",
        storagePath: `${PIECE}/base2.mp4`, contentType: "video/mp4", size: fs.statSync(path.join(dir, "base2.mp4")).size,
      }]).run();
      const composition = {
        id: "c2", name: "c2", width: 64, height: 64, fps: 10,
        overlays: [{
          id: "o-b2", kind: "video", fileId: "f-base2", videoUrl: "", startTime: 0, duration: DUR, z: 0,
          opacity: 1, fit: "cover", rect: { x: 0, y: 0, width: 64, height: 64 },
          sourceWidth: 64, sourceHeight: 64, trim: { start: 0, end: DUR },
        }],
        audioClips: [
          { id: "b2-audio", kind: "inline", fileId: "f-base2", linkedOverlayId: "o-b2", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true },
        ],
      } as Composition;
      const outPath = path.join(tempDir, "overlay-two.mp4");
      await new FfmpegOverlayBackend().run({
        composition,
        settings: { format: "mp4", codec: "avc", bitrate: 0, width: 64, height: 64, fps: 10 },
        outputPath: outPath,
      });
      const l = levels(outPath);
      expect(l.channels).toBe(2);
      expect(l.perChannel[1].right).toBeGreaterThan(MUSIC_AMP * 0.85);
      expect(l.perChannel[1].vo).toBeLessThan(0.01);
    });
  });
});

