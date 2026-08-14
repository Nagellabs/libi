/**
 * Integration: `/api/export/ffmpeg` route — hidden layers (the PERSISTED
 * `overlay.hidden` field, the eye toggle) are filtered BEFORE the second-pass
 * classifier and the backend run.
 *
 * Seed: a stream-copy-eligible base video overlay + an inset PIP video overlay
 * + an inline audio clip COUPLED to the PIP. With the PIP visible this
 * classifies as `ffmpeg-overlay` (composited PIP + non-base audio), so a
 * client that saw the PIP hidden and correctly classified `stream-copy-trim`
 * would 409 on a route that ignored the field — the exact regression this
 * guards.
 *
 * With `hidden: true` persisted on the PIP in the manifest the route must:
 *   1. NOT 409 — it strips the hidden layer first, so the server classifies
 *      the same filtered comp the client did (stream-copy-trim),
 *   2. hand the backend a composition with the hidden overlay AND its coupled
 *      inline clip absent.
 *
 * The stream-copy backend is stubbed (captures the composition, writes a fake
 * output file) — no ffmpeg is invoked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import type { Composition } from "@/lib/engine/types";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

const captured = vi.hoisted(() => ({ runs: [] as Array<{ composition: Composition }> }));
vi.mock("@/lib/export/backends/stream-copy-trim", () => ({
  StreamCopyTrimBackend: class {
    name = "stream-copy-trim";
    async run(ctx: { composition: Composition; outputPath: string }) {
      captured.runs.push({ composition: ctx.composition });
      fs.writeFileSync(ctx.outputPath, new Uint8Array([0]));
      return { duration: 1 };
    }
  },
}));

import { POST } from "@/app/api/export/ffmpeg/route";
import { loadManifest, saveManifest, addOverlayToManifest } from "@/lib/composition/persistence";

const PIECE_ID = "p-ffmpeg-hidden";
const VIDEO_FILE_ID = "f-video-hidden";
const VIDEO_NAME = "src.mp4";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://test/api/export/ffmpeg", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const SETTINGS = { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 };

describe("/api/export/ffmpeg — hidden layers filtered before classify", () => {
  beforeEach(async () => {
    captured.runs = [];
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID });
    fs.mkdirSync(path.join(tempDir, PIECE_ID), { recursive: true });
    fs.writeFileSync(path.join(tempDir, PIECE_ID, VIDEO_NAME), new Uint8Array([0]));
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
          size: 1,
          // Dims match the comp so the lone base is stream-copy eligible.
          mediaWidth: 320,
          mediaHeight: 240,
        },
      ])
      .run();

    const m = await loadManifest(PIECE_ID);
    m.width = 320;
    m.height = 240;
    m.fps = 24;
    // Inline audio COUPLED to the PIP — must vanish with it.
    m.audioClips = [
      {
        id: "a-pip", kind: "inline", fileId: VIDEO_FILE_ID,
        startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true,
        linkedOverlayId: "pip",
      },
    ];
    await saveManifest(PIECE_ID, m);
    // Stream-copy-eligible base…
    await addOverlayToManifest(PIECE_ID, {
      id: "vid-base",
      kind: "video",
      fileId: VIDEO_FILE_ID,
      startTime: 0,
      duration: 1,
      z: 0,
      opacity: 1,
      fit: "cover",
      rect: { x: 0, y: 0, width: 320, height: 240 },
      trim: { start: 0, end: 1 },
    });
    // …plus an inset PIP that forces ffmpeg-overlay while visible.
    await addOverlayToManifest(PIECE_ID, {
      id: "pip",
      kind: "video",
      fileId: VIDEO_FILE_ID,
      startTime: 0,
      duration: 1,
      z: 1,
      opacity: 1,
      fit: "cover",
      rect: { x: 20, y: 20, width: 80, height: 60 },
    });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("CONTROL: with the PIP visible the comp is ffmpeg-overlay → 409", async () => {
    const response = await POST(
      makeRequest({ pieceId: PIECE_ID, shape: "stream-copy-trim", settings: SETTINGS }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("ffmpeg-overlay");
  });

  it("filters BEFORE classify: a manifest-hidden PIP matches stream-copy-trim (no 409) and the backend never sees the hidden layer or its audio", async () => {
    // Persist the eye toggle: mark the PIP hidden in the DRAFT manifest —
    // exactly what the inspector eye / libi.update_overlay writes. No request
    // param exists anymore; the field IS the source of truth.
    const m = await loadManifest(PIECE_ID);
    m.overlays = m.overlays!.map((o) => (o.id === "pip" ? { ...o, hidden: true } : o));
    await saveManifest(PIECE_ID, m);

    const response = await POST(
      makeRequest({ pieceId: PIECE_ID, shape: "stream-copy-trim", settings: SETTINGS }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Export-Backend")).toBe("stream-copy-trim");

    expect(captured.runs).toHaveLength(1);
    const comp = captured.runs[0].composition;
    expect(comp.overlays?.map((o) => o.id)).toEqual(["vid-base"]);
    expect(comp.audioClips ?? []).toHaveLength(0);
  });
});
