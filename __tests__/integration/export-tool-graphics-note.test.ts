/**
 * EXP-4 — `libi.export_video {quality: "1080p"}` on a piece with graphics comes
 * out 3840×2160, because `graphicsQuality` defaults to 4K (0.1.15's quality
 * split, kept as a product decision). The tool result now SAYS so.
 *
 * The tool's fetch to the studio is answered by the REAL POST /api/export route
 * (the job manager is stubbed, so nothing renders); the job's completed event
 * echoes the route's resolved frame, as the export runner does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";

vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    enqueue: async () => ({ status: "new", jobId: "job-1" }),
    runToCompletion: async () => undefined,
  }),
}));
vi.mock("@/lib/libi-home", async (orig) => ({
  ...(await orig<typeof import("@/lib/libi-home")>()),
  getCurrentPort: () => 3999,
}));
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/ensure-chromium")>()),
  chromiumInstalled: async () => true,
}));

import { getDb } from "@/lib/db/client";
import { addOverlayToManifest, loadManifest, saveManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { POST } from "@/app/api/export/route";
import { exportVideo } from "@/mcp/tools/export-tools";

const PIECE_ID = "p-graphics-note";
const NOTE_4K = 'Exported at 3840×2160: text/code/3D default to 4K. Pass graphicsQuality: "1080p" to cap them.';

const TEXT: PersistedOverlay = {
  id: "o-text",
  kind: "text",
  content: "caption",
  font: "800 60px Inter",
  color: "#fff",
  align: "center",
  rect: { x: 0, y: 0, width: 400, height: 80 },
  startTime: 0,
  duration: 2,
  z: 1,
  opacity: 1,
};
const VIDEO: PersistedOverlay = {
  id: "o-video",
  kind: "video",
  fileId: "f1",
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  startTime: 0,
  duration: 2,
  z: 0,
  opacity: 1,
};

describe("libi.export_video — says when graphics raised the frame above quality", () => {
  const realFetch = globalThis.fetch;
  let destFolder: string;

  beforeEach(async () => {
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb() as never, { id: PIECE_ID, name: "Piece" });
    destFolder = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-note-"));
    const m = await loadManifest(PIECE_ID);
    m.width = 1920;
    m.height = 1080;
    m.fps = 30;
    await saveManifest(PIECE_ID, m);
    await addOverlayToManifest(PIECE_ID, VIDEO);

    let resolved: { width: number; height: number } = { width: 0, height: 0 };
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/export") && init?.method === "POST") {
        const res = await POST(new Request("http://test/api/export", { method: "POST", body: init.body }));
        const json = (await res.clone().json()) as { settings?: { width: number; height: number } };
        if (json.settings) resolved = { width: json.settings.width, height: json.settings.height };
        return res;
      }
      if (url.endsWith("/api/jobs/job-1/events")) {
        const result = {
          filePath: path.join(destFolder, "Piece.mp4"),
          sizeBytes: 10,
          durationSeconds: 2,
          backend: "ffmpeg-overlay",
          ...resolved,
        };
        return new Response(`event: completed\ndata: ${JSON.stringify({ jobId: "job-1", result })}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetTestDb();
    cleanupTempDir();
    fs.rmSync(destFolder, { recursive: true, force: true });
  });

  it("quality 1080p + a text overlay → 3840×2160 with the note", async () => {
    await addOverlayToManifest(PIECE_ID, TEXT);
    const result = await exportVideo({ pieceId: PIECE_ID, quality: "1080p" });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    expect([result.data.width, result.data.height]).toEqual([3840, 2160]);
    expect(result.data.note).toBe(NOTE_4K);
  });

  it("no note when graphicsQuality is passed explicitly (the agent's own choice)", async () => {
    await addOverlayToManifest(PIECE_ID, TEXT);
    const capped = await exportVideo({ pieceId: PIECE_ID, quality: "1080p", graphicsQuality: "1080p" });
    if (!capped.success) throw new Error("export failed");
    expect([capped.data.width, capped.data.height]).toEqual([1920, 1080]);
    expect(capped.data.note).toBeUndefined();

    const explicit4k = await exportVideo({ pieceId: PIECE_ID, quality: "1080p", graphicsQuality: "4k" });
    if (!explicit4k.success) throw new Error("export failed");
    expect([explicit4k.data.width, explicit4k.data.height]).toEqual([3840, 2160]);
    expect(explicit4k.data.note).toBeUndefined();
  });

  it("no note without graphics: quality 1080p stays 1920×1080", async () => {
    const result = await exportVideo({ pieceId: PIECE_ID, quality: "1080p" });
    if (!result.success) throw new Error("export failed");
    expect([result.data.width, result.data.height]).toEqual([1920, 1080]);
    expect(result.data.note).toBeUndefined();
  });

  it("no note when quality 4k already matches the graphics tier", async () => {
    await addOverlayToManifest(PIECE_ID, TEXT);
    const result = await exportVideo({ pieceId: PIECE_ID, quality: "4k" });
    if (!result.success) throw new Error("export failed");
    expect([result.data.width, result.data.height]).toEqual([3840, 2160]);
    expect(result.data.note).toBeUndefined();
  });
});
