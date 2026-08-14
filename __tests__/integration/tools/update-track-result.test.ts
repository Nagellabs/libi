import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/db/client";

let tmp: string;
let db: ReturnType<typeof createTestDb>;

const PIECE_ID = "piece-utr-1";
const FILE_ID = "file-utr-1";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "libi-update-track-"));
  process.env.LIBI_HOME = tmp;

  db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);

  seedPiece(db, { id: PIECE_ID });
  await db.insert(files).values({
    id: FILE_ID,
    pieceId: PIECE_ID,
    filename: "b.mp4",
    name: "b",
    description: "",
    type: "video",
    storagePath: "/tmp/b.mp4",
    size: 0,
    mediaWidth: 1280,
    mediaHeight: 720,
  });
});

afterEach(async () => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  await rm(tmp, { recursive: true, force: true });
  vi.resetModules();
});

describe("updateTrackResult tool integration", () => {
  it("writes DB row + JSON sidecar and returns trackId", async () => {
    const { updateTrackResult } = await import("@/mcp/tools/tracking-tools");
    const { getTrackRow } = await import("@/lib/tracking/repo");
    const { readTrack } = await import("@/lib/tracking/storage");

    const result = await updateTrackResult({
      fileId: FILE_ID,
      method: "sam2-local",
      framerate: 25,
      samples: [
        { t: 0, x: 5, y: 5, w: 20, h: 20, confidence: 0.95, visible: true },
        { t: 0.04, x: 6, y: 6, w: 21, h: 21, confidence: 0.93, visible: true },
      ],
      label: "product",
    });

    expect(result.success).toBe(true);
    const data = result.data as { trackId: string; samplesWritten: number; replaced: boolean } | undefined;

    expect(data?.trackId).toMatch(/^trk-/);
    expect(data?.samplesWritten).toBe(2);
    expect(data?.replaced).toBe(false);

    const row = await getTrackRow(db as never, data?.trackId as string);
    expect(row).not.toBeNull();
    expect(row?.method).toBe("sam2-local");
    expect(row?.sampleCount).toBe(2);
    expect(row?.label).toBe("product");

    const track = await readTrack(PIECE_ID, data?.trackId as string);
    expect(track?.samples).toHaveLength(2);
    expect(track?.samples[0].x).toBe(5);
  });

  it("replaces an existing track when called with the same trackId", async () => {
    const { updateTrackResult } = await import("@/mcp/tools/tracking-tools");
    const { getTrackRow } = await import("@/lib/tracking/repo");
    const { readTrack } = await import("@/lib/tracking/storage");

    const firstResult = await updateTrackResult({
      fileId: FILE_ID,
      method: "sam2-local",
      framerate: 25,
      samples: [{ t: 0, x: 1, y: 1, w: 5, h: 5, confidence: 1, visible: true }],
    });

    expect(firstResult.success).toBe(true);
    const firstData = firstResult.data as { trackId: string } | undefined;
    const trackId = firstData?.trackId as string;

    // Second call with same trackId — should replace
    const secondResult = await updateTrackResult({
      trackId,
      fileId: FILE_ID,
      method: "sam2-local",
      framerate: 25,
      samples: [
        { t: 0, x: 99, y: 99, w: 10, h: 10, confidence: 0.8, visible: true },
        { t: 0.04, x: 100, y: 100, w: 11, h: 11, confidence: 0.7, visible: true },
      ],
    });

    expect(secondResult.success).toBe(true);
    const secondData = secondResult.data as { replaced: boolean; samplesWritten: number } | undefined;
    expect(secondData?.replaced).toBe(true);
    expect(secondData?.samplesWritten).toBe(2);

    // DB should have exactly one row for this trackId
    const row = await getTrackRow(db as never, trackId);
    expect(row?.sampleCount).toBe(2);

    // Storage reflects the second write
    const track = await readTrack(PIECE_ID, trackId);
    expect(track?.samples).toHaveLength(2);
    expect(track?.samples[0].x).toBe(99);
  });

  it("returns structured error for nonexistent file", async () => {
    const { updateTrackResult } = await import("@/mcp/tools/tracking-tools");

    const result = await updateTrackResult({
      fileId: "no-such-file",
      method: "external",
      framerate: 30,
      samples: [{ t: 0, x: 0, y: 0, w: 5, h: 5, confidence: 1, visible: true }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/file not found: no-such-file/);
  });

  it("returns structured error for unassigned (global) file", async () => {
    await db.insert(files).values({
      id: "global-file-utr",
      pieceId: null,
      filename: "g.mp4",
      name: "g",
      description: "",
      type: "video",
      storagePath: "/tmp/g.mp4",
      size: 0,
    });

    const { updateTrackResult } = await import("@/mcp/tools/tracking-tools");

    const result = await updateTrackResult({
      fileId: "global-file-utr",
      method: "external",
      framerate: 30,
      samples: [{ t: 0, x: 0, y: 0, w: 5, h: 5, confidence: 1, visible: true }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/file must be assigned to a piece/);
  });
});
