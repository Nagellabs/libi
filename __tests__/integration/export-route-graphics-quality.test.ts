/**
 * Integration: POST /api/export — media + graphics resolution wiring.
 *
 * The route resolves `hasGraphics` from the loaded composition's overlays
 * (draft: `loadComposition`, snapshot: `loadCurrentSnapshot`) and passes it
 * + the requested/stored `graphicsQuality` into `resolveExportSettings`. The
 * unified `export` job is mocked out (`getJobManager`) so this only exercises
 * the route's own resolution — not a real ffmpeg/chromium render.
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
    // The route fires this in the background — stub it so no real export runs.
    runToCompletion: async () => undefined,
  }),
}));

import { getDb } from "@/lib/db/client";
import {
  addOverlayToManifest,
  loadManifest,
  saveManifest,
  type PersistedOverlay,
} from "@/lib/composition/persistence";
import { saveCurrentSnapshot } from "@/lib/composition/snapshots";
import { POST } from "@/app/api/export/route";

const PIECE_ID = "p-graphics-quality";

function makeRequest(body: unknown): Request {
  return new Request("http://test/api/export", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/export — graphics resolution", () => {
  // The route's default destFolder resolves to the REAL OS export folder
  // (~/Movies/libi on darwin) when the request omits `destFolder` — fine in
  // the app, but a test must not write there. Every request below passes an
  // explicit destFolder pointing at this throwaway dir instead.
  let destFolder: string;

  beforeEach(() => {
    createTestDb();
    createTempStorageDir();
    seedPiece(getDb() as never, { id: PIECE_ID, name: "Piece" });
    destFolder = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-dest-"));
  });

  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
    fs.rmSync(destFolder, { recursive: true, force: true });
  });

  async function seedPortraitManifest(): Promise<void> {
    const m = await loadManifest(PIECE_ID);
    m.width = 1080;
    m.height = 1920;
    m.fps = 30;
    await saveManifest(PIECE_ID, m);
  }

  it("raises media 'source' to graphics '4k' when the draft has a text overlay", async () => {
    await seedPortraitManifest();
    const overlay: PersistedOverlay = {
      id: "o-text",
      kind: "text",
      content: "hi",
      font: "800 60px Inter",
      color: "#fff",
      align: "center",
      rect: { x: 0, y: 0, width: 200, height: 80 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, overlay);

    const res = await POST(makeRequest({ pieceId: PIECE_ID, destFolder }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { width: number; height: number; quality: string; graphicsQuality: string } };
    expect(body.settings.quality).toBe("source");
    expect(body.settings.graphicsQuality).toBe("4k");
    expect([body.settings.width, body.settings.height]).toEqual([2160, 3840]);
  });

  it("stays at the composition size when the draft has no graphics overlays", async () => {
    await seedPortraitManifest();
    const overlay: PersistedOverlay = {
      id: "o-video",
      kind: "video",
      fileId: "f1",
      rect: { x: 0, y: 0, width: 1080, height: 1920 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, overlay);

    const res = await POST(makeRequest({ pieceId: PIECE_ID, destFolder }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { width: number; height: number } };
    expect([body.settings.width, body.settings.height]).toEqual([1080, 1920]);
  });

  it("reads overlays from the SNAPSHOT (not the draft) when source is 'snapshot'", async () => {
    // Draft has a text overlay; the committed snapshot doesn't. Requesting
    // the snapshot export must NOT be raised by the draft's graphics.
    await seedPortraitManifest();
    await saveCurrentSnapshot(PIECE_ID, { width: 1080, height: 1920, fps: 30, overlays: [] });
    const textOverlay: PersistedOverlay = {
      id: "o-text-draft-only",
      kind: "text",
      content: "draft only",
      font: "800 60px Inter",
      color: "#fff",
      align: "center",
      rect: { x: 0, y: 0, width: 200, height: 80 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, textOverlay);

    const res = await POST(makeRequest({ pieceId: PIECE_ID, source: "snapshot", destFolder }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { width: number; height: number } };
    expect([body.settings.width, body.settings.height]).toEqual([1080, 1920]);
  });

  it("honors an explicit graphicsQuality on the request body", async () => {
    await seedPortraitManifest();
    const overlay: PersistedOverlay = {
      id: "o-code",
      kind: "code",
      drawFunction: "",
      rect: { x: 0, y: 0, width: 1080, height: 1920 },
      startTime: 0,
      duration: 2,
      z: 0,
      opacity: 1,
    };
    await addOverlayToManifest(PIECE_ID, overlay);

    const res = await POST(makeRequest({ pieceId: PIECE_ID, graphicsQuality: "1080p", destFolder }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { width: number; height: number; graphicsQuality: string } };
    expect(body.settings.graphicsQuality).toBe("1080p");
    // 1080p graphics tier (1080x1920) has fewer pixels than the 1080x1920
    // media 'source' tier — equal, in fact — so media wins either way here;
    // pin the exact numbers so a future regression in the comparison shows.
    expect([body.settings.width, body.settings.height]).toEqual([1080, 1920]);
  });

  it("rejects an unknown graphicsQuality with a 400 instead of a NaN frame", async () => {
    await seedPortraitManifest();
    const res = await POST(makeRequest({ pieceId: PIECE_ID, graphicsQuality: "8k", destFolder }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/graphicsQuality must be one of 1080p, 1440p, 4k/);
  });
});
