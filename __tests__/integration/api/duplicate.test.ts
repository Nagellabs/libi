import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/jobs/manager", () => ({
  getJobManager: () => ({
    enqueue: async () => ({ status: "new", jobId: "j" + Math.random(), clientKey: "k" }),
    // drivePieceDupJob calls runToCompletion in the background — stub it so the
    // route doesn't actually run the clone in a unit test.
    runToCompletion: async () => undefined,
  }),
}));
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { POST as duplicatePiece } from "@/app/api/pieces/[pieceId]/duplicate/route";
import { POST as duplicateFolder } from "@/app/api/folders/[folderId]/duplicate/route";
import { createFolder, setPieceFolder } from "@/lib/folders/repo";

describe("duplicate routes", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("POST /api/pieces/[id]/duplicate creates a shell + returns jobId", async () => {
    seedPiece(getDb() as never, { id: "src", name: "My Piece" });
    const res = await duplicatePiece(
      new Request("http://x", { method: "POST", body: JSON.stringify({}) }),
      { params: Promise.resolve({ pieceId: "src" }) },
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.name).toBe("My Piece (copy)");
    expect(body.jobId).toBeTruthy();
    expect(getDb().select().from(pieces).all()).toHaveLength(2);
  });

  it("POST /api/pieces/[id]/duplicate 404 for a missing piece", async () => {
    const res = await duplicatePiece(
      new Request("http://x", { method: "POST", body: JSON.stringify({}) }),
      { params: Promise.resolve({ pieceId: "nope" }) },
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/folders/[id]/duplicate clones the folder + enqueues per piece", async () => {
    const f = createFolder({ name: "Camp" });
    seedPiece(getDb() as never, { id: "p1", name: "P1" });
    setPieceFolder("p1", f.id);
    const res = await duplicateFolder(
      new Request("http://x", { method: "POST", body: JSON.stringify({}) }),
      { params: Promise.resolve({ folderId: f.id }) },
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.pieceCount).toBe(1);
    expect(body.jobIds).toHaveLength(1);
  });
});
