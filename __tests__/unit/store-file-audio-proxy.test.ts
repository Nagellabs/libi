/**
 * `storeFile` enqueues a `proxy_gen` job for an audio file the preview can't
 * play itself (review round 4: FLAC in Ogg, a chained Ogg, a codec WebCodecs
 * doesn't decode: lib/ffmpeg/audio-preview.ts), and for no other audio file.
 * The preview's audio engine then plays the proxy's AAC instead of silence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import type { FileStorage } from "@/lib/storage/types";

const enqueueJobOnServer = vi.fn(() => Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" }));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: (...args: unknown[]) => enqueueJobOnServer(...(args as [])),
  logProxyGenEnqueueFailure: vi.fn(),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

/** What ffprobe says about the stored file. */
let probeOut: { format: Record<string, string>; streams: unknown[] } = { format: {}, streams: [] };
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (err: Error | null, out: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: JSON.stringify(probeOut), stderr: "" });
  },
}));

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

const mockStorage = {
  save: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
  deletePieceDir: vi.fn(),
  localPath: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  realPathForRead: vi.fn(),
} as unknown as FileStorage;
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn(() => Promise.resolve(mockStorage)) }));

import { storeFile } from "@/mcp/tools/file-tools";

async function store(filename: string, contentType: string) {
  vi.mocked(mockStorage.save).mockResolvedValue(`test-piece-1/${filename}`);
  // A path that doesn't exist: the Ogg page scan reads nothing (not chained).
  vi.mocked(mockStorage.localPath).mockReturnValue(`/nonexistent/test-piece-1/${filename}`);
  return storeFile({ pieceId: "test-piece-1", filename, buffer: Buffer.from("bytes"), contentType });
}

describe("storeFile: an audio file the preview can't play gets a proxy (review round 4)", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
  });

  it("FLAC in Ogg: proxy_gen is enqueued", async () => {
    probeOut = { format: { format_name: "ogg", duration: "4" }, streams: [{ index: 0, codec_type: "audio", codec_name: "flac" }] };
    const record = await store("song.ogg", "audio/ogg");
    expect(record.type).toBe("audio");
    expect(enqueueJobOnServer).toHaveBeenCalledWith("proxy_gen", { fileId: record.id }, expect.objectContaining({ fileId: record.id }));
  });

  it("ALAC in M4A: proxy_gen is enqueued", async () => {
    probeOut = { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "4" }, streams: [{ index: 0, codec_type: "audio", codec_name: "alac" }] };
    const record = await store("song.m4a", "audio/mp4");
    expect(enqueueJobOnServer).toHaveBeenCalledWith("proxy_gen", { fileId: record.id }, expect.anything());
  });

  it("an ordinary MP3 or Opus Ogg: nothing is enqueued", async () => {
    probeOut = { format: { format_name: "mp3", duration: "4" }, streams: [{ index: 0, codec_type: "audio", codec_name: "mp3" }] };
    await store("song.mp3", "audio/mpeg");
    probeOut = { format: { format_name: "ogg", duration: "4" }, streams: [{ index: 0, codec_type: "audio", codec_name: "opus" }] };
    await store("voice.ogg", "audio/ogg");
    expect(enqueueJobOnServer).not.toHaveBeenCalled();
  });
});
