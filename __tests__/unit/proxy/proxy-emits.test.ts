/**
 * Unit: dropProxyFile refresh_query emit shape
 *
 * Verifies that dropProxyFile emits the correct `refresh_query` event
 * shape depending on whether the file is piece-scoped (`{ queryKey:
 * "piece", pieceId }`) or global (`{ queryKey: "files" }`). The client
 * dispatcher bails on `{ queryKey: "piece", pieceId: null }`, so the
 * global path MUST use the `"files"` queryKey to invalidate the global
 * files React Query.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb, seedPiece } from "../../helpers/test-db";

// Mock the DB client and libi-home BEFORE importing modules that use them.
let storageBaseDir: string;

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getLibiStorageDir: () => storageBaseDir,
  };
});

import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { navigationEmitter } from "@/lib/navigation-events";
import { dropProxyFile } from "@/lib/proxy/lifecycle";

describe("dropProxyFile — refresh_query emit shape", () => {
  let tmp: string;
  let listener: (event: { queryKey: string; pieceId?: string }) => void;
  let seen: Array<{ queryKey: string; pieceId?: string }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-proxy-emit-test-"));
    storageBaseDir = path.join(tmp, "storage");
    fs.mkdirSync(storageBaseDir, { recursive: true });
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);

    seen = [];
    listener = (event) => seen.push(event);
    navigationEmitter.on("refresh_query", listener);
  });

  afterEach(() => {
    navigationEmitter.off("refresh_query", listener);
    vi.resetModules();
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeProxyRow(opts: {
    fileId: string;
    pieceId: string | null;
  }): void {
    const { fileId, pieceId } = opts;
    const scopeDir = pieceId ?? "_global";
    const dir = path.join(storageBaseDir, scopeDir);
    fs.mkdirSync(dir, { recursive: true });
    const proxyName = `${fileId}-proxy.mp4`;
    fs.writeFileSync(path.join(dir, proxyName), Buffer.alloc(8));

    const db = vi.mocked(getDb)();
    if (pieceId) {
      try {
        seedPiece(db as never, { id: pieceId, name: pieceId });
      } catch {
        /* piece may already exist */
      }
    }
    db.insert(files)
      .values({
        id: fileId,
        pieceId,
        filename: `${fileId}.mp4`,
        name: fileId,
        description: "",
        storagePath: `${scopeDir}/${fileId}.mp4`,
        type: "video",
        contentType: "video/mp4",
        size: 1024,
        proxyFilename: proxyName,
        proxyStatus: "ready",
        proxyGeneratedAt: new Date(),
      })
      .run();
  }

  it("emits queryKey=files (no pieceId) when the file is global", () => {
    makeProxyRow({ fileId: "global-file-1", pieceId: null });

    dropProxyFile("global-file-1", "user");

    expect(seen).toContainEqual({ queryKey: "files" });
    // MUST NOT emit the malformed piece+null shape that the client bails on.
    expect(seen).not.toContainEqual(
      expect.objectContaining({ queryKey: "piece", pieceId: null }),
    );
  });

  it("emits queryKey=piece with pieceId when the file is piece-scoped", () => {
    makeProxyRow({ fileId: "scoped-file-1", pieceId: "piece-abc" });

    dropProxyFile("scoped-file-1", "user");

    expect(seen).toContainEqual({
      queryKey: "piece",
      pieceId: "piece-abc",
    });
    expect(seen).not.toContainEqual(
      expect.objectContaining({ queryKey: "files" }),
    );
  });
});
