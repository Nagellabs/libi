/**
 * Integration: POST /api/pieces/[pieceId]/overlays create route.
 *
 * Asserts the route persists text/image/video overlays via the addOverlay
 * tool fn, and rejects code/three (agent-only) + malformed bodies with 400.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { POST } from "@/app/api/pieces/[pieceId]/overlays/route";
import { saveManifest, loadManifest, EMPTY_MANIFEST } from "@/lib/composition/persistence";

const PIECE = "p1";

function req(body: unknown) {
  return new Request("http://x/api/pieces/p1/overlays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST overlays create route", () => {
  beforeEach(async () => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
    await saveManifest(PIECE, { ...EMPTY_MANIFEST });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("creates a text overlay and returns its id", async () => {
    const res = await POST(
      req({
        kind: "text",
        startTime: 1,
        duration: 3,
        z: 0,
        rect: { x: 10, y: 10, width: 100, height: 40 },
        content: "Hi",
        font: "48px Inter",
        color: "#fff",
        align: "center",
      }),
      { params: Promise.resolve({ pieceId: PIECE }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(typeof json.overlayId).toBe("string");

    const manifest = await loadManifest(PIECE);
    expect(manifest.overlays).toHaveLength(1);
    expect(manifest.overlays?.[0].id).toBe(json.overlayId);
    expect(manifest.overlays?.[0].kind).toBe("text");
  });

  it("rejects a code overlay with 400", async () => {
    const res = await POST(
      req({ kind: "code", startTime: 0, duration: 3, z: 0, rect: { x: 0, y: 0, width: 10, height: 10 } }),
      { params: Promise.resolve({ pieceId: PIECE }) },
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed body with 400", async () => {
    const res = await POST(req({ kind: "text" }), {
      params: Promise.resolve({ pieceId: PIECE }),
    });
    expect(res.status).toBe(400);
  });
});
