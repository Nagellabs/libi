import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { PATCH } from "@/app/api/pieces/[pieceId]/route";
import { createFolder } from "@/lib/folders/repo";

describe("PATCH /api/pieces/[pieceId] folderId", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("moves a piece into a folder and back to root", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    const folder = createFolder({ name: "F" });

    let res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ folderId: folder.id }) }),
      { params: Promise.resolve({ pieceId: "p1" }) },
    );
    expect((await res.json()).folderId).toBe(folder.id);

    res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ folderId: null }) }),
      { params: Promise.resolve({ pieceId: "p1" }) },
    );
    expect((await res.json()).folderId).toBeNull();
  });

  it("rejects moving a piece into a non-existent folder with 404", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    const res = await PATCH(
      new Request("http://x", {
        method: "PATCH",
        body: JSON.stringify({ folderId: "does-not-exist" }),
      }),
      { params: Promise.resolve({ pieceId: "p1" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("folder_not_found");
  });
});
