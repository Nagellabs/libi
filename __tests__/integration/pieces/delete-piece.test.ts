import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { deletePieceCompletely } from "@/lib/pieces/delete-piece";
import { getRenderDiagnostics, setRenderDiagnostics } from "@/lib/render/render-diagnostics-store";
import { navigationEmitter } from "@/lib/navigation-events";
import { createTemplate, getTemplateSummary } from "@/lib/templates/store";
import { makeScaffold } from "@/__tests__/helpers/templates";

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

  it("returns false for a missing piece", async () => {
    expect(await deletePieceCompletely("nope")).toBe(false);
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
