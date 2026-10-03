/**
 * Integration (real ffmpeg): the audio of the BASE video (its inline clip) takes
 * gain, a volume envelope and a crossfade like any other clip, on both audio
 * export paths: the ffmpeg-overlay backend (where the base's `[0:a]` is the
 * usual source, and an envelope forces the clip-input route, since a shape track
 * is multiplied into a clip's chain) and the chromium-render mux.
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
import { classifyExportShape } from "@/lib/export/classifier";
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
const DUR = 6;
const PIECE = "p-base-gain";
const SETTINGS = { format: "mp4" as const, codec: "avc" as const, bitrate: 0, width: 64, height: 64, fps: 10 };
const SRC_AMP = 0.2;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}
/** Amplitude of the 440 Hz tone in [from, to) of the file's first audio stream. */
function toneAmp(file: string, from: number, to: number): number {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-af", "pan=mono|c0=c0", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const a = Math.round(from * RATE), n = Math.round((to - from) * RATE), w = (2 * Math.PI * 440) / RATE, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s = x[a + i] + coeff * s1 - s2; s2 = s1; s1 = s; }
  return (2 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0))) / n;
}
const db = (amp: number) => 20 * Math.log10(amp / SRC_AMP);

skipIf("the base video's own audio with gain and an envelope (real ffmpeg)", () => {
  let dir: string;
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    ff(["-f", "lavfi", "-i", `color=c=blue:s=64x64:r=10:d=${DUR}`, "-f", "lavfi", "-i", `aevalsrc=${SRC_AMP}*sin(2*PI*440*t):s=${RATE}:d=${DUR}:c=mono`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", path.join(dir, "talk.mp4")]);
    testDb.insert(files).values([{
      id: "f-talk", pieceId: PIECE, filename: "talk.mp4", name: "talk.mp4", description: "", type: "video", storagePath: `${PIECE}/talk.mp4`,
      contentType: "video/mp4", size: fs.statSync(path.join(dir, "talk.mp4")).size, hasAudio: true,
    } as never]).run();
  });
  afterEach(() => cleanupTempDir(tempDir));

  const base: Overlay = {
    id: "o-base", kind: "video", fileId: "f-talk", videoUrl: "", startTime: 0, duration: DUR, z: 0, opacity: 1, fit: "cover",
    rect: { x: 0, y: 0, width: 64, height: 64 }, sourceWidth: 64, sourceHeight: 64, trim: { start: 0, end: DUR },
  } as Overlay;
  const inline = (extra: Partial<AudioClip> = {}): AudioClip => ({
    id: "a-inline", kind: "inline", fileId: "f-talk", linkedOverlayId: "o-base", startTime: 0, duration: DUR, trimStart: 0, volume: 1, enabled: true, ...extra,
  });
  const comp = (clip: AudioClip): Composition =>
    ({ id: "c", name: "c", width: 64, height: 64, fps: 10, overlays: [base], audioClips: [clip] }) as Composition;

  it("a gain on the base's clip is no longer plain passthrough: the classifier does not stream-copy it", () => {
    expect(classifyExportShape(comp(inline())).tag).toBe("stream-copy-trim");
    expect(classifyExportShape(comp(inline({ gainDb: 6 }))).tag).not.toBe("stream-copy-trim");
    expect(classifyExportShape(comp(inline({ volumeKeyframes: { keyframes: [{ t: 1, value: -6 }] } }))).tag).not.toBe("stream-copy-trim");
  });

  it("ffmpeg-overlay: gainDb +6.02 doubles the base audio", async () => {
    const out = path.join(tempDir, "g.mp4");
    await new FfmpegOverlayBackend().run({ composition: comp(inline({ gainDb: 6.0206 })), settings: SETTINGS, outputPath: out });
    expect(db(toneAmp(out, 1, 5))).toBeCloseTo(6.02, 0);
  });

  it("ffmpeg-overlay: an envelope on the base audio dips it 12 dB between 2 and 4 s and brings it back", async () => {
    const out = path.join(tempDir, "e.mp4");
    const clip = inline({
      gainDb: 3,
      volumeKeyframes: { keyframes: [{ t: 1, value: 0, easing: "linear" }, { t: 2, value: -12 }, { t: 4, value: -12, easing: "linear" }, { t: 5, value: 0 }] },
    });
    await new FfmpegOverlayBackend().run({ composition: comp(clip), settings: SETTINGS, outputPath: out });
    expect(db(toneAmp(out, 0.3, 0.9))).toBeCloseTo(3, 0);
    expect(db(toneAmp(out, 2.3, 3.7))).toBeCloseTo(3 - 12, 0);
    expect(db(toneAmp(out, 5.2, 5.9))).toBeCloseTo(3, 0);
  });

  it("chromium-render mux: the same envelope on the same clip, from the manifest", async () => {
    const render = path.join(dir, "render.mp4");
    ff(["-f", "lavfi", "-i", `color=c=black:s=64x64:r=10:d=${DUR}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", render]);
    const recs = [{ id: "f-talk", pieceId: PIECE, filename: "talk.mp4", name: "talk.mp4", type: "video" }] as FileRecord[];
    const clip = inline({ volumeKeyframes: { keyframes: [{ t: 1, value: 0, easing: "linear" }, { t: 2, value: -12 }, { t: 4, value: -12 }] } });
    const out = await muxAudioIntoRender({ videoPath: render, audioClips: [clip], files: recs, format: "mp4", durationSeconds: DUR });
    expect(db(toneAmp(out, 0.3, 0.9))).toBeCloseTo(0, 0);
    expect(db(toneAmp(out, 2.3, 3.7))).toBeCloseTo(-12, 0);
    expect(db(toneAmp(out, 4.5, 5.8))).toBeCloseTo(-12, 0);
  });
});
