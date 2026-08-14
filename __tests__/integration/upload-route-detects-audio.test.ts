/**
 * Integration: POST /api/pieces/[pieceId]/upload + POST /api/upload
 *
 * The UI upload routes never used to pass `hasAudio`, which made every
 * UI-uploaded video land with `hasAudio: false` — the agent then told
 * users their video had no audio (see session 9d544597). `storeFile`
 * now ffprobes when `hasAudio` is undefined and the file is a video,
 * so both routes get the truth without needing route-level changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

// Stub proxy enqueue — we only care about DB metadata here, not
// the proxy generation pipeline. After Task 5 the MCP-side caller
// goes through the HTTP jobs-client, so we mock that.
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() => Promise.resolve({ jobId: "job-1", resumed: false })),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

// ffprobe stub: report a video + audio stream so probeMedia returns
// hasAudio=true. The exact stdout shape mirrors a real ffprobe run.
vi.mock("child_process", () => ({
  // Variadic: probeMedia calls execFile(cmd, args, options, cb) — the
  // callback is always LAST.
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({
        format: { duration: "12.34" },
        streams: [
          { codec_type: "video", width: 480, height: 848 },
          { codec_type: "audio" },
        ],
      }),
      stderr: "",
    });
  },
}));

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Import after mocks so the routes pick them up.
import { POST as pieceUpload } from "@/app/api/pieces/[pieceId]/upload/route";
import { POST as globalUpload } from "@/app/api/upload/route";

const PIECE_ID = "piece-1";

function buildFormData(filename: string, contentType: string): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([0, 1, 2, 3])], filename, { type: contentType }));
  return fd;
}

describe("upload routes set hasAudio from server-side ffprobe", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "P" });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("piece-scoped upload of a video with audio → row has hasAudio=true", async () => {
    const fd = buildFormData("WhatsApp Video.mp4", "video/mp4");
    const req = new Request(`http://localhost/api/pieces/${PIECE_ID}/upload`, {
      method: "POST",
      body: fd,
    });
    const res = await pieceUpload(req, { params: Promise.resolve({ pieceId: PIECE_ID }) });
    expect(res.status).toBe(200);

    const rows = testDb.select().from(files).where(eq(files.pieceId, PIECE_ID)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].hasAudio).toBe(true);
    // Backfilled probe data also lands on the row.
    expect(rows[0].mediaDuration).toBeCloseTo(12.34);
    expect(rows[0].mediaWidth).toBe(480);
    expect(rows[0].mediaHeight).toBe(848);
  });

  it("global upload (no pieceId) of a video with audio → row has hasAudio=true", async () => {
    const fd = buildFormData("clip.mp4", "video/mp4");
    const req = new Request("http://localhost/api/upload", { method: "POST", body: fd });
    const res = await globalUpload(req);
    expect(res.status).toBe(200);

    const rows = testDb.select().from(files).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].pieceId).toBeNull();
    expect(rows[0].hasAudio).toBe(true);
  });
});
