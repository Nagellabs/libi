import { describe, it, expect, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard } from "@/lib/storyboard/repo";
import { handleStoryboardChange } from "@/lib/storyboard/watcher";
import { navigationEmitter } from "@/lib/navigation-events";
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

describe("storyboard watcher change handler", () => {
  it("emits a storyboard refresh for a valid change", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    const spy = vi.fn();
    navigationEmitter.on("refresh_query", spy);
    const res = await handleStoryboardChange("p1");
    navigationEmitter.off("refresh_query", spy);
    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: "storyboard", pieceId: "p1" }),
    );
  });

  it("reports an error (no emit) for an invalid storyboard on disk", async () => {
    createTempStorageDir();
    const { getStorage } = await import("@/lib/storage");
    const storage = await getStorage();
    await storage.save("p1", "storyboard/manifest.json", Buffer.from("{ not json"), "application/json");
    const res = await handleStoryboardChange("p1");
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
