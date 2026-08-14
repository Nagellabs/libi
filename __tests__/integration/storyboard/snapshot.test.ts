// __tests__/integration/storyboard/snapshot.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard, loadStoryboard } from "@/lib/storyboard/repo";
import { saveStoryboardSnapshot, loadStoryboardSnapshot } from "@/lib/storyboard/snapshot";
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

describe("storyboard snapshot", () => {
  it("captures the current storyboard and restores it", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    await saveStoryboardSnapshot("p1");                 // capture committed state
    await saveStoryboard("p1", { ...sb, cardOrder: [], cards: [] }); // draft edit
    const snap = await loadStoryboardSnapshot("p1");
    expect(snap?.cards).toHaveLength(1);                // snapshot still has c1
    const draft = await loadStoryboard("p1");
    expect(draft?.cards).toHaveLength(0);               // draft diverged
  });
});
