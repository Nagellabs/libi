/**
 * Uploading a video to a piece via storeFile must NOT auto-create a VideoScene.
 * Videos are added to the composition explicitly (as overlays) now — the upload
 * path only stores the file (+ enqueues proxy gen). The composition stays empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { pieces } from "@/lib/db/schema";

// Proxy enqueue is a fire-and-forget server call — stub it out.
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() => Promise.resolve({ status: "new", jobId: "j1", clientKey: "ck" })),
  LibiServerUnavailableError: class extends Error {},
}));

let storageRoot: string;
const PIECE_ID = "p_upload";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-upl-"));
  process.env.LIBI_HOME = storageRoot;
  testDb = createTestDb();
  testDb.insert(pieces).values({ id: PIECE_ID, name: "test", description: "", nameSetByUser: false }).run();
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
  resetTestDb();
});

describe("piece video upload creates no scene", () => {
  it("storeFile of a video leaves the composition with no scenes", async () => {
    const { storeFile } = await import("@/mcp/tools/file-tools");
    const record = await storeFile({
      pieceId: PIECE_ID,
      filename: "clip.mp4",
      buffer: Buffer.from("fakevideo"),
      contentType: "video/mp4",
      mediaDuration: 5,
      hasAudio: false, // avoid the ffprobe probe path
    });
    expect(record.type).toBe("video");

    // No composition.json should be created by an upload, and certainly no
    // VideoScene. (If a manifest exists at all, it must have zero scenes.)
    const { loadManifest } = await import("@/lib/composition/persistence");
    const manifest = await loadManifest(PIECE_ID);
    expect(manifest.sceneOrder).toEqual([]);
    expect(manifest.scenes ?? []).toHaveLength(0);

    // The upload itself didn't write a composition.json.
    expect(existsSync(join(storageRoot, "storage", PIECE_ID, "composition.json"))).toBe(false);
  });
});
