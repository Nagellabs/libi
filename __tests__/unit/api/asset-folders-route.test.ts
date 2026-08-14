import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";

// ---------------------------------------------------------------------------
// Mocks — must come before route-handler imports
// ---------------------------------------------------------------------------

let testDb: ReturnType<typeof createTestDb>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => testDb,
}));

vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import handlers AFTER mocks are wired
// ---------------------------------------------------------------------------

import { POST, GET as GET_GLOBAL } from "@/app/api/asset-folders/route";
import { GET as GET_LEVEL } from "@/app/api/pieces/[pieceId]/asset-folders/route";
import { PATCH as PATCH_FOLDER, DELETE as DELETE_FOLDER } from "@/app/api/asset-folders/[folderId]/route";

beforeEach(() => {
  testDb = createTestDb();
  seedPiece(testDb);
});

describe("asset-folders routes", () => {
  it("POST creates a folder; GET level lists it", async () => {
    const post = await POST(
      new Request("http://x/api/asset-folders", {
        method: "POST",
        body: JSON.stringify({ pieceId: "test-piece-1", name: "Extends" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(post.status).toBe(200);

    const res = await GET_LEVEL(
      new Request("http://x/api/pieces/test-piece-1/asset-folders"),
      { params: Promise.resolve({ pieceId: "test-piece-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.folders.map((f: { name: string }) => f.name)).toContain("Extends");
  });

  it("GET global lists root-level global folders", async () => {
    const post = await POST(
      new Request("http://x/api/asset-folders", {
        method: "POST",
        body: JSON.stringify({ pieceId: null, name: "GlobalFolder" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(post.status).toBe(200);

    const res = await GET_GLOBAL(new Request("http://x/api/asset-folders"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.folders.map((f: { name: string }) => f.name)).toContain("GlobalFolder");
  });

  it("PATCH renames a folder", async () => {
    const post = await POST(
      new Request("http://x/api/asset-folders", {
        method: "POST",
        body: JSON.stringify({ pieceId: "test-piece-1", name: "Before" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const created = await post.json();
    const folderId = created.folder.id;

    const patch = await PATCH_FOLDER(
      new Request(`http://x/api/asset-folders/${folderId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "After" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ folderId }) },
    );
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.folder.name).toBe("After");
  });

  it("DELETE removes a folder (orphan mode)", async () => {
    const post = await POST(
      new Request("http://x/api/asset-folders", {
        method: "POST",
        body: JSON.stringify({ pieceId: "test-piece-1", name: "Doomed" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const created = await post.json();
    const folderId = created.folder.id;

    const del = await DELETE_FOLDER(
      new Request(`http://x/api/asset-folders/${folderId}?mode=orphan`, { method: "DELETE" }),
      { params: Promise.resolve({ folderId }) },
    );
    expect(del.status).toBe(200);
    const delJson = await del.json();
    expect(delJson.deletedFolderId).toBe(folderId);

    const res = await GET_LEVEL(
      new Request("http://x/api/pieces/test-piece-1/asset-folders"),
      { params: Promise.resolve({ pieceId: "test-piece-1" }) },
    );
    const json = await res.json();
    expect(json.folders.map((f: { name: string }) => f.name)).not.toContain("Doomed");
  });
});
