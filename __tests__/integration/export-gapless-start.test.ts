/**
 * Integration (real ffmpeg): the export of a clip of a gapless file plays the
 * source from the trim point measured from the file's start as ffmpeg defines
 * it, which is what the preview now reads (lib/engine/source-time-origin.ts).
 *
 * A gapless MP3 (LAME header: 1105 samples of encoder delay) starts at
 * 0.025 s on ffmpeg's timeline, and an Apple AAC file (iTunSMPB: 2112 samples)
 * at 2112 / rate. The ffmpeg CLI rebases every input by that start, so the
 * mix's `atrim` already counts from the first decoded sample, like ffmpeg's
 * plain decode. mediabunny doesn't skip the delay, so the preview used to play
 * these files 25 ms / 47.9 ms late against this export; the preview now reads
 * the start from the server. This pins the export side of that agreement.
 *
 * Measured by cross-correlating the export against ffmpeg's plain decode of
 * the source at the trim point: the lag must be under a sample at 48 kHz.
 * The Apple fixture is committed (afconvert only exists on macOS; see
 * he-aac.SOURCE.md). docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";
import { LocalFileStorage } from "@/lib/storage/local";
import type { AudioClip } from "@/lib/engine/types";
import type { FileRecord } from "@/lib/db/schema/types";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { muxAudioIntoRender } from "@/lib/export/render-audio-mux";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { resolveFfmpegPath } from "@/lib/ffmpeg/exec";

const RATE = 48000;
const PIECE = "p-gapless";
const APPLE_FIXTURE = path.join(__dirname, "../fixtures/audio/aac-lc-itunsmpb.m4a");

// The export runs libi's ffmpeg (the bundled one when installed), so the
// fixture and the reference decode use the same binary: ffmpeg 8 and 9 read
// some gapless tags differently (review round 2, M2).
const FFMPEG = resolveFfmpegPath();

function ff(args: string[]): void {
  execFileSync(FFMPEG, ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}
function decode(file: string): Float32Array {
  const raw = execFileSync(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 64 << 20 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
/** Lag (ms) of `out` against `src` shifted by `srcOffset` s, searched within ±60 ms. */
function lagMs(out: Float32Array, src: Float32Array, srcOffset: number): number {
  const from = Math.round(0.2 * RATE), n = Math.round(1.0 * RATE), off = Math.round(srcOffset * RATE);
  let best = { c: -Infinity, lag: 0 };
  for (let lag = -Math.round(0.06 * RATE); lag <= Math.round(0.06 * RATE); lag++) {
    let s = 0, sx = 0, sy = 0;
    for (let i = from; i < from + n; i += 3) {
      const u = out[i], v = src[i + off + lag] ?? 0;
      s += u * v; sx += u * u; sy += v * v;
    }
    const c = s / Math.sqrt(sx * sy);
    if (c > best.c) best = { c, lag };
  }
  return (best.lag / RATE) * 1000;
}

skipIf("export trims a gapless file from its start (real ffmpeg)", () => {
  let dir: string;
  let render: string;
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    dir = path.join(tempDir, PIECE);
    fs.mkdirSync(dir, { recursive: true });
    // A chirp: no two stretches alike, so the correlation has one peak.
    ff(["-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*(200+300*t)*t)+0.2*sin(2*PI*(1500-250*t)*t):s=44100:d=3:c=mono",
      "-c:a", "libmp3lame", "-b:a", "192k", path.join(dir, "lame.mp3")]);
    fs.copyFileSync(APPLE_FIXTURE, path.join(dir, "apple.m4a"));
    render = path.join(dir, "render.mp4");
    ff(["-f", "lavfi", "-i", "color=c=black:s=64x64:r=10:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", render]);
  });
  afterEach(() => cleanupTempDir(tempDir));

  const rec = (id: string, filename: string) =>
    ({ id, pieceId: PIECE, filename, name: filename, type: "audio" }) as FileRecord;
  const clip = (fileId: string, trimStart: number): AudioClip =>
    ({ id: `c-${fileId}`, kind: "standalone", fileId, startTime: 0, duration: 1.5, trimStart, volume: 1, enabled: true });

  it.each([
    ["LAME MP3", "lame.mp3", 1105 / 44100],
    ["Apple AAC (iTunSMPB)", "apple.m4a", 2112 / 32000],
  ])("%s: the file really starts late on ffmpeg's timeline", async (_l, name, start) => {
    expect((await probeMedia(path.join(dir, name))).startTime).toBeCloseTo(start, 4);
  });

  it.each([
    ["LAME MP3, trimmed to 1.0 s", "lame.mp3", 1.0],
    ["LAME MP3, untrimmed", "lame.mp3", 0],
    ["Apple AAC (iTunSMPB), trimmed to 1.0 s", "apple.m4a", 1.0],
    ["Apple AAC (iTunSMPB), untrimmed", "apple.m4a", 0],
  ])("%s: the export plays the source from the trim point, to the sample", async (_l, name, trim) => {
    const out = await muxAudioIntoRender({
      videoPath: render, audioClips: [clip("f", trim)], files: [rec("f", name)], format: "mp4", durationSeconds: 2,
    });
    const lag = lagMs(decode(out), decode(path.join(dir, name)), trim);
    expect(Math.abs(lag)).toBeLessThan(1000 / RATE + 1e-9);
  });
});
