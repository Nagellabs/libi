/**
 * `storeFile` probes ffprobe when called WITHOUT `hasAudio` for a video —
 * this is the path UI uploads take (the `/api/(pieces/[pieceId]/)upload`
 * routes don't pre-probe). Without this, every UI-uploaded video lands
 * with `hasAudio: false` and the agent reasonably tells the user "no
 * audio" — which is the bug we're fixing.
 *
 * The MCP `libi.upload_file` path passes `hasAudio` explicitly, so the
 * probe inside `storeFile` is skipped — covered by the existing
 * `file-tools-has-audio.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import type { FileStorage } from "@/lib/storage/types";

// Proxy gen is a JobManager-driven background task; stub the HTTP
// enqueue path so storeFile can complete without hitting the libi server.
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() =>
    Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" }),
  ),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

// The ffprobe call: report an audio stream for the synthetic mp4 buffer.
// Variadic: probeMedia calls execFile(cmd, args, options, cb) — the callback
// is always LAST.
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({
        format: { duration: "10.5" },
        streams: [
          { codec_type: "video", width: 1920, height: 1080 },
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

const mockStorage: FileStorage = {
  save: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
  deletePieceDir: vi.fn(),
  localPath: vi.fn(),
};

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => Promise.resolve(mockStorage)),
}));

import { storeFile } from "@/mcp/tools/file-tools";

describe("storeFile auto-probes hasAudio for videos", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/clip.mp4");
    vi.mocked(mockStorage.localPath).mockReturnValue("/storage/test-piece-1/clip.mp4");
  });

  it("populates hasAudio=true via ffprobe when caller omits it (UI upload path)", async () => {
    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "clip.mp4",
      buffer: Buffer.from("fake-mp4-bytes"),
      contentType: "video/mp4",
      // hasAudio NOT passed — simulates the UI upload route
    });

    expect(record.hasAudio).toBe(true);
    expect(mockStorage.localPath).toHaveBeenCalledWith("test-piece-1", "clip.mp4");

    const [row] = testDb.select().from(files).where(eq(files.id, record.id)).all();
    expect(row.hasAudio).toBe(true);
  });

  it("backfills missing duration/dimensions from the same probe", async () => {
    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "clip.mp4",
      buffer: Buffer.from("fake-mp4-bytes"),
      contentType: "video/mp4",
    });

    expect(record.mediaDuration).toBeCloseTo(10.5);
    expect(record.mediaWidth).toBe(1920);
    expect(record.mediaHeight).toBe(1080);
  });

  it("respects an explicit hasAudio (caller's value wins over the probe)", async () => {
    // The probe mock would say `true` but the caller pre-supplied `false`.
    // The probe still RUNS (alpha presence is unknown — see the alpha-aware
    // proxy skip), but the caller's hasAudio value wins.
    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "muted.mp4",
      buffer: Buffer.from("bytes"),
      contentType: "video/mp4",
      hasAudio: false,
    });

    expect(record.hasAudio).toBe(false);
  });

  it("skips the probe entirely when the caller pre-supplies hasAudio AND hasAlpha", async () => {
    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "muted.mp4",
      buffer: Buffer.from("bytes"),
      contentType: "video/mp4",
      hasAudio: false,
      hasAlpha: false,
    });

    expect(record.hasAudio).toBe(false);
    expect(record.hasAlpha).toBe(false);
    // localPath should NOT have been consulted because we skipped probing
    expect(mockStorage.localPath).not.toHaveBeenCalled();
  });

  it("does NOT probe non-video uploads", async () => {
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/song.mp3");

    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "song.mp3",
      buffer: Buffer.from("audio-bytes"),
      contentType: "audio/mpeg",
    });

    // Audio category — probe is skipped, hasAudio defaults to false.
    expect(record.hasAudio).toBe(false);
    expect(record.type).toBe("audio");
    expect(mockStorage.localPath).not.toHaveBeenCalled();
  });
});
