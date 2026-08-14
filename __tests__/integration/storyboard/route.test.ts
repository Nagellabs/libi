// __tests__/integration/storyboard/route.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard } from "@/lib/storyboard/repo";
import { GET } from "@/app/api/pieces/[pieceId]/storyboard/route";
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

describe("GET /api/pieces/[pieceId]/storyboard", () => {
  it("returns the storyboard JSON", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ pieceId: "p1" }) });
    const body = await res.json();
    expect(body.storyboard.cards[0].id).toBe("c1");
  });
});
