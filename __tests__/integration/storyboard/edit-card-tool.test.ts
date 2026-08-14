import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { addStoryboardCard, loadCard } from "@/lib/storyboard/repo";
import { editStoryboardCard, storyboardGet } from "@/mcp/tools/storyboard-tools";

afterEach(() => cleanupTempDir());

describe("edit_storyboard_card tool", () => {
  it("adds an end sketch slot and returns its unit path", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    const res = await editStoryboardCard(
      { pieceId: "p1", cardId: card.id, addSketch: { role: "end", paramKey: "end_frame" } },
      { pieceId: "p1" },
    );
    expect(res.success).toBe(true);
    const data = (res as { data: { sketch?: { slotId: string; unit: string } } }).data;
    expect(data.sketch?.slotId).toBe("sk_2");
    expect(data.sketch?.unit).toContain("sketches/sk_2/unit.jsx");
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches.map((s) => s.id)).toEqual(["sk_1", "sk_2"]);
  });

  it("removes a sketch slot", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await editStoryboardCard({ pieceId: "p1", cardId: card.id, addSketch: { role: "end", paramKey: "end_frame" } }, { pieceId: "p1" });
    const res = await editStoryboardCard({ pieceId: "p1", cardId: card.id, removeSketch: { slotId: "sk_2" } }, { pieceId: "p1" });
    expect(res.success).toBe(true);
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches.map((s) => s.id)).toEqual(["sk_1"]);
  });

  it("edits scalar fields (title, promptFragment)", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await editStoryboardCard({ pieceId: "p1", cardId: card.id, fields: { title: "New", promptFragment: "pf" } }, { pieceId: "p1" });
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.title).toBe("New");
    expect(reloaded?.promptFragment).toBe("pf");
  });

  it("edits the role field", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await editStoryboardCard({ pieceId: "p1", cardId: card.id, fields: { title: "New", promptFragment: "pf", role: "b-roll" } }, { pieceId: "p1" });
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.title).toBe("New");
    expect(reloaded?.promptFragment).toBe("pf");
    expect(reloaded?.role).toBe("b-roll");
  });

  it("re-keys a sketch slot's paramKey to the model's real param (editSketch)", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    const res = await editStoryboardCard(
      { pieceId: "p1", cardId: card.id, editSketch: { slotId: "sk_1", paramKey: "image_url" } },
      { pieceId: "p1" },
    );
    expect(res.success).toBe(true);
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches[0]).toMatchObject({ id: "sk_1", role: "start", paramKey: "image_url" });
  });

  it("loud-fails editSketch on an unknown slot", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    const res = await editStoryboardCard(
      { pieceId: "p1", cardId: card.id, editSketch: { slotId: "sk_99", paramKey: "image_url" } },
      { pieceId: "p1" },
    );
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toContain("sk_99");
  });

  it("errors on a missing card", async () => {
    createTempStorageDir();
    const res = await editStoryboardCard({ pieceId: "p1", cardId: "nope", fields: { title: "x" } }, { pieceId: "p1" });
    expect(res.success).toBe(false);
  });

  it("storyboard_get returns per-slot unit + sketch paths", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    const res = await storyboardGet({ pieceId: "p1" }, { pieceId: "p1" });
    const data = (res as unknown as { data: { cardPaths: Record<string, { sketches: { slotId: string; unit: string; sketch: string }[] }> } }).data;
    const slot = data.cardPaths[card.id].sketches[0];
    expect(slot.slotId).toBe("sk_1");
    expect(slot.unit).toContain("sketches/sk_1/unit.jsx");
    expect(slot.sketch).toContain("sketches/sk_1.png");
  });
});
