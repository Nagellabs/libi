import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import { getRenderDiagnostics, setRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { navigationEmitter } from "@/lib/navigation-events";
import { createTemplate, getTemplateSummary } from "@/lib/templates/store";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { listEvictedProxies, recordEvictedProxy } from "@/lib/proxy/evicted";

describe("deletePieceCompletely", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("removes the piece row and returns true", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    const ok = await deletePieceCompletely("p1");
    expect(ok).toBe(true);
    expect(getDb().select().from(pieces).where(eq(pieces.id, "p1")).all()).toEqual([]);
  });

  it("drops the piece's in-memory render diagnostics", async () => {
    seedPiece(getDb() as never, { id: "p1" });
    setRenderDiagnostics("p1", [{ overlayId: "o1", kind: "code", phase: "render", message: "x", at: 1 }]);
    await deletePieceCompletely("p1");
    expect(getRenderDiagnostics("p1")).toEqual([]);
  });

  // agent-speed C1: a discarded draft is kept hidden inside the piece's storage — deleting the piece takes it too.
  it("deleting a piece removes its hidden recoverable drafts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-delete-piece-"));
    process.env.LIBI_HOME = home;
    try {
      seedPiece(getDb() as never, { id: "p1" });
      const { saveManifest } = await import("@/lib/composition/persistence");
      const { discardDraft } = await import("@/lib/composition/lifecycle");
      const { listRecoverableDrafts } = await import("@/lib/composition/recoverable");
      const { getLibiStorageDir } = await import("@/lib/libi-home");
      await saveManifest("p1", { width: 1920, height: 1080, fps: 30, overlays: [] });
      const kept = await discardDraft("p1");
      expect(kept).not.toBeNull();
      const dir = path.join(getLibiStorageDir(), "p1");
      expect(fs.existsSync(path.join(dir, "snapshots", "recoverable", `${kept!.id}.json`))).toBe(true);
      await deletePieceCompletely("p1");
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(path.join(dir, "snapshots", "recoverable"))).toBe(false);
      // No piece, no list: the store reads empty rather than resurrecting the entry.
      expect(await listRecoverableDrafts("p1")).toEqual([]);
    } finally {
      delete process.env.LIBI_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns false for a missing piece", async () => {
    expect(await deletePieceCompletely("nope")).toBe(false);
  });

  // FINAL m-B3: eviction records were only pruned lazily, by the next LRU pass.
  it("deleting a piece forgets its files' eviction records", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-delete-piece-"));
    process.env.LIBI_HOME = home;
    try {
      const db = getDb();
      seedPiece(db as never, { id: "p1" });
      seedPiece(db as never, { id: "p2" });
      const video = (id: string, pieceId: string) => ({
        id, pieceId, filename: `${id}.mp4`, name: id, description: "", type: "video" as const,
        storagePath: `${pieceId}/${id}.mp4`, contentType: "video/mp4", size: 4,
      });
      db.insert(files).values([video("f1", "p1"), video("f2", "p1"), video("other", "p2")]).run();
      recordEvictedProxy("f1", 10);
      recordEvictedProxy("f2", 20);
      recordEvictedProxy("other", 30);
      await deletePieceCompletely("p1");
      expect(Object.keys(listEvictedProxies())).toEqual(["other"]);
    } finally {
      delete process.env.LIBI_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // D2–D4 review M3: a template's card offers "Render preview" only while its
  // source piece exists — deleting that piece must re-read the Templates page.
  it("re-reads the Templates page when the deleted piece was a template's source — and only then", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-delete-piece-"));
    process.env.LIBI_HOME = home;
    try {
      seedPiece(getDb() as never, { id: "src" });
      seedPiece(getDb() as never, { id: "other" });
      const t = await createTemplate({
        name: "Hook", description: "", tags: [], scaffold: makeScaffold() as never, instructions: "# x\n", copies: [], writes: [], createdFromPieceId: "src",
      });
      const emit = vi.spyOn(navigationEmitter, "emit");
      await deletePieceCompletely("other");
      expect(emit).not.toHaveBeenCalledWith("refresh_query", { queryKey: "templates" });
      await deletePieceCompletely("src");
      expect(emit).toHaveBeenCalledWith("refresh_query", { queryKey: "templates" });
      expect(await getTemplateSummary(t.id)).toMatchObject({ canRenderExample: false, sourcePieceName: null });
      emit.mockRestore();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
