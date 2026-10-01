import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { Composition } from "@/lib/engine/types";
import type { RenderPayload } from "@/lib/export/render-jobs";
import type { JobContext } from "@/lib/jobs/types";
import { serializeAudioRights } from "@/lib/audio-rights/types";

const captured = vi.hoisted(() => ({ chromium: [] as RenderPayload[], ffmpeg: [] as Composition[], copy: 0 }));
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({ ...(await orig<typeof import("@/lib/export/ensure-chromium")>()), ensureChromium: vi.fn(async () => {}) }));
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    async run(ctx: { payload: RenderPayload }) {
      captured.chromium.push(ctx.payload);
      return { blob: new Blob([new Uint8Array([0, 1])]), duration: 2 };
    }
  },
}));
vi.mock("@/lib/export/backends/ffmpeg-overlay", () => ({
  overlayGraphNeedsBrowser: async () => false,
  FfmpegOverlayBackend: class {
    async run(ctx: { composition: Composition; outputPath: string }) {
      captured.ffmpeg.push(ctx.composition);
      fs.writeFileSync(ctx.outputPath, "x");
      return { duration: 2 };
    }
  },
}));
vi.mock("@/lib/export/backends/stream-copy-trim", () => ({
  StreamCopyTrimBackend: class {
    async run(ctx: { outputPath: string }) {
      captured.copy++;
      fs.writeFileSync(ctx.outputPath, "x");
      return { duration: 2 };
    }
  },
}));

import { exportRunner, type ExportParams } from "@/lib/jobs/runners/export";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const PIECE = "p-audio-policy";
const ctx = (params: ExportParams): JobContext<ExportParams> => ({ jobId: "job-t", params, resumeState: null, reportProgress: () => {}, checkpoint: async () => {}, shouldCancel: () => false });
const params = (extra: Record<string, unknown>): ExportParams =>
  ({ pieceId: PIECE, source: "draft", filename: "out", settings: { format: "mp4", codec: "avc", bitrate: 1_000_000, width: 320, height: 240, fps: 24, ...extra } }) as ExportParams;

// Stamped explicitly: an unstamped file reads as the user's own (owner decision 2026-09-28).
const COPYRIGHTED = serializeAudioRights({ class: "copyrighted", decidedBy: "provenance", decidedAt: "x" });

