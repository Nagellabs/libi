// __tests__/integration/tools/add-tracked-overlay.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

const PIECE_ID = "piece-tov-1";
const FILE_ID = "file-tov-1";
let db: ReturnType<typeof createTestDb>;
let tmp: string;

beforeEach(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  tmp = await mkdtemp(join(tmpdir(), "libi-tracked-overlay-"));
  process.env.LIBI_HOME = tmp;
  delete (globalThis as { __libiTrackingManager?: unknown }).__libiTrackingManager;

  db = createTestDb();
  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID, pieceId: PIECE_ID, filename: "a.mp4", name: "a", description: "",
    type: "video", storagePath: "/tmp/a.mp4", size: 0,
  });
});

afterEach(async () => {
  resetTestDb();
  delete (globalThis as { __libiTrackingManager?: unknown }).__libiTrackingManager;
  delete process.env.LIBI_HOME;
  const { rm } = await import("node:fs/promises");
  await rm(tmp, { recursive: true, force: true });
});

describe("addTrackedOverlay", () => {
  it("rejects if trackId doesn't exist", async () => {
    const { addTrackedOverlay } = await import("@/mcp/tools/tracking-tools");
    const result = await addTrackedOverlay({
      pieceId: PIECE_ID, trackId: "nope",
      startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 10, opacity: 1, content: { kind: "emoji", char: "😀" },
      fit: "tight", scale: 1.0, smoothing: "linear",
    });
    expect(result.success).toBe(false);
  });

  it("adds the overlay to the manifest when trackId exists", async () => {
    const { insertTrackRow } = await import("@/lib/tracking/repo");
    await insertTrackRow(db, {
      id: "t1", fileId: FILE_ID, method: "mediapipe-face",
      framerate: 30, durationSec: 1, sampleCount: 30,
    });

    const { addTrackedOverlay } = await import("@/mcp/tools/tracking-tools");
    const result = await addTrackedOverlay({
      pieceId: PIECE_ID, trackId: "t1",
      startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 10, opacity: 1, content: { kind: "emoji", char: "😀" },
      fit: "tight", scale: 1.2, smoothing: "linear",
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");

    const { loadManifest } = await import("@/lib/composition/persistence");
    const manifest = await loadManifest(PIECE_ID);
    const overlay = (manifest.overlays ?? []).find((o) => o.id === result.data!.overlayId);
    expect(overlay).toBeDefined();
    expect(overlay!.kind).toBe("tracked");
  });
});
