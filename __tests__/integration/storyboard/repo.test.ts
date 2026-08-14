// __tests__/integration/storyboard/repo.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard, loadStoryboard, getCardAbsolutePaths, addStoryboardCard } from "@/lib/storyboard/repo";
import { getStorage } from "@/lib/storage";
import { cardRenderPath } from "@/lib/storyboard/paths";
import type { Storyboard } from "@/lib/storyboard/types";

const sample: Storyboard = {
  version: 2,
  cardOrder: ["c1"],
  updatedAt: "2026-06-15T00:00:00.000Z",
  cards: [
    {
      id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas",
      title: "Hook",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "render.jsx" } }],
      camera: { shot: "medium" }, promptFragment: "x",
      stage: "schematic", approvals: {},
    },
  ],
};

afterEach(() => cleanupTempDir());

describe("storyboard repo", () => {
  it("round-trips a storyboard through files", async () => {
    createTempStorageDir();
    await saveStoryboard("piece1", sample);
    const loaded = await loadStoryboard("piece1");
    expect(loaded?.cardOrder).toEqual(["c1"]);
    expect(loaded?.cards[0].title).toBe("Hook");
  });

  it("returns null for a piece with no storyboard", async () => {
    createTempStorageDir();
    expect(await loadStoryboard("nope")).toBeNull();
  });

  it("exposes absolute card paths for direct agent editing", async () => {
    createTempStorageDir();
    await saveStoryboard("piece1", sample);
    const paths = await getCardAbsolutePaths("piece1", "c1");
    expect(paths.cardJson.endsWith("storyboard/cards/c1/card.json")).toBe(true);
    // The card's start slot render file is at render.jsx (legacy path preserved in the fixture)
    expect(paths.sketches[0].unit.endsWith("storyboard/cards/c1/render.jsx")).toBe(true);
  });

  it("bootstraps a storyboard from scratch via addStoryboardCard", async () => {
    createTempStorageDir();
    // Fresh piece: no storyboard yet.
    expect(await loadStoryboard("fresh")).toBeNull();

    const card = await addStoryboardCard(
      "fresh",
      { title: "Wave hello", role: "hook", camera: { shot: "close" }, blocks: [
        { id: "s", kind: "subject", label: "Creator", rect: { x: 0.3, y: 0.2, w: 0.4, h: 0.6 }, z: 1 },
      ] },
      { overview: "A short intro", budgetUsd: 5 },
    );

    // Manifest initialized + card persisted with sensible defaults.
    const sb = await loadStoryboard("fresh");
    expect(sb).not.toBeNull();
    expect(sb!.overview).toBe("A short intro");
    expect(sb!.budgetUsd).toBe(5);
    expect(sb!.cardOrder).toEqual([card.id]);
    expect(card.stage).toBe("schematic");
    expect(card.kind).toBe("ai-video"); // default
    expect(card.durationSec).toBe(5); // default
    // addStoryboardCard seeds a start slot with the new per-slot unit path
    expect(card.sketches[0].render).toEqual({ kind: "canvas", file: "sketches/sk_1/unit.jsx" });

    // A default rough-canvas sketch unit was written (so a schematic can render).
    const storage = await getStorage();
    expect(await storage.exists("fresh", cardRenderPath(card.id, "sketches/sk_1/unit.jsx"))).toBe(true);
    const unit = (await storage.read("fresh", cardRenderPath(card.id, "sketches/sk_1/unit.jsx"))).toString("utf8");
    expect(unit).toContain("= context"); // reads injected context
    expect(unit).toContain("rough.line"); // rough-canvas default (horizon line)
    expect(unit).toContain("fillRect"); // paper background fill
  });

  it("appends cards with incrementing order and rejects duplicate ids", async () => {
    createTempStorageDir();
    const a = await addStoryboardCard("p", { id: "a", title: "A" });
    const b = await addStoryboardCard("p", { id: "b", title: "B" });
    expect(a.order).toBe(0);
    expect(b.order).toBe(1);
    expect((await loadStoryboard("p"))!.cardOrder).toEqual(["a", "b"]);
    await expect(addStoryboardCard("p", { id: "a", title: "dup" })).rejects.toThrow(/already exists/);
  });

  it("removes orphaned card dirs on save", async () => {
    createTempStorageDir();
    await saveStoryboard("piece1", sample);
    const withoutC1: Storyboard = { ...sample, cardOrder: [], cards: [] };
    await saveStoryboard("piece1", withoutC1);
    const loaded = await loadStoryboard("piece1");
    expect(loaded?.cards).toEqual([]);
  });
});
