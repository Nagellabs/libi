/**
 * `storeFile` must NOT enqueue a `proxy_gen` job for alpha-bearing video —
 * the proxy is H.264 yuv420p, which silently strips the alpha plane, and
 * `alphamerge` keeps the original RGB planes intact, so a cutout's proxy IS
 * the original video with its background back. This is the B1 chain from the
 * background-removal final review: cutout stored → proxy enqueued → preview
 * prefers ready proxy → the feature silently "did nothing".
 *
 * Also asserts the row lands with `hasAlpha: true` (probed from the bytes via
 * ffprobe's `alpha_mode` stream tag) so `pickVideoUrl` can refuse the proxy
 * even if one exists from before this fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import type { FileStorage } from "@/lib/storage/types";

const enqueueJobOnServer = vi.fn(() =>
  Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" }),
);

vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: (...args: unknown[]) => enqueueJobOnServer(...(args as [])),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

// One switchable ffprobe mock: the cutout probe reports a VP9 stream whose
// alpha lives in the WebM side-band (pix_fmt LIES as yuv420p; the honest
// signal is the alpha_mode tag — matches real ffprobe output for a
// matte_gen cutout).
let probeStreams: unknown[] = [];
vi.mock("child_process", () => ({
  // Variadic: probeMedia calls execFile(cmd, args, options, cb) — the
  // callback is always LAST, whatever options node/promisify threads through.
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({
        format: { duration: "4.2" },
        streams: probeStreams,
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
  list: vi.fn(),
  remove: vi.fn(),
};

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => Promise.resolve(mockStorage)),
}));

import { storeFile } from "@/mcp/tools/file-tools";

describe("storeFile alpha-bearing video handling", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/clip-cutout.webm");
    vi.mocked(mockStorage.localPath).mockReturnValue(
      "/storage/test-piece-1/clip-cutout.webm",
    );
  });

  it("stores hasAlpha=true and does NOT enqueue proxy_gen for a VP9-alpha WebM", async () => {
    probeStreams = [
      {
        codec_type: "video",
        codec_name: "vp9",
        width: 720,
        height: 1280,
        pix_fmt: "yuv420p",
        tags: { alpha_mode: "1" },
      },
    ];

    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "clip-cutout.webm",
      buffer: Buffer.from("fake-webm-bytes"),
      contentType: "video/webm",
    });

    expect(record.hasAlpha).toBe(true);
    expect(enqueueJobOnServer).not.toHaveBeenCalled();

    const [row] = testDb.select().from(files).where(eq(files.id, record.id)).all();
    expect(row.hasAlpha).toBe(true);
    expect(row.proxyStatus).toBe("idle");
  });

  it("still enqueues proxy_gen for opaque video (hasAlpha=false)", async () => {
    probeStreams = [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p" },
      { codec_type: "audio" },
    ];
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/clip.mp4");
    vi.mocked(mockStorage.localPath).mockReturnValue("/storage/test-piece-1/clip.mp4");

    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "clip.mp4",
      buffer: Buffer.from("fake-mp4-bytes"),
      contentType: "video/mp4",
    });

    expect(record.hasAlpha).toBe(false);
    expect(enqueueJobOnServer).toHaveBeenCalledWith(
      "proxy_gen",
      { fileId: record.id },
      expect.objectContaining({ fileId: record.id }),
    );
  });

  it("stores hasAlpha=true but STILL enqueues proxy_gen for NON-VPx alpha (ProRes 4444 .mov)", async () => {
    // Preview can't recover non-VPx alpha from the original (WebCodecs
    // generally can't decode ProRes at all) — an opaque scrub proxy is
    // strictly better than no preview, and exports read the ORIGINAL anyway.
    probeStreams = [
      {
        codec_type: "video",
        codec_name: "prores",
        width: 1920,
        height: 1080,
        pix_fmt: "yuva444p10le",
      },
    ];
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/graphics.mov");
    vi.mocked(mockStorage.localPath).mockReturnValue("/storage/test-piece-1/graphics.mov");

    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "graphics.mov",
      buffer: Buffer.from("fake-mov-bytes"),
      contentType: "video/quicktime",
    });

    expect(record.hasAlpha).toBe(true); // truth recorded — exports still get alpha
    expect(enqueueJobOnServer).toHaveBeenCalledWith(
      "proxy_gen",
      { fileId: record.id },
      expect.objectContaining({ fileId: record.id }),
    );
  });

  it("probes for alpha even when the caller pre-supplied hasAudio (matte-gen path passes neither)", async () => {
    probeStreams = [
      {
        codec_type: "video",
        codec_name: "vp9",
        pix_fmt: "yuv420p",
        tags: { alpha_mode: "1" },
      },
    ];

    const record = await storeFile({
      pieceId: "test-piece-1",
      filename: "clip-cutout.webm",
      buffer: Buffer.from("fake-webm-bytes"),
      contentType: "video/webm",
      hasAudio: false, // pre-probed by caller — alpha still unknown
    });

    expect(record.hasAlpha).toBe(true);
    expect(record.hasAudio).toBe(false); // caller's value wins
    expect(enqueueJobOnServer).not.toHaveBeenCalled();
  });
});
