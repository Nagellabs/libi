import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { updateFileNotes } from "@/mcp/tools/file-tools";
import { files } from "@/lib/db/schema";

describe("updateFileNotes", () => {
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

  afterEach(() => resetTestDb());

  it("appends a timestamped line by default", async () => {
    const r1 = await updateFileNotes({ fileId: "f1", notes: "first" });
    expect(r1.success).toBe(true);
    expect((r1 as { success: true; data: { notes: string } }).data.notes).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*Z \| first\n$/,
    );

    const r2 = await updateFileNotes({ fileId: "f1", notes: "second" });
    const notes2 = (r2 as { success: true; data: { notes: string } }).data.notes;
    expect(notes2).toMatch(/first\n/);
    expect(notes2).toMatch(/\| second\n$/);
  });

  it("replaces when mode=replace", async () => {
    await updateFileNotes({ fileId: "f1", notes: "first" });
    const r = await updateFileNotes({
      fileId: "f1",
      notes: "fresh",
      mode: "replace",
    });
    expect((r as { success: true; data: { notes: string } }).data.notes).toBe("fresh");
  });

  it("returns error when fileId not found", async () => {
    const r = await updateFileNotes({ fileId: "missing", notes: "x" });
    expect(r.success).toBe(false);
    expect((r as { success: false; error: string }).error).toMatch(/not found/i);
  });
});
