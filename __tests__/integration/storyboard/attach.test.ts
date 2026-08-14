// __tests__/integration/storyboard/attach.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard, loadCard } from "@/lib/storyboard/repo";
import { attachStoryboardKeyframe, attachStoryboardClip } from "@/mcp/tools/storyboard-tools";
import type { Storyboard } from "@/lib/storyboard/types";

afterEach(() => cleanupTempDir());

const base: Storyboard = {
  version: 2, cardOrder: ["c1"], updatedAt: "t",
  cards: [{
    id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" },
    promptFragment: "x", stage: "schematic", approvals: {},
  }],
};

describe("attach keyframe/clip tools", () => {
  it("attaches a keyframe: sets fileId + cost, advances stage to keyframe", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", base);
    const res = await attachStoryboardKeyframe(
      { pieceId: "p1", cardId: "c1", fileId: "file-kf", costUsd: 0.04 }, { pieceId: "p1" });
    expect(res.success).toBe(true);
    const card = await loadCard("p1", "c1");
    expect(card?.keyframeFileId).toBe("file-kf");
    expect(card?.cost?.keyframeUsd).toBe(0.04);
    expect(card?.stage).toBe("keyframe");
  });

  it("attaches a clip: appends a versioned take with cost", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", base);
    const res = await attachStoryboardClip(
      { pieceId: "p1", cardId: "c1", fileId: "file-clip", costUsd: 0.18 }, { pieceId: "p1" });
    expect(res.success).toBe(true);
    // New shape: returns { cardId, take } instead of { cardId, stage }
    const data = res.data as { cardId: string; take: { fileId: string; label: string } };
    expect(data.cardId).toBe("c1");
    expect(data.take.fileId).toBe("file-clip");
    expect(data.take.label).toBe("v1");
    const card = await loadCard("p1", "c1");
    expect(card?.clips?.[0]?.fileId).toBe("file-clip");
    expect(card?.cost?.clipUsd).toBe(0.18);
    // Stage is NOT auto-advanced by appendClipTake (approval gating is separate)
    expect(card?.stage).toBe("schematic");
  });

  it("errors on unknown card", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", base);
    const res = await attachStoryboardKeyframe(
      { pieceId: "p1", cardId: "nope", fileId: "x" }, { pieceId: "p1" });
    expect(res.success).toBe(false);
  });
});
