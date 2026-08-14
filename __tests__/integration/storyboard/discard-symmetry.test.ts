// __tests__/integration/storyboard/discard-symmetry.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { saveStoryboard, loadStoryboard } from "@/lib/storyboard/repo";
import { restoreStoryboardFromSnapshot } from "@/lib/storyboard/snapshot";
import type { Storyboard } from "@/lib/storyboard/types";

beforeEach(() => { createTempStorageDir(); resetStorage(); });
afterEach(() => cleanupTempDir());

const sb: Storyboard = {
  version: 2, cardOrder: ["c1"], updatedAt: "t",
  cards: [{ id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
    sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
    camera: { shot: "medium" },
    promptFragment: "x", stage: "schematic", approvals: {} }],
};

describe("discard symmetry", () => {
  it("clears the draft storyboard when there is no snapshot", async () => {
    await saveStoryboard("p1", sb);          // draft, never committed (no snapshot)
    await restoreStoryboardFromSnapshot("p1");
    expect(await loadStoryboard("p1")).toBeNull();
  });
});
