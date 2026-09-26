/**
 * Integration (real ffmpeg): every server export backend takes the SAME video
 * and audio stream the preview plays (Review M6, Re-review R1).
 *
 * The preview decodes libi's primary tracks (`lib/engine/primary-track.ts`):
 * the first track flagged default, else the first track. ffmpeg's own
 * choices differ, and so, since 1.42, does mediabunny's own pick (it ranks by
 * a bitrate ffprobe can't see).
 * - `[0:v]` is the first video stream.
 * - `-map 0:a?` takes EVERY audio stream.
 * - With no -map at all, ffmpeg picks the "best" stream (most channels).
 * So a multi-track source (an OBS recording, say) could export a picture or a
 * sound the editor never showed.
 *
 * Fixture, made here: v:0 red (not default), v:1 blue (default),
 * a:0 mono 440 Hz (default), a:1 stereo 880 Hz (default). The preview plays
 * BLUE and the MONO 440 Hz track; the test asserts that first. canvas-source
 * runs in the browser on the same helper, so it is consistent by
 * construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS } from "mediabunny";
import { primaryAudioTrack, primaryVideoTrack } from "@/lib/engine/primary-track";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { hasFfmpeg, FFMPEG_SKIP_REASON, extractFrameRgba, sampleRegionMean } from "@/__tests__/helpers/media";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import type { AudioClip, Composition, Overlay } from "@/lib/engine/types";
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

const RATE = 48000;
const DUR = 2;
const PIECE = "p-primary";
const SETTINGS = { format: "mp4" as const, codec: "avc" as const, bitrate: 0, width: 64, height: 64, fps: 10 };

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}

function audioStreams(file: string): string[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=channels", "-of", "csv=p=0", file]).toString().trim();
  return out ? out.split("\n") : [];
}

function videoStreamCount(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", file]).toString().trim();
  return out ? out.split("\n").length : 0;
}

/** Amplitude of `freq` in the first audio stream (mono mixdown), 0.5–1.5 s. */
function toneAmp(file: string, freq: number): number {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]);
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = RATE / 2;
  const from = RATE / 2;
  const w = (2 * Math.PI * freq) / RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0))) / n;
}

async function meanColor(file: string, rect = { x: 16, y: 16, w: 32, h: 32 }) {
  return sampleRegionMean(await extractFrameRgba(file, 0.5), rect);
}

