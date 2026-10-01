// A template's example video (lib/templates/example-export.ts) is uploaded
// publicly with the published template. `renderPieceForExample` must never
// let a copyrighted song ride along on that card — it forces `purpose:
// "social"` (→ copyrightedAudio "exclude", lib/export/audio-policy.ts).
// Setup mirrors __tests__/integration/export-runner-audio-policy.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { RenderPayload } from "@/lib/export/render-jobs";
import type { JobContext } from "@/lib/jobs/types";
import { serializeAudioRights } from "@/lib/audio-rights/types";

const captured = vi.hoisted(() => ({ chromium: [] as RenderPayload[] }));
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
    async run(ctx: { outputPath: string }) {
      fs.writeFileSync(ctx.outputPath, "x");
      return { duration: 2 };
    }
  },
}));
vi.mock("@/lib/export/backends/stream-copy-trim", () => ({
  StreamCopyTrimBackend: class {
    async run(ctx: { outputPath: string }) {
      fs.writeFileSync(ctx.outputPath, "x");
      return { duration: 2 };
    }
  },
}));

import { renderPieceForExample } from "@/lib/templates/example-export";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const PIECE = "p-example-audio-policy";
const jobCtx = (): JobContext<unknown> => ({
  jobId: "job-example",
  params: {},
  resumeState: null,
  reportProgress: () => {},
  checkpoint: async () => {},
  shouldCancel: () => false,
});

// Stamped explicitly: an unstamped file reads as the user's own (owner decision 2026-09-28).
const COPYRIGHTED = serializeAudioRights({ class: "copyrighted", decidedBy: "provenance", decidedAt: "x" });

describe("renderPieceForExample — a public example never carries a copyrighted song", () => {
  let dest: string;
  beforeEach(() => {
    captured.chromium = [];
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb() as never, { id: PIECE });
    dest = fs.mkdtempSync(path.join(os.tmpdir(), "libi-example-audio-policy-"));
    const db = getDb();
    db.insert(files).values({ id: "song", pieceId: PIECE, filename: "song.mp3", name: "Song", description: "", type: "audio", storagePath: `${PIECE}/song.mp3`, hasAudio: true, audioRights: COPYRIGHTED }).run();
    db.insert(files).values({ id: "mine", pieceId: PIECE, filename: "mine.wav", name: "Mine", description: "", type: "audio", storagePath: `${PIECE}/mine.wav`, hasAudio: true, audioRights: serializeAudioRights({ class: "generated", decidedBy: "provenance", decidedAt: "x" }) }).run();
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it("excludes the copyrighted clip and keeps the generated one, with no purpose passed by the caller", async () => {
    const m = await loadManifest(PIECE);
    Object.assign(m, { width: 320, height: 240, fps: 24 });
    m.overlays = [{ id: "code-bg", kind: "code", startTime: 0, duration: 2, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw" }] as typeof m.overlays;
    m.audioClips = [
      { id: "a", kind: "standalone", fileId: "song", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
      { id: "b", kind: "standalone", fileId: "mine", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
    ];
    await saveManifest(PIECE, m);

    const filePath = await renderPieceForExample(jobCtx(), PIECE, dest, new AbortController().signal, 0, 100);

    expect(filePath).toBeTruthy();
    expect(captured.chromium).toHaveLength(1);
    expect(captured.chromium[0].audioClips.map((c) => c.id)).toEqual(["b"]);
  });
});
