/**
 * Integration: `/api/export/chromium` route — classifier-mismatch 409.
 *
 * The chromium endpoint does NOT accept a `shape` field in its body (the
 * ffmpeg endpoint does). Instead, it runs the classifier server-side and
 * rejects with 409 if the composition does not classify as `chromium-render`.
 * This is the router's safety net: if the client dispatched to /chromium
 * but the composition has since drifted to an ffmpeg-routable shape, the
 * route bounces back with a 409 so the client can re-dispatch.
 *
 * We seed a single video scene with a trim — classifier returns
 * `stream-copy-trim` — POST to /chromium — expect 409.
 *
 * No ffmpeg or driver is invoked; the 409 fires before `backend.run()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
let tempDir: string;
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(tempDir) }));

import { POST } from "@/app/api/export/chromium/route";
import {
  loadManifest,
  saveManifest,
  addOverlayToManifest,
} from "@/lib/composition/persistence";

const PIECE_ID = "p-chromium-409";
const VIDEO_FILE_ID = "f-video-409";
const VIDEO_NAME = "src.mp4";

describe("Layer-2: /api/export/chromium route — 409 on classifier mismatch", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID });
    fs.mkdirSync(path.join(tempDir, PIECE_ID), { recursive: true });
    // Empty placeholder file — classifier never reads its bytes.
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
          // Source dims must match the comp for `-c copy` to preserve framing,
          // which is what makes this comp classify as stream-copy-trim.
          mediaWidth: 320,
          mediaHeight: 240,
        },
      ])
      .run();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("returns 409 when the composition classifies as stream-copy-trim", async () => {
    // Seed a single full-frame base video overlay with a trim and nothing on
    // top. This classifies as `stream-copy-trim` — not `chromium-render` — so
    // the endpoint's second-pass classifier check must return 409.
    const m = await loadManifest(PIECE_ID);
    m.width = 320;
    m.height = 240;
    m.fps = 24;
    await saveManifest(PIECE_ID, m);
    await addOverlayToManifest(PIECE_ID, {
      id: "ov-1",
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

    const req = new Request("http://test/api/export/chromium", {
      method: "POST",
      body: JSON.stringify({
        pieceId: PIECE_ID,
        settings: { format: "mp4", codec: "avc", bitrate: 0, width: 320, height: 240, fps: 24 },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(req);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("stream-copy-trim");
  });
});
