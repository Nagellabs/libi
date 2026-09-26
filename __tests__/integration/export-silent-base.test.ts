/**
 * Integration (real ffmpeg): an audio clip linked to a video that has NO
 * audio stream exports cleanly (final review note, pre-existing). Clip
 * creation is gated on `has_audio`, but a relink can still attach an inline
 * clip to a silent video. The export used to reference `[0:a]` / `[n:a]` for
 * it and fail with "matches no streams". Now a clip whose file has no audio
 * is left out of the mix, and the rest of the piece exports as normal.
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
import type { AudioClip, Composition, Overlay } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import { muxAudioIntoRender } from "@/lib/export/render-audio-mux";

const RATE = 48000;
const DUR = 2;
const PIECE = "p-silent";
const SETTINGS = { format: "mp4" as const, codec: "avc" as const, bitrate: 0, width: 64, height: 64, fps: 10 };

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}
function audioStreamCount(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]).toString().trim();
  return out ? out.split("\n").length : 0;
}
function toneAmp(file: string, freq: number): number {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]);
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = RATE / 2, from = RATE / 2, w = (2 * Math.PI * freq) / RATE, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s = x[from + i] + coeff * s1 - s2; s2 = s1; s1 = s; }
  return (2 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0))) / n;
}

skipIf("a clip linked to a video with no audio stream (real ffmpeg)", () => {
  let dir: string;
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    ff(["-f", "lavfi", "-i", `color=c=blue:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "silent.mp4")]);
    ff(["-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*440*t):s=${RATE}:d=${DUR}:c=mono`, "-c:a", "pcm_s16le", path.join(dir, "tone.wav")]);
    ff(["-f", "lavfi", "-i", "color=c=white:s=8x8", "-frames:v", "1", path.join(dir, "dot.png")]);
    const rows: Array<[string, string, "video" | "audio" | "image", string]> = [
      ["f-silent", "silent.mp4", "video", "video/mp4"], ["f-tone", "tone.wav", "audio", "audio/wav"], ["f-dot", "dot.png", "image", "image/png"],
    ];
    testDb.insert(files).values(rows.map(([id, name, type, contentType]) => ({
      id, pieceId: PIECE, filename: name, name, description: "", type, storagePath: `${PIECE}/${name}`, contentType,
      size: fs.statSync(path.join(dir, name)).size,
    }))).run();
  });
  afterEach(() => cleanupTempDir(tempDir));

  const base: Overlay = {
    id: "o-base", kind: "video", fileId: "f-silent", videoUrl: "", startTime: 0, duration: DUR, z: 0, opacity: 1, fit: "cover",
    rect: { x: 0, y: 0, width: 64, height: 64 }, sourceWidth: 64, sourceHeight: 64, trim: { start: 0, end: DUR },
  } as Overlay;
  const dot = { id: "o-dot", kind: "image", fileId: "f-dot", rect: { x: 0, y: 0, width: 8, height: 8 }, startTime: 0, duration: DUR, z: 1, opacity: 1 } as Overlay;
  const inline: AudioClip = { id: "a-inline", kind: "inline", fileId: "f-silent", linkedOverlayId: "o-base", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true };
  const tone: AudioClip = { id: "a-tone", kind: "standalone", fileId: "f-tone", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true };

  it("ffmpeg-overlay: only the silent base's clip → exports the picture, no audio stream, no error", async () => {
    const out = path.join(tempDir, "o1.mp4");
    await new FfmpegOverlayBackend().run({
      composition: { id: "c", name: "c", width: 64, height: 64, fps: 10, overlays: [base, dot], audioClips: [inline] } as Composition,
      settings: SETTINGS,
      outputPath: out,
    });
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    expect(audioStreamCount(out)).toBe(0);
  });

  it("ffmpeg-overlay: the silent base's clip + a music clip → the music is exported", async () => {
    const out = path.join(tempDir, "o2.mp4");
    await new FfmpegOverlayBackend().run({
      composition: { id: "c", name: "c", width: 64, height: 64, fps: 10, overlays: [base, dot], audioClips: [inline, tone] } as Composition,
      settings: SETTINGS,
      outputPath: out,
    });
    expect(audioStreamCount(out)).toBe(1);
    expect(toneAmp(out, 440)).toBeGreaterThan(0.2);
  });

  it("chromium-render mux: a clip on a silent video + a music clip → the music is muxed; the silent clip alone → the render unchanged", async () => {
    const render = path.join(dir, "render.mp4");
    ff(["-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", render]);
    const recs = [
      { id: "f-silent", pieceId: PIECE, filename: "silent.mp4", name: "silent.mp4", type: "video" },
      { id: "f-tone", pieceId: PIECE, filename: "tone.wav", name: "tone.wav", type: "audio" },
    ] as FileRecord[];
    const mixed = await muxAudioIntoRender({ videoPath: render, audioClips: [inline, tone], files: recs, format: "mp4", durationSeconds: DUR });
    expect(audioStreamCount(mixed)).toBe(1);
    expect(toneAmp(mixed, 440)).toBeGreaterThan(0.2);
    const alone = await muxAudioIntoRender({ videoPath: render, audioClips: [inline], files: recs, format: "mp4", durationSeconds: DUR });
    expect(alone).toBe(render);
  });
});