describe("export runner — copyrighted audio", () => {
  beforeEach(() => {
    captured.chromium = [];
    captured.ffmpeg = [];
    captured.copy = 0;
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb() as never, { id: PIECE });
    const db = getDb();
    db.insert(files).values({ id: "song", pieceId: PIECE, filename: "song.mp3", name: "Song", description: "", type: "audio", storagePath: `${PIECE}/song.mp3`, hasAudio: true, audioRights: COPYRIGHTED }).run();
    db.insert(files).values({ id: "mine", pieceId: PIECE, filename: "mine.wav", name: "Mine", description: "", type: "audio", storagePath: `${PIECE}/mine.wav`, hasAudio: true, audioRights: serializeAudioRights({ class: "generated", decidedBy: "provenance", decidedAt: "x" }) }).run();
    db.insert(files).values({ id: "vid", pieceId: PIECE, filename: "vid.mp4", name: "Vid", description: "", type: "video", storagePath: `${PIECE}/vid.mp4`, hasAudio: true, mediaWidth: 320, mediaHeight: 240, audioRights: COPYRIGHTED }).run();
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
  });

  it("social: the copyrighted song leaves the render payload, generated music stays, the decision is recorded", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" }] as typeof m.overlays;
    m.audioClips = [
      { id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
      { id: "b", kind: "standalone", fileId: "mine", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
    ];
    await saveManifest(PIECE, m);
    const r = await exportRunner.run(ctx(params({ purpose: "social" })));
    expect(captured.chromium[0].audioClips.map((c) => c.id)).toEqual(["b"]);
    expect(r.audioDecision).toEqual({ purpose: "social", excludedFileIds: ["song"], carriesCopyrighted: false });
  });

  it("never takes the stream-copy path when a base video's own sound is excluded", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "v", kind: "video", fileId: "vid", startTime: 0, duration: 2, z: 0, opacity: 1, fit: "cover", rect: { x: 0, y: 0, width: 320, height: 240 } }] as typeof m.overlays;
    m.audioClips = [{ id: "vi", kind: "inline", fileId: "vid", linkedOverlayId: "v", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true }];
    await saveManifest(PIECE, m);
    const r = await exportRunner.run(ctx(params({ purpose: "social" })));
    expect(captured.copy).toBe(0);
    expect(captured.ffmpeg[0].audioClips).toEqual([]);
    // Excluding the base's own audio drops its inline CLIP, never the video
    // overlay itself — the picture stays (D-A, docs-local/…/global-constraints.md).
    expect((captured.ffmpeg[0].overlays ?? []).map((o) => o.id)).toContain("v");
    expect(r.backend).toBe("ffmpeg-overlay");
  });

  it("no purpose and no copyrightedAudio on a piece with a copyrighted song: the job fails with the purpose question, nothing rendered", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" }] as typeof m.overlays;
    m.audioClips = [{ id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true }];
    await saveManifest(PIECE, m);
    await expect(exportRunner.run(ctx(params({})))).rejects.toThrow(
      /^This piece has copyrighted music \(Song\)\. Ask the user what this export is for/,
    );
    expect(captured.chromium).toEqual([]);
    expect(captured.ffmpeg).toEqual([]);
    expect(fs.existsSync(path.join(getLibiStorageDir(), PIECE, "exports")) ? fs.readdirSync(path.join(getLibiStorageDir(), PIECE, "exports")) : []).toEqual([]);
  });

  it("an explicit copyrightedAudio without a purpose is an answer: the export runs", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" }] as typeof m.overlays;
    m.audioClips = [{ id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true }];
    await saveManifest(PIECE, m);
    const r = await exportRunner.run(ctx(params({ copyrightedAudio: "exclude" })));
    expect(captured.chromium[0].audioClips).toEqual([]);
    expect(r.audioDecision).toEqual({ purpose: null, excludedFileIds: ["song"], carriesCopyrighted: false });
  });

  it("no purpose on a piece without copyrighted audio (or with it only on a hidden layer) still exports", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [
      { id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" },
      { id: "v", kind: "video", fileId: "vid", startTime: 0, duration: 2, z: 1, opacity: 1, fit: "cover", hidden: true, rect: { x: 0, y: 0, width: 320, height: 240 } },
    ] as typeof m.overlays;
    m.audioClips = [
      { id: "b", kind: "standalone", fileId: "mine", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
      { id: "vi", kind: "inline", fileId: "vid", linkedOverlayId: "v", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
    ];
    await saveManifest(PIECE, m);
    const r = await exportRunner.run(ctx(params({})));
    expect(r.audioDecision).toEqual({ purpose: null, excludedFileIds: [], carriesCopyrighted: false });
  });

  it("personal keeps everything", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" }] as typeof m.overlays;
    m.audioClips = [{ id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true }];
    await saveManifest(PIECE, m);
    const r = await exportRunner.run(ctx(params({ purpose: "personal" })));
    expect(captured.chromium[0].audioClips.map((c) => c.id)).toEqual(["a"]);
    expect(r.audioDecision?.carriesCopyrighted).toBe(true);
  });

  it("excludeFileIds leaves a non-copyrighted file's sound out too", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" }] as typeof m.overlays;
    m.audioClips = [
      { id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
      { id: "b", kind: "standalone", fileId: "mine", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
    ];
    await saveManifest(PIECE, m);
    const r = await exportRunner.run(ctx(params({ purpose: "personal", excludeFileIds: ["mine"] })));
    expect(captured.chromium[0].audioClips.map((c) => c.id)).toEqual(["a"]);
    expect(r.audioDecision).toEqual({ purpose: "personal", excludedFileIds: ["mine"], carriesCopyrighted: true });
  });
});
