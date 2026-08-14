/**
 * Integration: HTTP mutation routes → navigationEmitter("refresh_query", …).
 *
 * Counterpart to refresh-query-pipeline.test.ts (which covers MCP tools).
 * Here we exercise the Next.js route handlers directly and assert that
 * each piece/file mutation emits a refresh_query event on the global
 * navigationEmitter — that's the in-process channel the SSE route
 * subscribes to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import {
  createTempStorageDir,
  cleanupTempDir,
} from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { files as filesTable } from "@/lib/db/schema/sqlite";
import {
  navigationEmitter,
  type RefreshQueryEvent,
} from "@/lib/navigation-events";

// In-memory DB
let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

// Temp storage
let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

// Stub proxy enqueue (rename path triggers this for videos; not the focus here).
vi.mock("@/lib/proxy/enqueue", () => ({
  enqueueProxyGen: vi.fn(),
}));
vi.mock("@/lib/proxy/lifecycle", () => ({
  dropProxyFile: vi.fn(),
}));

// Stub analysis cleanup for piece DELETE — fs-touching, irrelevant.
vi.mock("@/lib/analysis/cleanup", () => ({
  removeAnalysisForPiece: vi.fn(),
}));

// ffprobe stub (some routes funnel through storeFile → probeMedia).
vi.mock("child_process", () => ({
  // Variadic: probeMedia calls execFile(cmd, args, options, cb) — the
  // callback is always LAST.
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({ format: {}, streams: [] }),
      stderr: "",
    });
  },
}));

// Stub the MCP jobs-client (storeFile path enqueues proxy gen via HTTP).
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(() => Promise.resolve({ jobId: "j-1", resumed: false })),
  LibiServerUnavailableError: class LibiServerUnavailableError extends Error {},
}));

// Import routes AFTER mocks.
import { POST as createPiece } from "@/app/api/pieces/route";
import {
  PATCH as patchPiece,
  DELETE as deletePieceRoute,
} from "@/app/api/pieces/[pieceId]/route";
import { POST as globalUpload } from "@/app/api/upload/route";
import { POST as pieceUpload } from "@/app/api/pieces/[pieceId]/upload/route";
import { DELETE as deleteFileRoute } from "@/app/api/files/by-id/[fileId]/route";
import { PATCH as renameFile } from "@/app/api/files/by-id/[fileId]/rename/route";
import { POST as assignFileRoute } from "@/app/api/files/by-id/[fileId]/assign/route";

const PIECE_ID = "piece-http-1";
const OTHER_PIECE_ID = "piece-http-2";

function buildFormData(filename: string, contentType: string): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([0, 1, 2, 3])], filename, { type: contentType }));
  return fd;
}

describe("HTTP routes emit refresh_query", () => {
  let events: RefreshQueryEvent[];
  let listener: (e: RefreshQueryEvent) => void;

  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE_ID, name: "P" });
    seedPiece(testDb, { id: OTHER_PIECE_ID, name: "P2" });

    events = [];
    listener = (e) => events.push(e);
    navigationEmitter.on("refresh_query", listener);
  });

  afterEach(() => {
    navigationEmitter.off("refresh_query", listener);
    cleanupTempDir(tempDir);
  });

  it("POST /api/pieces emits 'pieces' + 'piece' with the new id", async () => {
    const res = await createPiece();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    expect(events).toEqual(
      expect.arrayContaining([
        { queryKey: "pieces" },
        { queryKey: "piece", pieceId: body.id },
      ]),
    );
  });

  it("PATCH /api/pieces/[pieceId] emits 'piece' + 'pieces'", async () => {
    const req = new Request("http://x/api/pieces/" + PIECE_ID, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    const res = await patchPiece(req, { params: Promise.resolve({ pieceId: PIECE_ID }) });
    expect(res.status).toBe(200);
    expect(events).toEqual(
      expect.arrayContaining([
        { queryKey: "piece", pieceId: PIECE_ID },
        { queryKey: "pieces" },
      ]),
    );
  });

  it("DELETE /api/pieces/[pieceId] emits 'pieces' + 'piece'", async () => {
    const req = new Request("http://x/api/pieces/" + PIECE_ID, { method: "DELETE" });
    const res = await deletePieceRoute(req, { params: Promise.resolve({ pieceId: PIECE_ID }) });
    expect(res.status).toBe(200);
    expect(events).toEqual(
      expect.arrayContaining([
        { queryKey: "pieces" },
        { queryKey: "piece", pieceId: PIECE_ID },
      ]),
    );
  });

  it("POST /api/upload emits 'files'", async () => {
    const fd = buildFormData("global.txt", "text/plain");
    const req = new Request("http://x/api/upload", { method: "POST", body: fd });
    const res = await globalUpload(req);
    expect(res.status).toBe(200);
    expect(events).toEqual([{ queryKey: "files" }]);
  });

  it("POST /api/pieces/[pieceId]/upload emits 'piece'", async () => {
    const fd = buildFormData("piece.txt", "text/plain");
    const req = new Request("http://x/api/pieces/" + PIECE_ID + "/upload", {
      method: "POST",
      body: fd,
    });
    const res = await pieceUpload(req, { params: Promise.resolve({ pieceId: PIECE_ID }) });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ queryKey: "piece", pieceId: PIECE_ID }]);
  });

  it("DELETE /api/files/by-id/[fileId] emits 'piece' for a piece-scoped file", async () => {
    // Seed a file row attached to PIECE_ID.
    testDb.insert(filesTable).values({
      id: "f-piece",
      pieceId: PIECE_ID,
      filename: "f.txt",
      name: "f",
      description: "",
      type: "document",
      storagePath: tempDir + "/missing.txt",
      contentType: "text/plain",
      size: 0,
    }).run();

    const req = new Request("http://x", { method: "DELETE" });
    const res = await deleteFileRoute(req, { params: Promise.resolve({ fileId: "f-piece" }) });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ queryKey: "piece", pieceId: PIECE_ID }]);
  });

  it("DELETE /api/files/by-id/[fileId] emits 'files' for a global file", async () => {
    testDb.insert(filesTable).values({
      id: "f-global",
      pieceId: null,
      filename: "g.txt",
      name: "g",
      description: "",
      type: "document",
      storagePath: tempDir + "/missing.txt",
      contentType: "text/plain",
      size: 0,
    }).run();

    const req = new Request("http://x", { method: "DELETE" });
    const res = await deleteFileRoute(req, { params: Promise.resolve({ fileId: "f-global" }) });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ queryKey: "files" }]);
  });

  it("PATCH /api/files/by-id/[fileId]/rename emits 'piece' for piece-scoped", async () => {
    testDb.insert(filesTable).values({
      id: "f-rn-piece",
      pieceId: PIECE_ID,
      filename: "r.txt",
      name: "r",
      description: "",
      type: "document",
      storagePath: tempDir + "/r.txt",
      contentType: "text/plain",
      size: 0,
    }).run();

    const req = new Request("http://x", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed File" }),
    });
    const res = await renameFile(req, { params: Promise.resolve({ fileId: "f-rn-piece" }) });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ queryKey: "piece", pieceId: PIECE_ID }]);
  });

  it("PATCH /api/files/by-id/[fileId]/rename emits 'files' for global", async () => {
    testDb.insert(filesTable).values({
      id: "f-rn-global",
      pieceId: null,
      filename: "r.txt",
      name: "r",
      description: "",
      type: "document",
      storagePath: tempDir + "/r.txt",
      contentType: "text/plain",
      size: 0,
    }).run();

    const req = new Request("http://x", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed Global" }),
    });
    const res = await renameFile(req, { params: Promise.resolve({ fileId: "f-rn-global" }) });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ queryKey: "files" }]);
  });

  it("POST /api/files/by-id/[fileId]/assign global → piece emits 'files' + 'piece' + 'asset-folders'", async () => {
    // Write the source file so storage.read succeeds.
    const fs = await import("fs/promises");
    const path = await import("path");
    const globalDir = path.join(tempDir, "_global");
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(path.join(globalDir, "mv.txt"), "x");

    testDb.insert(filesTable).values({
      id: "f-mv",
      pieceId: null,
      filename: "mv.txt",
      name: "mv",
      description: "",
      type: "document",
      storagePath: path.join(globalDir, "mv.txt"),
      contentType: "text/plain",
      size: 1,
    }).run();

    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ pieceId: PIECE_ID }),
    });
    const res = await assignFileRoute(req, { params: Promise.resolve({ fileId: "f-mv" }) });
    expect(res.status).toBe(200);

    // Old scope was global (no pieceId), new is PIECE_ID. assignFile also
    // emits files + asset-folders refreshes for the new scope (the file lands
    // at the destination scope's root with folderId cleared).
    expect(events).toEqual(
      expect.arrayContaining([
        { queryKey: "files" },
        { queryKey: "piece", pieceId: PIECE_ID },
        { queryKey: "files", pieceId: PIECE_ID },
        { queryKey: "asset-folders", pieceId: PIECE_ID },
      ]),
    );
    expect(events).toHaveLength(4);
  });

  it("POST /api/files/by-id/[fileId]/assign piece → other-piece emits both scopes", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const srcDir = path.join(tempDir, PIECE_ID);
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "mv2.txt"), "x");

    testDb.insert(filesTable).values({
      id: "f-mv2",
      pieceId: PIECE_ID,
      filename: "mv2.txt",
      name: "mv2",
      description: "",
      type: "document",
      storagePath: path.join(srcDir, "mv2.txt"),
      contentType: "text/plain",
      size: 1,
    }).run();

    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ pieceId: OTHER_PIECE_ID }),
    });
    const res = await assignFileRoute(req, { params: Promise.resolve({ fileId: "f-mv2" }) });
    expect(res.status).toBe(200);

    // assignFile also emits files + asset-folders refreshes for BOTH scopes —
    // the file leaves the old scope and lands at the new scope's root.
    expect(events).toEqual(
      expect.arrayContaining([
        { queryKey: "piece", pieceId: PIECE_ID },
        { queryKey: "piece", pieceId: OTHER_PIECE_ID },
        { queryKey: "files", pieceId: PIECE_ID },
        { queryKey: "asset-folders", pieceId: PIECE_ID },
        { queryKey: "files", pieceId: OTHER_PIECE_ID },
        { queryKey: "asset-folders", pieceId: OTHER_PIECE_ID },
      ]),
    );
    expect(events).toHaveLength(6);
  });
});
