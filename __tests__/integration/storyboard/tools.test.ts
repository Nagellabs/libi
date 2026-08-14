// __tests__/integration/storyboard/tools.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard, loadCard } from "@/lib/storyboard/repo";
import { storyboardGet, approveStoryboardStage } from "@/mcp/tools/storyboard-tools";
import type { Storyboard } from "@/lib/storyboard/types";

afterEach(() => cleanupTempDir());

const sb: Storyboard = {
  version: 2, cardOrder: ["c1"], updatedAt: "2026-06-15T00:00:00.000Z",
  cards: [{
    id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas",
    title: "Hook",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" }, promptFragment: "x", stage: "schematic", approvals: {},
  }],
};

describe("storyboard_get tool", () => {
  it("returns the storyboard plus absolute card paths for direct editing", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    const res = await storyboardGet({ pieceId: "p1" }, { pieceId: "p1" });
    expect(res.success).toBe(true);
    const data = res.data as { storyboard: Storyboard; cardPaths: Record<string, { cardJson: string }> };
    expect(data.storyboard.cards[0].id).toBe("c1");
    expect(data.cardPaths.c1.cardJson).toContain("storyboard/cards/c1/card.json");
  });
});

describe("approveStoryboardStage ladder (keyframe is optional)", () => {
  const ladderSb = (): Storyboard => ({
    version: 2, cardOrder: ["c1"], updatedAt: "2026-06-15T00:00:00.000Z",
    cards: [{
      id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
      sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "canvas", file: "sketches/sk_1/unit.jsx" } }],
      camera: { shot: "medium" }, promptFragment: "x", stage: "schematic", approvals: {},
    }],
  });

  it("rejects keyframe approval before the schematic is approved", async () => {
    createTempStorageDir();
    await saveStoryboard("plad1", ladderSb());
    const res = await approveStoryboardStage({ pieceId: "plad1", cardId: "c1", stage: "keyframe" }, { pieceId: "plad1" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/schematic must be approved before keyframe/);
  });

  it("rejects clip approval before the schematic is approved", async () => {
    createTempStorageDir();
    await saveStoryboard("plad2", ladderSb());
    const res = await approveStoryboardStage({ pieceId: "plad2", cardId: "c1", stage: "clip" }, { pieceId: "plad2" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/schematic must be approved before clip/);
  });

  it("allows clip approval after ONLY the schematic is approved — no keyframe needed", async () => {
    createTempStorageDir();
    await saveStoryboard("plad3", ladderSb());
    const ok = await approveStoryboardStage({ pieceId: "plad3", cardId: "c1", stage: "schematic" }, { pieceId: "plad3" });
    expect(ok.success).toBe(true);
    // Jump straight to clip — the keyframe rung is optional now.
    const clip = await approveStoryboardStage({ pieceId: "plad3", cardId: "c1", stage: "clip" }, { pieceId: "plad3" });
    expect(clip.success).toBe(true);
    const card = await loadCard("plad3", "c1");
    expect(card?.approvals.clip).toBe(true);
    expect(card?.approvals.keyframe).toBeUndefined();
  });
});

it("storyboard_get includes a cost summary", async () => {
  // (uses the same createTempStorageDir + saveStoryboard setup as the file's other tests)
  const { saveStoryboard } = await import("@/lib/storyboard/repo");
  const { storyboardGet } = await import("@/mcp/tools/storyboard-tools");
  const { createTempStorageDir, cleanupTempDir } = await import("@/__tests__/helpers/test-storage");
  createTempStorageDir();
  try {
    await saveStoryboard("pcost", {
      version: 2, cardOrder: ["c1"], budgetUsd: 5, updatedAt: "t",
      cards: [{ id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "H",
        sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
        camera: { shot: "medium" },
        promptFragment: "x", stage: "keyframe", approvals: {}, cost: { keyframeUsd: 0.04 } }],
    });
    const res = await storyboardGet({ pieceId: "pcost" }, { pieceId: "pcost" });
    const costSummary = (res.data as { costSummary: { totalUsd: number; budgetUsd: number } }).costSummary;
    expect(costSummary.totalUsd).toBeCloseTo(0.04);
    expect(costSummary.budgetUsd).toBe(5);
  } finally {
    cleanupTempDir();
  }
});
