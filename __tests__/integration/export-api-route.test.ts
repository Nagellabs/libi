/**
 * Integration: Layer-2 — `/api/export/ffmpeg` route coverage.
 *
 * Imports the POST handler directly and drives it with a constructed
 * `Request`. Tests seed the composition via the persistence helpers
 * (`addOverlayToManifest`, `addAudioClip`)
 * against an in-memory test DB + a temp storage dir, so the route's
 * internal `loadComposition(pieceId)` call reads the same files back.
 *
 * Scenarios:
 *  1. Happy path — `ffmpeg-overlay` shape: video scene + image overlay.
 *  2. Happy path — `stream-copy-trim` shape: trim-only video scene.
 *  3. Classifier mismatch: client lies about shape → 409.
 *  4. audioClips forwarded: video scene + image overlay + standalone audioClip →
 *     output has mixed audio (proves route hydrator copies
 *     `manifest.audioClips` into the runtime composition).
 *
 * Skipped if ffmpeg is not on PATH.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { probe, audioMeanVolumeDb, hasFfmpeg, FFMPEG_SKIP_REASON, listTmpExportDirs, extractFrameRgba, sampleRegionMean } from "@/__tests__/helpers/media";

const FIXTURE_DIR = path.resolve(__dirname, "..", "helpers", "fixtures", "video");
const VIDEO_FIXTURE = path.join(FIXTURE_DIR, "clip-red-3s.mp4");
const LOGO_FIXTURE = path.join(FIXTURE_DIR, "logo-64.png");
const TONE_FIXTURE = path.join(FIXTURE_DIR, "tone-5s.m4a");

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { POST } from "@/app/api/export/ffmpeg/route";
import {
  addOverlayToManifest,
  addAudioClip,
  loadManifest,
  saveManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";

const PIECE_ID = "p-route";
const VIDEO_FILE_ID = "f-video";
const LOGO_FILE_ID = "f-logo";
const TONE_FILE_ID = "f-tone";
const VIDEO_NAME = "src.mp4";
const LOGO_NAME = "logo.png";
const TONE_NAME = "tone.m4a";

skipIf("Layer-2: /api/export/ffmpeg route", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID });
    fs.mkdirSync(path.join(tempDir, PIECE_ID), { recursive: true });
    fs.copyFileSync(VIDEO_FIXTURE, path.join(tempDir, PIECE_ID, VIDEO_NAME));
    fs.copyFileSync(LOGO_FIXTURE, path.join(tempDir, PIECE_ID, LOGO_NAME));
    fs.copyFileSync(TONE_FIXTURE, path.join(tempDir, PIECE_ID, TONE_NAME));
    const videoStat = fs.statSync(path.join(tempDir, PIECE_ID, VIDEO_NAME));
    const logoStat = fs.statSync(path.join(tempDir, PIECE_ID, LOGO_NAME));
    const toneStat = fs.statSync(path.join(tempDir, PIECE_ID, TONE_NAME));
    testDb
      .insert(files)
      .values([
        {
          id: VIDEO_FILE_ID,
          pieceId: PIECE_ID,
          filename: VIDEO_NAME,
          name: VIDEO_NAME,
          description: "",
          type: "video",
          storagePath: `${PIECE_ID}/${VIDEO_NAME}`,
          contentType: "video/mp4",
          size: videoStat.size,
          // Source dims match the comp so `-c copy` preserves framing — what
          // lets the trim-only cases classify as stream-copy-trim.
          mediaWidth: 320,
          mediaHeight: 240,
        },
        {
          id: LOGO_FILE_ID,
          pieceId: PIECE_ID,
          filename: LOGO_NAME,
          name: LOGO_NAME,
          description: "",
          type: "image",
          storagePath: `${PIECE_ID}/${LOGO_NAME}`,
          contentType: "image/png",
          size: logoStat.size,
        },
        {
          id: TONE_FILE_ID,
          pieceId: PIECE_ID,
          filename: TONE_NAME,
          name: TONE_NAME,
          description: "",
          type: "audio",
          storagePath: `${PIECE_ID}/${TONE_NAME}`,
          contentType: "audio/mp4",
          size: toneStat.size,
        },
      ])
      .run();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  async function seedManifestDims(): Promise<void> {
    // Override the default 1920x1080 manifest dims so the loaded comp's
    // width/height match what the test POSTs (320x240).
    const m = await loadManifest(PIECE_ID);
    m.width = 320;
    m.height = 240;
    m.fps = 24;
    await saveManifest(PIECE_ID, m);
  }

  /** Seed the piece's BASE video: a full-frame, cover-fit video overlay at z=0
   *  (the shape `resolveExportBase` accepts as ffmpeg's `[0:v]` input). */
  async function seedBaseVideo(opts: {
    trim?: { start: number; end: number };
    keepOriginalAudio?: boolean;
    duration?: number;
  }): Promise<void> {
    await seedManifestDims();
    const duration = opts.duration ?? (opts.trim ? opts.trim.end - opts.trim.start : 3);
    await addOverlayToManifest(PIECE_ID, {
      id: "base-1",
      kind: "video",
      fileId: VIDEO_FILE_ID,
      startTime: 0,
      duration,
      z: 0,
      opacity: 1,
      fit: "cover",
      rect: { x: 0, y: 0, width: 320, height: 240 },
      trim: opts.trim,
    });
    // Add an inline AudioClip for the base's own audio if requested.
    if (opts.keepOriginalAudio !== false) {
      await addAudioClip(PIECE_ID, {
        id: "clip-inline-base-1",
        kind: "inline",
        fileId: VIDEO_FILE_ID,
        startTime: 0,
        duration,
        trimStart: opts.trim?.start ?? 0,
        volume: 1,
        enabled: true,
        linkedOverlayId: "base-1",
      });
    }
  }

  function makeRequest(body: unknown): Request {
    return new Request("http://test/api/export/ffmpeg", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("ffmpeg-overlay happy path: base video + image overlay", async () => {
    await seedBaseVideo({ trim: { start: 0, end: 2 } });
    const overlay: PersistedOverlay = {
      id: "o-img",
      kind: "image",
      fileId: LOGO_FILE_ID,
      rect: { x: 10, y: 10, width: 64, height: 64 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, overlay);

    const req = makeRequest({
      pieceId: PIECE_ID,
      shape: "ffmpeg-overlay",
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
    });
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("X-Export-Backend")).toBe("ffmpeg-overlay");
    const dur = parseFloat(response.headers.get("X-Export-Duration-Seconds")!);
    expect(dur).toBeGreaterThan(0);

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);

    const outPath = path.join(tempDir, "overlay-out.mp4");
    fs.writeFileSync(outPath, bytes);
    const info = await probe(outPath);
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 2.0)).toBeLessThan(0.3);
    expect(info.videoStream).not.toBeNull();
    expect(info.videoStream!.codec).toBe("h264");

    // Tmp-dir cleanup is fire-and-forget — give the promise a moment.
    await new Promise((r) => setTimeout(r, 100));
    const leftover = await listTmpExportDirs();
    if (leftover.length > 0) {
      // Cleanup race with the fire-and-forget fs.rm. Don't fail the test.
      // TODO: tighten the route to await cleanup (see docs-local/follow-ups.md).
      console.warn(`export tmp dirs not cleaned: ${leftover.join(", ")}`);
    }
  });

  it("stream-copy-trim happy path: trim-only video scene", async () => {
    await seedBaseVideo({ trim: { start: 0, end: 1 }, duration: 1 });
    // NO overlays — classifier should return stream-copy-trim.

    const req = makeRequest({
      pieceId: PIECE_ID,
      shape: "stream-copy-trim",
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
    });
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("X-Export-Backend")).toBe("stream-copy-trim");

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);

    const outPath = path.join(tempDir, "trim-out.mp4");
    fs.writeFileSync(outPath, bytes);
    const info = await probe(outPath);
    expect(info.duration).not.toBeNull();
    expect(Math.abs(info.duration! - 1.0)).toBeLessThan(0.2);
    expect(info.videoStream).not.toBeNull();
  });

  it("classifier mismatch: client says stream-copy-trim but comp has overlay → 409", async () => {
    await seedBaseVideo({ trim: { start: 0, end: 2 } });
    // Add an overlay so the server-side classifier returns ffmpeg-overlay.
    const overlay: PersistedOverlay = {
      id: "o-img-2",
      kind: "image",
      fileId: LOGO_FILE_ID,
      rect: { x: 10, y: 10, width: 64, height: 64 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, overlay);

    const req = makeRequest({
      pieceId: PIECE_ID,
      shape: "stream-copy-trim", // the lie
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
    });
    const response = await POST(req);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("changed");
  });

  it("forwards manifest.audioClips into the runtime composition", async () => {
    // Base video scene with NO inline audio clip (keepOriginalAudio: false)
    // + image overlay + a standalone tone audioClip.
    // The image overlay forces ffmpeg-overlay shape; the standalone clip
    // must mix through so the output has audible audio.
    // Pre-fix the route hydrator dropped manifest.audioClips entirely, so
    // the output would be silent; post-fix the tone mixes through.
    await seedBaseVideo({
      trim: { start: 0, end: 2 },
      keepOriginalAudio: false,
    });

    const overlay: PersistedOverlay = {
      id: "o-img-3",
      kind: "image",
      fileId: LOGO_FILE_ID,
      rect: { x: 10, y: 10, width: 64, height: 64 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, overlay);

    await addAudioClip(PIECE_ID, {
      id: "at-tone",
      kind: "standalone",
      fileId: TONE_FILE_ID,
      startTime: 0,
      duration: 2,
      trimStart: 0,
      volume: 1,
      enabled: true,
    });

    const req = makeRequest({
      pieceId: PIECE_ID,
      shape: "ffmpeg-overlay",
      settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
    });
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Export-Backend")).toBe("ffmpeg-overlay");

    const bytes = Buffer.from(await response.arrayBuffer());
    const outPath = path.join(tempDir, "atrack-out.mp4");
    fs.writeFileSync(outPath, bytes);

    const info = await probe(outPath);
    expect(info.audioStream).not.toBeNull();
    expect(info.audioStream!.codec).toBe("aac");

    // The mixed tone should be clearly audible. Same floor Task 4 used —
    // -45 dB is well above silence (~-90dB) but loose enough for encoder
    // variance.
    const meanDb = await audioMeanVolumeDb(outPath);
    expect(meanDb).not.toBeNull();
    expect(meanDb!).toBeGreaterThan(-45);
  });

  // ── I3: muting a base video REMOVES its inline audio clip. With no clip
  // there is nothing for the classifier's audio check to see, so the comp
  // stream-copies — and `-c copy` carried the SOURCE's audio track straight
  // through. The user muted it; the file had sound.
  it("I3: a MUTED base (no inline clip) stream-copies WITHOUT audio", async () => {
    await seedBaseVideo({ trim: { start: 0, end: 1 }, duration: 1, keepOriginalAudio: false });

    const response = await POST(
      makeRequest({
        pieceId: PIECE_ID,
        shape: "stream-copy-trim",
        settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Export-Backend")).toBe("stream-copy-trim");

    const outPath = path.join(tempDir, "muted-out.mp4");
    fs.writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
    const info = await probe(outPath);
    expect(info.videoStream).not.toBeNull();
    expect(info.audioStream).toBeNull();
  });

  it("I3: an UNMUTED base keeps its audio on the stream-copy path", async () => {
    await seedBaseVideo({ trim: { start: 0, end: 1 }, duration: 1 });

    const response = await POST(
      makeRequest({
        pieceId: PIECE_ID,
        shape: "stream-copy-trim",
        settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      }),
    );
    expect(response.status).toBe(200);

    const outPath = path.join(tempDir, "unmuted-out.mp4");
    fs.writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
    const info = await probe(outPath);
    expect(info.audioStream).not.toBeNull();
  });

  // ── C1: a base-shaped video OVERLAY whose source aspect differs from the
  // composition. `add_overlay` gives every new video a full-canvas `cover`
  // rect regardless of aspect, so this is the routine shape. Stream-copy
  // cannot scale (it shipped the LANDSCAPE source for a PORTRAIT piece) and
  // the ffmpeg base chain letterboxed instead of cropping.
  describe("C1: overlay base with mismatched source dims", () => {
    /** 240x320 portrait comp fed by the 320x240 landscape fixture. */
    async function seedPortraitOverlayBase(): Promise<void> {
      const m = await loadManifest(PIECE_ID);
      m.width = 240;
      m.height = 320;
      m.fps = 24;
      await saveManifest(PIECE_ID, m);
      testDb
        .update(files)
        .set({ mediaWidth: 320, mediaHeight: 240, mediaDuration: 3 })
        .where(eq(files.id, VIDEO_FILE_ID))
        .run();
      const overlay: PersistedOverlay = {
        id: "o-base-video",
        kind: "video",
        fileId: VIDEO_FILE_ID,
        rect: { x: 0, y: 0, width: 240, height: 320 },
        fit: "cover",
        startTime: 0,
        duration: 1,
        trim: { start: 0, end: 1 },
        z: 0,
        opacity: 1,
      } as unknown as PersistedOverlay;
      await addOverlayToManifest(PIECE_ID, overlay);
    }

    it("refuses the stream-copy shape (it would ship the source's dimensions)", async () => {
      await seedPortraitOverlayBase();
      const response = await POST(
        makeRequest({
          pieceId: PIECE_ID,
          shape: "stream-copy-trim",
          settings: { format: "mp4", codec: "avc", bitrate: 0, width: 240, height: 320, fps: 24 },
        }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("ffmpeg-overlay");
    });

    it("exports at the COMPOSITION's dimensions, cover-cropped (no letterbox)", async () => {
      await seedPortraitOverlayBase();
      const response = await POST(
        makeRequest({
          pieceId: PIECE_ID,
          shape: "ffmpeg-overlay",
          settings: { format: "mp4", codec: "avc", bitrate: 0, width: 240, height: 320, fps: 24 },
        }),
      );
      expect(response.status).toBe(200);

      const outPath = path.join(tempDir, "cover-out.mp4");
      fs.writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
      const info = await probe(outPath);
      // Pre-fix this was 320x240 — a landscape file for a portrait piece.
      expect(info.videoStream!.width).toBe(240);
      expect(info.videoStream!.height).toBe(320);

      // `cover` fills the frame; `contain` would leave black bars top+bottom.
      // The fixture is a solid red clip, so the top strip must be red.
      const frame = await extractFrameRgba(outPath, 0.2);
      const [r, g, b] = sampleRegionMean(frame, { x: 0, y: 0, w: 240, h: 12 });
      expect(r).toBeGreaterThan(80);
      expect(r).toBeGreaterThan(g + 40);
      expect(r).toBeGreaterThan(b + 40);
    });
  });
});
