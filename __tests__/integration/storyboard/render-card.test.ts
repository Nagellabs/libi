import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage, resetStorage } from "@/lib/storage";
import { saveStoryboard } from "@/lib/storyboard/repo";
import { renderCardSketches, renderCardSketch } from "@/lib/storyboard/render-card";
import { slotSketchPath, cardDir } from "@/lib/storyboard/paths";
import type { SketchSlot, Storyboard, StoryboardCard } from "@/lib/storyboard/types";

afterEach(() => { cleanupTempDir(); resetStorage(); });

const sb: Storyboard = {
  version: 2, cardOrder: ["c1"], updatedAt: "2026-06-15T00:00:00.000Z",
  cards: [{
    id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas",
    title: "Hook",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" }, promptFragment: "x", stage: "schematic", approvals: {},
  }],
};

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

describe("renderCardSketches", () => {
  it("renders a card's slot unit file to sketches/<slotId>.png at the deterministic path", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    const storage = await getStorage();
    await storage.save("p1", `${cardDir("c1")}/sketches/sk_1/unit.jsx`,
      Buffer.from('return h("div", { style: { width: "100%", height: "100%", display: "flex", background: "#fff" } }, "x");'));
    await renderCardSketches("p1", sb.cards[0]);
    const outPath = slotSketchPath("c1", "sk_1");
    const png = await storage.read("p1", outPath);
    expect(isPng(png)).toBe(true);
  });

  it("returns without error when the card's slot has no render unit file on disk", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    await expect(renderCardSketches("p1", sb.cards[0])).resolves.toBeUndefined();
  });
});

it("renders each slot to sketches/<slotId>.png", async () => {
  createTempStorageDir();
  const storage = await getStorage();
  await storage.save("p1", "storyboard/cards/c1/sketches/sk_1/unit.jsx",
    Buffer.from('return h("div", { style: { width: "100%", height: "100%", display: "flex", background: "#fff" } }, "x");'),
    "text/plain");
  const card: StoryboardCard = {
    id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
  };
  await renderCardSketches("p1", card);
  expect(await storage.exists("p1", "storyboard/cards/c1/sketches/sk_1.png")).toBe(true);
});

describe("renderCardSketch return contract", () => {
  it("returns the deterministic slotSketchPath on success and writes a PNG", async () => {
    createTempStorageDir();
    const storage = await getStorage();
    await storage.save("p1", "storyboard/cards/c1/sketches/sk_1/unit.jsx",
      Buffer.from('return h("div", { style: { width: "100%", height: "100%", display: "flex", background: "#fff" } }, "x");'),
      "text/plain");
    const card: StoryboardCard = {
      id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
      camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    };
    const slot = card.sketches[0];
    const result = await renderCardSketch("p1", card, slot);
    expect(result).toBe(slotSketchPath("c1", "sk_1"));
    expect(await storage.exists("p1", slotSketchPath("c1", "sk_1"))).toBe(true);
  });

  it("returns null when the slot has no render field", async () => {
    createTempStorageDir();
    const card: StoryboardCard = {
      id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
      sketches: [],
      camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    };
    const slotNoRender: SketchSlot = { id: "sk_x", role: "reference", paramKey: "reference_image" };
    const result = await renderCardSketch("p1", card, slotNoRender);
    expect(result).toBeNull();
  });

  it("returns null when the slot has a render but the unit file does not exist on disk", async () => {
    createTempStorageDir();
    // No unit file written — storage dir exists but file is absent
    const card: StoryboardCard = {
      id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
      camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
    };
    const slot = card.sketches[0];
    const result = await renderCardSketch("p1", card, slot);
    expect(result).toBeNull();
  });
});
