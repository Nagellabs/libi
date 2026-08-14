import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { files } from "@/lib/db/schema";
import { PATCH } from "@/app/api/files/by-id/[fileId]/notes/route";

describe("PATCH /api/files/by-id/[fileId]/notes", () => {
  beforeEach(() => {
    const db = createTestDb();
    db
      .insert(files)
      .values({
        id: "f1",
        pieceId: null,
        filename: "x.mp4",
        name: "x.mp4",
        description: "",
        type: "video",
        storagePath: "/tmp/x.mp4",
      })
      .run();
  });

  afterEach(() => {
    resetTestDb();
  });

  it("appends a notes line", async () => {
    const req = new Request("http://t/api/files/by-id/f1/notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "hello" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ fileId: "f1" }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; file: { notes: string } };
    expect(j.success).toBe(true);
    expect(j.file.notes).toMatch(/\| hello\n$/);
  });

  it("returns 404 for unknown file", async () => {
    const req = new Request("http://t/api/files/by-id/missing/notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: "x" }),
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ fileId: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s when notes is missing", async () => {
    const req = new Request("http://t/api/files/by-id/f1/notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, { params: Promise.resolve({ fileId: "f1" }) });
    expect(res.status).toBe(400);
  });
});
