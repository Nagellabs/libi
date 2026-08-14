import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage } from "@/lib/storage";
import { addStoryboardCard, loadCard } from "@/lib/storyboard/repo";
import { cardJsonPath } from "@/lib/storyboard/paths";

afterEach(() => cleanupTempDir());

describe("sketch slots — load + bootstrap", () => {
  it("addStoryboardCard seeds a single start slot bound to start_frame", async () => {
    createTempStorageDir();
    const card = await addStoryboardCard("p1", { title: "Hook" });
    expect(card.sketches).toEqual([
      { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "canvas", file: "sketches/sk_1/unit.jsx" } },
    ]);
    const storage = await getStorage();
    expect(await storage.exists("p1", "storyboard/cards/" + card.id + "/sketches/sk_1/unit.jsx")).toBe(true);
  });

  it("normalizes a legacy on-disk card (render + schematicFileId) on read", async () => {
    createTempStorageDir();
    const storage = await getStorage();
    await storage.save("p1", "storyboard/manifest.json", Buffer.from(JSON.stringify({
      version: 2, cardOrder: ["c1"], updatedAt: "t",
    })), "application/json");
    await storage.save("p1", cardJsonPath("c1"), Buffer.from(JSON.stringify({
      id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
      render: { kind: "satori", file: "render.jsx" }, schematicFileId: "file_sch",
      camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    })), "application/json");

    const card = await loadCard("p1", "c1");
    expect(card?.sketches).toEqual([
      { id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "render.jsx" } },
    ]);
    expect((card as unknown as Record<string, unknown>).render).toBeUndefined();
  });
});