skipIf("export backends take the preview's primary streams (real ffmpeg)", () => {
  let dir: string;

  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    ff(["-f", "lavfi", "-i", `color=c=red:s=64x64:r=10:d=${DUR}`,
      "-f", "lavfi", "-i", `color=c=blue:s=64x64:r=10:d=${DUR}`,
      "-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*440*t):s=${RATE}:d=${DUR}:c=mono`,
      "-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*880*t)|0.3*sin(2*PI*880*t):s=${RATE}:d=${DUR}:c=stereo`,
      "-map", "0:v", "-map", "1:v", "-map", "2:a", "-map", "3:a",
      "-disposition:v:0", "0", "-disposition:v:1", "default", "-disposition:a:0", "default", "-disposition:a:1", "default",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "multi.mp4")]);
    ff(["-f", "lavfi", "-i", `color=c=green:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "plain.mp4")]);
    ff(["-f", "lavfi", "-i", "color=c=white:s=8x8", "-frames:v", "1", path.join(dir, "dot.png")]);
    const rows: Array<[string, string, "video" | "image"]> = [["f-multi", "multi.mp4", "video"], ["f-plain", "plain.mp4", "video"], ["f-dot", "dot.png", "image"]];
    testDb.insert(files).values(rows.map(([id, name, type]) => ({
      id, pieceId: PIECE, filename: name, name, description: "", type,
      storagePath: `${PIECE}/${name}`, contentType: type === "video" ? "video/mp4" : "image/png",
      size: fs.statSync(path.join(dir, name)).size,
    }))).run();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  const baseOverlay = (fileId: string): Overlay => ({
    id: "o-base", kind: "video", fileId, videoUrl: "", startTime: 0, duration: DUR, z: 0, opacity: 1, fit: "cover",
    rect: { x: 0, y: 0, width: 64, height: 64 }, sourceWidth: 64, sourceHeight: 64, trim: { start: 0, end: DUR },
  } as Overlay);
  const baseAudio = (fileId: string): AudioClip => ({
    id: "base-audio", kind: "inline", fileId, linkedOverlayId: "o-base", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true,
  });

  function expectPreviewStreams(out: string) {
    expect(videoStreamCount(out)).toBe(1);
    expect(audioStreams(out)).toEqual(["1"]); // only the mono track
    expect(toneAmp(out, 440)).toBeGreaterThan(0.2);
    expect(toneAmp(out, 880)).toBeLessThan(0.02);
  }

  it("fixture: the preview plays the blue video and the mono 440 Hz track", async () => {
    const input = new Input({ source: new FilePathSource(path.join(dir, "multi.mp4")), formats: ALL_FORMATS });
    const audio = await primaryAudioTrack(input);
    const video = await primaryVideoTrack(input);
    expect(await audio!.getNumberOfChannels()).toBe(1);
    // mediabunny's id is the MP4 track_ID, which ffmpeg numbers in stream
    // order from 1: the blue (default) video is track 2, the mono audio track 3.
    expect(video!.id).toBe(2);
    expect(audio!.id).toBe(3);
    input.dispose();
  });

  it("stream-copy-trim", async () => {
    const out = path.join(tempDir, "sct.mp4");
    await new StreamCopyTrimBackend().run({
      composition: { id: "c", name: "c", width: 64, height: 64, fps: 10, overlays: [baseOverlay("f-multi")], audioClips: [baseAudio("f-multi")] } as Composition,
      settings: SETTINGS,
      outputPath: out,
    });
    expectPreviewStreams(out);
    const [r, g, b] = await meanColor(out);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
    expect(g).toBeLessThan(80);
  });

  it("ffmpeg-overlay, the base video and its audio", async () => {
    const out = path.join(tempDir, "ovl-base.mp4");
    await new FfmpegOverlayBackend().run({
      composition: {
        id: "c", name: "c", width: 64, height: 64, fps: 10,
        overlays: [baseOverlay("f-multi"), { id: "o-dot", kind: "image", fileId: "f-dot", rect: { x: 0, y: 0, width: 8, height: 8 }, startTime: 0, duration: DUR, z: 1, opacity: 1 } as Overlay],
        audioClips: [baseAudio("f-multi")],
      } as Composition,
      settings: SETTINGS,
      outputPath: out,
    });
    expectPreviewStreams(out);
    const [r, , b] = await meanColor(out);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
  });

  it("ffmpeg-overlay, a multi-track file used as a video OVERLAY", async () => {
    const out = path.join(tempDir, "ovl-asset.mp4");
    await new FfmpegOverlayBackend().run({
      composition: {
        id: "c", name: "c", width: 64, height: 64, fps: 10,
        overlays: [
          baseOverlay("f-plain"),
          { id: "o-multi", kind: "video", fileId: "f-multi", videoUrl: "", startTime: 0, duration: DUR, z: 1, opacity: 1, fit: "cover",
            rect: { x: 16, y: 16, width: 32, height: 32 }, sourceWidth: 64, sourceHeight: 64, trim: { start: 0, end: DUR } } as Overlay,
        ],
        audioClips: [],
      } as Composition,
      settings: SETTINGS,
      outputPath: out,
    });
    const [r, , b] = await meanColor(out, { x: 24, y: 24, w: 16, h: 16 });
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
  });

  it("chromium-render audio mux", async () => {
    const videoOnly = path.join(dir, "render.mp4");
    ff(["-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", videoOnly]);
    const out = await muxAudioIntoRender({
      videoPath: videoOnly,
      audioClips: [{ ...baseAudio("f-multi"), kind: "standalone", linkedOverlayId: undefined }],
      files: [{ id: "f-multi", pieceId: PIECE, filename: "multi.mp4", name: "multi.mp4", type: "video" } as FileRecord],
      format: "mp4",
      durationSeconds: DUR,
    });
    expect(audioStreams(out)).toEqual(["1"]);
    expect(toneAmp(out, 440)).toBeGreaterThan(0.2);
    expect(toneAmp(out, 880)).toBeLessThan(0.02);
  });
});
