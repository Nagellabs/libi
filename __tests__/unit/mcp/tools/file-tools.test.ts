import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import type { FileStorage } from "@/lib/storage/types";
import * as fsPromises from "fs/promises";

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    access: vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock("child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) =>
      cb(new Error("not available"), "", ""),
  ),
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

import { storeFile, categorizeFileType, uploadFile } from "@/mcp/tools/file-tools";

describe("categorizeFileType", () => {
  it("categorizes image types", () => {
    expect(categorizeFileType("image/png")).toBe("image");
    expect(categorizeFileType("image/jpeg")).toBe("image");
  });

  it("categorizes video types", () => {
    expect(categorizeFileType("video/mp4")).toBe("video");
    expect(categorizeFileType("video/webm")).toBe("video");
  });

  it("categorizes audio types", () => {
    expect(categorizeFileType("audio/mpeg")).toBe("audio");
    expect(categorizeFileType("audio/wav")).toBe("audio");
  });

  it("categorizes document types", () => {
    expect(categorizeFileType("text/plain")).toBe("document");
    expect(categorizeFileType("application/pdf")).toBe("document");
    expect(categorizeFileType("application/json")).toBe("document");
  });

  it("returns 'other' for unknown types", () => {
    expect(categorizeFileType("application/zip")).toBe("other");
    expect(categorizeFileType(null)).toBe("other");
  });
});

describe("storeFile", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
  });

  it("saves file to storage and inserts DB record with correct fields", async () => {
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/intro.mp4");

    const result = await storeFile({
      pieceId: "test-piece-1",
      filename: "intro.mp4",
      buffer: Buffer.from("fake-video-bytes"),
      contentType: "video/mp4",
      name: "My Intro",
      description: "Intro video",
      mediaDuration: 12.5,
      mediaWidth: 1920,
      mediaHeight: 1080,
    });

    expect(result.id).toBeDefined();
    expect(result.filename).toBe("intro.mp4");
    expect(result.name).toBe("My Intro");
    expect(result.type).toBe("video");
    expect(result.contentType).toBe("video/mp4");
    expect(result.size).toBe(16);
    expect(result.mediaDuration).toBe(12.5);
    expect(result.mediaWidth).toBe(1920);
    expect(result.mediaHeight).toBe(1080);

    expect(mockStorage.save).toHaveBeenCalledWith(
      "test-piece-1", "intro.mp4", expect.any(Buffer), "video/mp4",
    );

    const rows = testDb.select().from(files).where(eq(files.pieceId, "test-piece-1")).all();
    expect(rows).toHaveLength(1);
  });

  it("defaults name to filename when not provided", async () => {
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/photo.png");

    const result = await storeFile({
      pieceId: "test-piece-1",
      filename: "photo.png",
      buffer: Buffer.from("png-bytes"),
      contentType: "image/png",
    });

    expect(result.name).toBe("photo.png");
    expect(result.description).toBe("");
  });

  it("sanitizes filename by stripping path separators", async () => {
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/evil.txt");

    const result = await storeFile({
      pieceId: "test-piece-1",
      filename: "../../../etc/evil.txt",
      buffer: Buffer.from("data"),
      contentType: "text/plain",
    });

    expect(result.filename).toBe("evil.txt");
    expect(mockStorage.save).toHaveBeenCalledWith(
      "test-piece-1", "evil.txt", expect.any(Buffer), "text/plain",
    );
  });
});

describe("uploadFile", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb);
    vi.clearAllMocks();
  });

  it("reads file from path, infers contentType, and stores it", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("video-data") as never);
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/clip.mp4");

    const ctx = { pieceId: "test-piece-1" };
    const result = await uploadFile(ctx, {
      pieceId: "test-piece-1",
      filePath: "/Users/someone/Videos/clip.mp4",
      description: "test file",
    });

    expect(result.success).toBe(true);
    expect(result.data?.filename).toBe("clip.mp4");
    expect(result.data?.contentType).toBe("video/mp4");
    expect(result.data?.type).toBe("video");
  });

  it("returns error when file does not exist", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const ctx = { pieceId: "test-piece-1" };
    const result = await uploadFile(ctx, {
      pieceId: "test-piece-1",
      filePath: "/nonexistent/file.mp4",
      description: "test file",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("uses provided name and description", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("img") as never);
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/photo.jpg");

    const ctx = { pieceId: "test-piece-1" };
    const result = await uploadFile(ctx, {
      pieceId: "test-piece-1",
      filePath: "/Users/someone/photo.jpg",
      name: "Holiday Photo",
      description: "Beach sunset",
    });

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe("Holiday Photo");
  });

  it("persists aiGeneration metadata when provided", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("video") as never);
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/hook.mp4");

    const ctx = { pieceId: "test-piece-1" };
    const result = await uploadFile(ctx, {
      pieceId: "test-piece-1",
      filePath: "/Users/someone/hook.mp4",
      description: "veo3.1-fast generation",
      aiGeneration: {
        provider: "fal-ai",
        model: "fal-ai/veo3.1/fast",
        prompt: "casual woman, mid-30s, beverage bottle close-up, golden hour kitchen",
        costEstimate: { amount: 0.5, currency: "USD", tier: "veo3.1-fast/720p/9:16" },
        startedAt: "2026-05-27T11:00:00.000Z",
        completedAt: "2026-05-27T11:00:42.000Z",
        durationMs: 42_000,
        providerJobId: "req_fal_abc123",
        attemptNumber: 0,
      },
    });

    expect(result.success).toBe(true);
    const persisted = JSON.parse((result.data as { aiGeneration: string }).aiGeneration);
    expect(persisted).toMatchObject({
      provider: "fal-ai",
      model: "fal-ai/veo3.1/fast",
      providerJobId: "req_fal_abc123",
    });
    expect(persisted.costEstimate.amount).toBe(0.5);
  });

  it("leaves aiGeneration null when not provided (plain upload)", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("video") as never);
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/manual.mp4");

    const ctx = { pieceId: "test-piece-1" };
    const result = await uploadFile(ctx, {
      pieceId: "test-piece-1",
      filePath: "/Users/someone/manual.mp4",
      description: "user-uploaded",
    });

    expect(result.success).toBe(true);
    expect((result.data as { aiGeneration: unknown }).aiGeneration).toBeNull();
  });

  it("places the file in a folder when folderId is provided", async () => {
    const { createAssetFolder } = await import("@/lib/asset-folders/repo");
    const folder = createAssetFolder({ pieceId: "test-piece-1", name: "Extends" });

    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from("v") as never);
    vi.mocked(mockStorage.save).mockResolvedValue("test-piece-1/clip.mp4");

    const ctx = { pieceId: "test-piece-1" };
    const result = await uploadFile(ctx, {
      pieceId: "test-piece-1",
      filePath: "/tmp/clip.mp4",
      description: "in folder",
      folderId: folder.id,
    });

    expect(result.success).toBe(true);
    const row = testDb.select().from(files).where(eq(files.id, (result.data as { fileId: string }).fileId)).get();
    expect(row?.folderId).toBe(folder.id);
  });
});
