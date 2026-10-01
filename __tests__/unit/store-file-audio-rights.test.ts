import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import type { FileStorage } from "@/lib/storage/types";
import { effectiveRights } from "@/lib/audio-rights/read";

vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() => Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" })),
  logProxyGenEnqueueFailure: vi.fn(),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (e: Error | null, o: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: JSON.stringify({ format: { duration: "3" }, streams: [{ codec_type: "audio", codec_name: "mp3" }] }), stderr: "" });
  },
}));
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
const mockStorage: FileStorage = {
  save: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
  deletePieceDir: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  localPath: vi.fn(),
  realPathForRead: vi.fn(),
};
vi.mock("@/lib/storage", () => ({ getStorage: vi.fn(() => Promise.resolve(mockStorage)) }));

import { storeFile, uploadFile } from "@/mcp/tools/file-tools";
import { parseAudioRights } from "@/lib/audio-rights/types";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const COPY = { class: "copyrighted" as const, source: { url: "https://x.example/a" }, decidedBy: "provenance" as const, decidedAt: "2026-09-27T00:00:00.000Z" };

describe("storeFile stamps audio rights", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/a.mp3");
    vi.mocked(mockStorage.localPath).mockReturnValue("/storage/test-piece-1/a.mp3");
  });

  it("writes the caller's stamp on an audio file", async () => {
    const r = await storeFile({ pieceId: "test-piece-1", filename: "a.mp3", buffer: Buffer.from("x"), contentType: "audio/mpeg", audioRights: COPY });
    expect(effectiveRights(r)).toEqual(COPY);
  });

  it("stamps generated when the file came from a generation tool (aiGeneration)", async () => {
    const r = await storeFile({
      pieceId: "test-piece-1", filename: "a.mp3", buffer: Buffer.from("x"), contentType: "audio/mpeg", hasAudio: true, mediaDuration: 3,
      aiGeneration: { provider: "elevenlabs", model: "music_v1", prompt: "calm piano intro", startedAt: "2026-09-27T00:00:00.000Z", completedAt: "2026-09-27T00:00:01.000Z", durationMs: 1000 },
    });
    expect(effectiveRights(r)?.class).toBe("generated");
    expect(effectiveRights(r)?.track?.title).toBe("calm piano intro");
  });

  it("leaves a generic store with no caller stamp unclassified (null → read as the user's own)", async () => {
    const r = await storeFile({ pieceId: "test-piece-1", filename: "a.mp3", buffer: Buffer.from("x"), contentType: "audio/mpeg" });
    expect(r.audioRights).toBeNull();
    expect(effectiveRights(r)?.class).toBe("owned");
  });

  it("never stamps a file without audio", async () => {
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/p.png");
    const r = await storeFile({ pieceId: "test-piece-1", filename: "p.png", buffer: Buffer.from("x"), contentType: "image/png", audioRights: COPY });
    expect(r.audioRights).toBeNull();
  });
});

/** Owner decision 2026-09-28: a file from the user's disk is theirs. The
 *  agent's `libi.upload_file` writes that as an explicit stamp, not a null. */
describe("libi.upload_file stamps the user's own file", () => {
  let dir: string;
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-upload-rights-"));
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/voice.mp3");
    vi.mocked(mockStorage.localPath).mockReturnValue("/storage/test-piece-1/voice.mp3");
  });

  const stored = (fileId: string) => testDb.select().from(files).where(eq(files.id, fileId)).get()!;

  it("a plain upload is stamped owned, decided by provenance", async () => {
    const filePath = path.join(dir, "voice.mp3");
    fs.writeFileSync(filePath, "x");
    const r = await uploadFile({ pieceId: "test-piece-1" }, { pieceId: "test-piece-1", filePath } as never);
    expect(r.success).toBe(true);
    const rights = parseAudioRights(stored((r.data as { fileId: string }).fileId).audioRights);
    expect(rights).toMatchObject({ class: "owned", decidedBy: "provenance" });
  });

  it("an upload carrying aiGeneration is still stamped generated", async () => {
    const filePath = path.join(dir, "gen.mp3");
    fs.writeFileSync(filePath, "x");
    const r = await uploadFile({ pieceId: "test-piece-1" }, {
      pieceId: "test-piece-1", filePath,
      aiGeneration: { provider: "elevenlabs", model: "music_v1", prompt: "calm piano intro", startedAt: "2026-09-27T00:00:00.000Z", completedAt: "2026-09-27T00:00:01.000Z", durationMs: 1000 },
    } as never);
    const rights = parseAudioRights(stored((r.data as { fileId: string }).fileId).audioRights);
    expect(rights).toMatchObject({ class: "generated", track: { title: "calm piano intro" } });
  });
});
