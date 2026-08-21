/**
 * Integration: Layer-1 audio-mix flow via FfmpegOverlayBackend.
 *
 * ## History
 *
 * This file spent its whole life disabled. It was written against the
 * pre-Task-19 `VideoScene.audio` / `Composition.audioTracks` shape; when that
 * shape was removed from the engine types the file was hard-disabled with
 * `const skipIf = describe.skip` behind a `TODO(Task 19)` rather than
 * converted. It could not be un-skipped — it would not type-check — so the
 * export audio-mix path had NO Layer-1 coverage on any machine, hidden as two
 * skipped tests among several legitimately-gated ones.
 *
 * Rewritten against the current model. What it pins:
 *
 *   - The base is a `VideoOverlay` (there is no video scene any more) whose
 *     own audio is dropped, because no inline `AudioClip` is linked to it.
 *   - A standalone `AudioClip` reaches the output through `filter_complex`.
 *   - The clip's source is 5s while the composition is 3s, so atrim must cap
 *     the output rather than stretching it.
 *   - The classifier ROUTES an audio-bearing composition here. Without that,
 *     these tests would only prove the backend works, not that anything calls
 *     it — a `stream-copy` route would silently drop the clip.
 *
 * A control run without the clip proves the measured loudness comes from the
 * clip and not from base audio leaking through `-map 0:a?`.
 *
 * Skipped when ffmpeg is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { probe, audioMeanVolumeDb, hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "helpers", "fixtures", "video");
const VIDEO_FIXTURE = path.join(FIXTURE_DIR, "clip-red-3s.mp4");
const TONE_FIXTURE = path.join(FIXTURE_DIR, "tone-5s.m4a");
const LOGO_FIXTURE = path.join(FIXTURE_DIR, "logo-64.png");

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import { classifyExportShape } from "@/lib/export/classifier";
import type { AudioClip, Composition, Overlay } from "@/lib/engine/types";

const SETTINGS = {
  format: "mp4" as const,
  codec: "avc" as const,
  bitrate: 0,
  width: 320,
  height: 240,
  fps: 24,
};

skipIf("Layer-1: FfmpegOverlayBackend audio-mix flow", () => {
  const PIECE_ID = "p-amix";
  const VIDEO_FILE_ID = "f-video";
  const TONE_FILE_ID = "f-tone";
  const LOGO_FILE_ID = "f-logo";
  const VIDEO_NAME = "src.mp4";
  const TONE_NAME = "tone.m4a";
  const LOGO_NAME = "logo.png";
  const BASE_ID = "o-base";

  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID });
    fs.mkdirSync(path.join(tempDir, PIECE_ID), { recursive: true });

    const seeded: Array<[string, string, string, "video" | "audio" | "image", string]> = [
      [VIDEO_FILE_ID, VIDEO_NAME, VIDEO_FIXTURE, "video", "video/mp4"],
      [TONE_FILE_ID, TONE_NAME, TONE_FIXTURE, "audio", "audio/mp4"],
      [LOGO_FILE_ID, LOGO_NAME, LOGO_FIXTURE, "image", "image/png"],
    ];
    for (const [, name, fixture] of seeded) {
      fs.copyFileSync(fixture, path.join(tempDir, PIECE_ID, name));
    }
    testDb
      .insert(files)
      .values(
        seeded.map(([id, name, , type, contentType]) => ({
          id,
          pieceId: PIECE_ID,
          filename: name,
          name,
          description: "",
          type,
          storagePath: `${PIECE_ID}/${name}`,
          contentType,
          size: fs.statSync(path.join(tempDir, PIECE_ID, name)).size,
        })),
      )
      .run();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  /** The base video overlay — 3s of the red clip, filling the frame. */
  function baseOverlay(): Overlay {
    return {
      id: BASE_ID,
      kind: "video",
      fileId: VIDEO_FILE_ID,
      videoUrl: "",
      startTime: 0,
      duration: 3,
      z: 0,
      opacity: 1,
      fit: "cover",
      rect: { x: 0, y: 0, width: 320, height: 240 },
      sourceWidth: 320,
      sourceHeight: 240,
      trim: { start: 0, end: 3 },
    };
  }

  /**
   * A standalone clip over the 5s tone, occupying the composition's full 3s.
   * `kind: "standalone"` with no `linkedOverlayId` is the "background music"
   * case; because nothing inline is linked to the base, the backend drops the
   * base's own audio and this clip is the only source in the mix.
   */
  function toneClip(): AudioClip {
    return {
      id: "a-tone",
      kind: "standalone",
      fileId: TONE_FILE_ID,
      startTime: 0,
      duration: 3,
      trimStart: 0,
      volume: 1,
      enabled: true,
      label: "tone",
    };
  }

  function makeComposition(opts: {
    withClip: boolean;
    withImageOverlay: boolean;
  }): Composition {
    const overlays: Overlay[] = [baseOverlay()];
    if (opts.withImageOverlay) {
      overlays.push({
        id: "i-amix",
        kind: "image",
        fileId: LOGO_FILE_ID,
        rect: { x: 0, y: 0, width: 64, height: 64 },
        startTime: 0,
        duration: 3,
        z: 1,
        opacity: 1,
      });
    }
    return {
      id: "comp-amix",
      name: "amix",
      width: 320,
      height: 240,
      fps: 24,
      overlays,
      ...(opts.withClip ? { audioClips: [toneClip()] } : {}),
    };
  }

  it("mixes a standalone audioClip into the output when base audio is dropped", async () => {
    const outPath = path.join(tempDir, "amix-out.mp4");
    const controlPath = path.join(tempDir, "amix-control.mp4");
    const backend = new FfmpegOverlayBackend();

    // Control: identical composition, no audioClips. The base's own audio is
    // dropped (nothing inline is linked to it), so this is silent or has no
    // audio stream at all. If `-map 0:a?` ever leaks base audio again, this
    // run becomes as loud as the real one and the differential below fails.
    await backend.run({
      composition: makeComposition({ withClip: false, withImageOverlay: true }),
      settings: SETTINGS,
      outputPath: controlPath,
    });

    const result = await backend.run({
      composition: makeComposition({ withClip: true, withImageOverlay: true }),
      settings: SETTINGS,
      outputPath: outPath,
    });

    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.blob.size).toBeGreaterThan(0);

    const info = await probe(outPath);
    expect(info.videoStream).not.toBeNull();
    expect(info.audioStream).not.toBeNull();
    expect(info.audioStream!.codec).toBe("aac");

    // Tone source is 5s — atrim must cap the output at the 3s visual duration
    // rather than stretching the composition to the length of its music.
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 3.0)).toBeLessThan(0.25);

    // The tone fixture is nominally -20dB; after encoding volumedetect
    // typically reports -25..-30 dBFS. -45 is a loose floor that still rules
    // out silence, which volumedetect reports around -90 or lower.
    const meanDb = await audioMeanVolumeDb(outPath);
    expect(meanDb).not.toBeNull();
    expect(meanDb!).toBeGreaterThan(-45);

    // Differential: the clip is what made it loud, not leaked base audio.
    const controlInfo = await probe(controlPath);
    if (controlInfo.audioStream !== null) {
      const controlDb = await audioMeanVolumeDb(controlPath);
      if (controlDb !== null) expect(meanDb!).toBeGreaterThan(controlDb + 10);
    }
  });

  it("routes an audioClips-only composition through ffmpeg-overlay", async () => {
    // The realistic background-music shape: one base video, NO other overlays,
    // one audio clip. Nothing about the picture needs re-encoding, so the
    // cheap `stream-copy-trim` backend is the tempting route — and it uses
    // `-c copy`, which would drop the clip and ship silent video. The
    // classifier has to see the audio and route here instead.
    const comp = makeComposition({ withClip: true, withImageOverlay: false });

    expect(classifyExportShape(comp).tag).toBe("ffmpeg-overlay");

    const outPath = path.join(tempDir, "amix-noov-out.mp4");
    const result = await new FfmpegOverlayBackend().run({
      composition: comp,
      settings: SETTINGS,
      outputPath: outPath,
    });

    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.blob.size).toBeGreaterThan(0);

    const info = await probe(outPath);
    expect(info.videoStream).not.toBeNull();
    expect(info.audioStream).not.toBeNull();
    expect(info.audioStream!.codec).toBe("aac");
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 3.0)).toBeLessThan(0.25);

    const meanDb = await audioMeanVolumeDb(outPath);
    expect(meanDb).not.toBeNull();
    expect(meanDb!).toBeGreaterThan(-45);
  });
});
