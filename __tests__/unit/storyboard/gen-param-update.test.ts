import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { addStoryboardCard, setCardGeneration, updateGenParam, clearCardReference, setCardReference, loadCard } from "@/lib/storyboard/repo";

let dir: string;
const PIECE = "piece_genparam";

beforeEach(async () => { dir = await createTempStorageDir(); });
afterEach(async () => { await cleanupTempDir(dir); });

async function seed() {
  const card = await addStoryboardCard(PIECE, { title: "S1" });
  await setCardGeneration(PIECE, card.id, "clip", { apiUrl: "https://fal.run/x", model: "veo", params: { duration: 5 } });
  return card.id;
}

describe("updateGenParam", () => {
  it("sets a new param value and stamps editedAt", async () => {
    const id = await seed();
    const card = await updateGenParam(PIECE, id, "clip", "aspect_ratio", "16:9");
    expect(card?.clipGen?.params.aspect_ratio).toBe("16:9");
    expect(card?.clipGen?.params.duration).toBe(5);
    expect(typeof card?.clipGen?.editedAt).toBe("number");
  });
  it("clears a param when value is null", async () => {
    const id = await seed();
    const card = await updateGenParam(PIECE, id, "clip", "duration", null);
    expect(card?.clipGen?.params.duration).toBeUndefined();
  });
  it("returns null when the tier spec is absent", async () => {
    const card = await addStoryboardCard("piece_nospec", { title: "S" });
    const out = await updateGenParam("piece_nospec", card.id, "keyframe", "start_frame", "f1");
    expect(out).toBeNull();
  });
  it("persists across reload", async () => {
    const id = await seed();
    await updateGenParam(PIECE, id, "clip", "seed", 42);
    const reloaded = await loadCard(PIECE, id);
    expect(reloaded?.clipGen?.params.seed).toBe(42);
  });
});

describe("clearCardReference", () => {
  it("removes a single inherited ref key", async () => {
    const id = await seed();
    await setCardReference(PIECE, id, "reference_video", { fromCardId: "other" });
    const card = await clearCardReference(PIECE, id, "reference_video");
    expect(card?.inheritedRefs?.reference_video).toBeUndefined();
  });
});
