// __tests__/integration/storyboard/draft-divergence.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { saveStoryboard } from "@/lib/storyboard/repo";
import { saveStoryboardSnapshot, storyboardMatchesSnapshot } from "@/lib/storyboard/snapshot";
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

describe("storyboardMatchesSnapshot", () => {
  it("true right after snapshot (ignoring updatedAt)", async () => {
    await saveStoryboard("p1", sb);
    await saveStoryboardSnapshot("p1");
    await saveStoryboard("p1", sb); // rewrite → new updatedAt only
    expect(await storyboardMatchesSnapshot("p1")).toBe(true);
  });
  it("false after a real content edit", async () => {
    await saveStoryboard("p1", sb);
    await saveStoryboardSnapshot("p1");
    await saveStoryboard("p1", { ...sb, cards: [{ ...sb.cards[0], title: "Changed" }] });
    expect(await storyboardMatchesSnapshot("p1")).toBe(false);
  });
  it("false when there is no snapshot", async () => {
    await saveStoryboard("p1", sb);
    expect(await storyboardMatchesSnapshot("p1")).toBe(false);
  });
});
