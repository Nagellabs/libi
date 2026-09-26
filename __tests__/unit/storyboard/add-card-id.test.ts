// An agent may name its own storyboard card (`s1-hook`), and that id becomes the card's folder
// (`storyboard/cards/<id>/`). The sketch route refuses any id outside `isSafeStoryboardId`, so
// addStoryboardCard holds a supplied id to the same shape — one helper for both — and the
// add_storyboard_card tool turns a refusal into a plain error that says what an id may contain.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { addStoryboardCard, loadStoryboard } from "@/lib/storyboard/repo";
import { addStoryboardCard as addCardTool } from "@/mcp/tools/storyboard-tools";
import { isSafeStoryboardId } from "@/lib/security/pieceId";

const pieceId = "piece_card_ids";

describe("addStoryboardCard — the card id", () => {
  beforeEach(() => {
    createTempStorageDir();
    resetStorage();
  });
  afterEach(() => {
    cleanupTempDir();
    resetStorage();
  });

  it.each(["../escape", "a/b", "..", ".hidden", "trailing.", "a..b", "100%", "c:1", "has space", "a\\b"])(
    "refuses %j and writes nothing",
    async (id) => {
      expect(isSafeStoryboardId(id)).toBe(false);
      await expect(addStoryboardCard(pieceId, { id, title: "x" })).rejects.toThrow(/invalid card id/);
      expect(await loadStoryboard(pieceId)).toBeNull();
      // Not even the default render unit: the refusal comes before any write.
      expect(fs.existsSync(path.join(getLibiStorageDir(), pieceId))).toBe(false);
    },
  );

  it.each(["s1-hook", "card_3", "v1.2", "S1"])("accepts %j", async (id) => {
    const card = await addStoryboardCard(pieceId, { id, title: "x" });
    expect(card.id).toBe(id);
    expect((await loadStoryboard(pieceId))!.cardOrder).toEqual([id]);
  });

  it("trims the id before judging it, and still generates one when it is omitted or blank", async () => {
    expect((await addStoryboardCard(pieceId, { id: "  s1-hook ", title: "a" })).id).toBe("s1-hook");
    expect((await addStoryboardCard(pieceId, { id: "   ", title: "b" })).id).toBe("card_2");
    expect((await addStoryboardCard(pieceId, { title: "c" })).id).toBe("card_3");
  });

  it("the add_storyboard_card tool returns the refusal as a clear error, not a throw", async () => {
    const result = await addCardTool({ pieceId, card: { id: "../s1", title: "x" } }, { pieceId });
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid card id "../s1"');
    expect(result.error).toContain('e.g. "s1-hook"');
    expect(await loadStoryboard(pieceId)).toBeNull();
  });
});
