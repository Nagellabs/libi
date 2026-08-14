/**
 * Integration: lib/fal/upload-file.ts#uploadLibiFileToFal
 *
 * Verifies the two-step fal CDN upload + DB cache without any real network
 * call (global.fetch is mocked). Uses in-memory SQLite + a temp storage dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files, mcpServers } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { uploadLibiFileToFal } from "@/lib/fal/upload-file";

const PIECE_ID = "piece-fal";
const FAL_KEY = "test-fal-key-123";

function seedFile(opts: { id: string; falUploadedUrl?: string | null }): void {
  const pieceDir = path.join(tempDir, PIECE_ID);
  fs.mkdirSync(pieceDir, { recursive: true });
  const filename = `${opts.id}.mp3`;
  fs.writeFileSync(path.join(pieceDir, filename), Buffer.from("hello-audio-bytes"));
  const stat = fs.statSync(path.join(pieceDir, filename));
  testDb
    .insert(files)
    .values({
      id: opts.id,
      pieceId: PIECE_ID,
      filename,
      name: filename,
      description: "",
      type: "audio",
      storagePath: `${PIECE_ID}/${filename}`,
      contentType: "audio/mpeg",
      size: stat.size,
      falUploadedUrl: opts.falUploadedUrl ?? null,
    })
    .run();
}

function seedFalKeyRow(): void {
  testDb
    .insert(mcpServers)
    .values({
      id: "fal-ai",
      name: "fal.ai",
      type: "stdio",
      envVars: JSON.stringify({ FAL_KEY }),
    })
    .run();
}

describe("uploadLibiFileToFal", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "Fal Piece" });
    delete process.env.FAL_AI_KEY;
    delete process.env.FAL_KEY;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uploads a fresh file via the two-step flow and persists the URL", async () => {
    seedFalKeyRow();
    seedFile({ id: "f1" });

    const FILE_URL = "https://v3b.fal.media/files/x.mp3";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/storage/upload/initiate")) {
          return {
            ok: true,
            json: async () => ({ upload_url: "https://up", file_url: FILE_URL }),
          } as unknown as Response;
        }
        // PUT to upload_url
        return { ok: true, json: async () => ({}) } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadLibiFileToFal("f1");

    expect(result).toEqual({ url: FILE_URL, cached: false });

    // Persisted on the row.
    const row = testDb.select().from(files).all().find((f) => f.id === "f1");
    expect(row?.falUploadedUrl).toBe(FILE_URL);

    // The initiate request carried the Authorization: Key <key> header.
    const initiateCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/storage/upload/initiate"),
    );
    expect(initiateCall).toBeDefined();
    const initInit = initiateCall![1] as RequestInit;
    const headers = initInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Key ${FAL_KEY}`);
  });

  it("returns cached:true without calling fetch when falUploadedUrl is set", async () => {
    seedFalKeyRow();
    const CACHED = "https://v3b.fal.media/files/cached.mp3";
    seedFile({ id: "f2", falUploadedUrl: CACHED });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadLibiFileToFal("f2");

    expect(result).toEqual({ url: CACHED, cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws fal_ai_not_configured when no key is available", async () => {
    // No fal-ai DB row, no env key.
    seedFile({ id: "f3" });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadLibiFileToFal("f3")).rejects.toThrow("fal_ai_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
