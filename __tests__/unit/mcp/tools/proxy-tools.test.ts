/**
 * `regenerateProxy` runs from inside the MCP stdio child, so after Task 5
 * it enqueues `proxy_gen` via the HTTP jobs-client rather than reaching
 * into the in-process JobManager directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

vi.mock("@/lib/proxy/lifecycle", () => ({
  dropProxyFile: vi.fn(),
}));

const enqueueJobOnServer = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ status: "new", jobId: "job-1", clientKey: "ck-1" }),
);

vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: (...args: unknown[]) => enqueueJobOnServer(...args),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

import { regenerateProxy } from "@/mcp/tools/proxy-tools";
import { dropProxyFile } from "@/lib/proxy/lifecycle";

describe("regenerateProxy", () => {
  beforeEach(() => {
    testDb = createTestDb();
    seedPiece(testDb, { id: "p1" });
    enqueueJobOnServer.mockClear();
    vi.mocked(dropProxyFile).mockClear();

    testDb
      .insert(files)
      .values({
        id: "f1",
        pieceId: "p1",
        filename: "clip.mp4",
        name: "clip.mp4",
        description: "",
        type: "video",
        storagePath: "p1/clip.mp4",
        contentType: "video/mp4",
        size: 0,
      })
      .run();
  });

  it("drops the existing proxy and enqueues a fresh proxy_gen via HTTP", async () => {
    const result = await regenerateProxy({ fileId: "f1" });

    expect(result).toEqual({
      success: true,
      data: { fileId: "f1", status: "generating" },
    });
    expect(dropProxyFile).toHaveBeenCalledWith("f1", "user");
    expect(enqueueJobOnServer).toHaveBeenCalledWith(
      "proxy_gen",
      { fileId: "f1" },
      { pieceId: "p1", fileId: "f1", forceNew: true },
    );
  });

  it("returns an error and skips enqueue when the file is missing", async () => {
    const result = await regenerateProxy({ fileId: "missing" });

    expect(result.success).toBe(false);
    expect(enqueueJobOnServer).not.toHaveBeenCalled();
    expect(dropProxyFile).not.toHaveBeenCalled();
  });

  it("returns an error when the file is not a video", async () => {
    testDb
      .insert(files)
      .values({
        id: "f2",
        pieceId: "p1",
        filename: "photo.png",
        name: "photo.png",
        description: "",
        type: "image",
        storagePath: "p1/photo.png",
        contentType: "image/png",
        size: 0,
      })
      .run();

    const result = await regenerateProxy({ fileId: "f2" });

    expect(result.success).toBe(false);
    expect(enqueueJobOnServer).not.toHaveBeenCalled();
  });
});
