import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage } from "@/lib/storage";
import { addStoryboardCard, addSketch, removeSketch, reorderSketches, editSketch, loadCard } from "@/lib/storyboard/repo";

afterEach(() => cleanupTempDir());

describe("sketch slot mutators", () => {
  it("addSketch appends an end slot bound to its paramKey and scaffolds a unit", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    const res = await addSketch("p1", card.id, { role: "end", paramKey: "end_frame" });
    expect(res?.slot).toMatchObject({ id: "sk_2", role: "end", paramKey: "end_frame", render: { kind: "canvas", file: "sketches/sk_2/unit.jsx" } });
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches.map((s) => s.id)).toEqual(["sk_1", "sk_2"]);
    const storage = await getStorage();
    expect(await storage.exists("p1", `storyboard/cards/${card.id}/sketches/sk_2/unit.jsx`)).toBe(true);
  });

  it("addSketch carries an optional label (references)", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    const res = await addSketch("p1", card.id, { role: "reference", paramKey: "reference_image", label: "hand pose" });
    expect(res?.slot.label).toBe("hand pose");
  });

  it("removeSketch drops the slot and its unit dir", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await addSketch("p1", card.id, { role: "end", paramKey: "end_frame" });
    await removeSketch("p1", card.id, "sk_2");
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches.map((s) => s.id)).toEqual(["sk_1"]);
    const storage = await getStorage();
    expect(await storage.exists("p1", `storyboard/cards/${card.id}/sketches/sk_2/unit.jsx`)).toBe(false);
  });

  it("reorderSketches reorders by id", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await addSketch("p1", card.id, { role: "end", paramKey: "end_frame" });
    await addSketch("p1", card.id, { role: "reference", paramKey: "reference_image" });
    await reorderSketches("p1", card.id, ["sk_3", "sk_1", "sk_2"]);
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches.map((s) => s.id)).toEqual(["sk_3", "sk_1", "sk_2"]);
  });

  it("editSketch re-keys a slot's paramKey to the model's real param, keeping id/role/render", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    // default start slot is seeded with the placeholder `start_frame`
    expect((await loadCard("p1", card.id))?.sketches[0]).toMatchObject({ id: "sk_1", role: "start", paramKey: "start_frame" });
    const res = await editSketch("p1", card.id, "sk_1", { paramKey: "image_url" });
    expect(res?.slot).toMatchObject({ id: "sk_1", role: "start", paramKey: "image_url", render: { kind: "canvas", file: "sketches/sk_1/unit.jsx" } });
    const reloaded = await loadCard("p1", card.id);
    expect(reloaded?.sketches[0].paramKey).toBe("image_url");
  });

  it("editSketch can change role and label without touching paramKey", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await addSketch("p1", card.id, { role: "reference", paramKey: "ref_image", label: "old" });
    const res = await editSketch("p1", card.id, "sk_2", { label: "lacing detail" });
    expect(res?.slot).toMatchObject({ id: "sk_2", role: "reference", paramKey: "ref_image", label: "lacing detail" });
  });

  it("editSketch returns null on an unknown slot (loud-fail, no write)", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    expect(await editSketch("p1", card.id, "sk_99", { paramKey: "image_url" })).toBeNull();
    // unchanged
    expect((await loadCard("p1", card.id))?.sketches.map((s) => s.id)).toEqual(["sk_1"]);
  });

  it("editSketch sets and clears an imported sketch imageFileId", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    await editSketch("p1", card.id, "sk_1", { imageFileId: "file_abc" });
    expect((await loadCard("p1", card.id))?.sketches[0].imageFileId).toBe("file_abc");
    // clear with null
    await editSketch("p1", card.id, "sk_1", { imageFileId: null });
    expect((await loadCard("p1", card.id))?.sketches[0].imageFileId).toBeUndefined();
  });
});
