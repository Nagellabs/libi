import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getStorage, resetStorage } from "@/lib/storage";
import { saveStoryboard } from "@/lib/storyboard/repo";
import { GET } from "@/app/api/pieces/[pieceId]/storyboard/cards/[cardId]/sketches/[slotId]/route";

afterEach(() => { cleanupTempDir(); resetStorage(); });

function ctx(pieceId: string, cardId: string, slotId: string) {
  return { params: Promise.resolve({ pieceId, cardId, slotId }) };
}

describe("sketch serve route", () => {
  it("serves an already-rendered slot PNG", async () => {
    createTempStorageDir();
    const storage = await getStorage();
    await storage.save("p1", "storyboard/cards/c1/sketches/sk_1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    const res = await GET(new Request("http://x"), ctx("p1", "c1", "sk_1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("404s an unknown slot with no unit to render", async () => {
    createTempStorageDir();
    const storage = await getStorage();
    await storage.save("p1", "storyboard/manifest.json", Buffer.from(JSON.stringify({ version: 2, cardOrder: [], updatedAt: "t" })), "application/json");
    const res = await GET(new Request("http://x"), ctx("p1", "c1", "sk_9"));
    expect(res.status).toBe(404);
  });

  // F12 (final review): the ids are GENERATED (`card_N` or an agent's `s1-hook`, `sk_N`), so the
  // route takes only that alphabet — a piece id by `isSafePieceId`, a card / slot id by
  // `isSafeStoryboardId` — rather than any one path segment.
  it("serves a generated-shape id, including an agent's dotted card id", async () => {
    createTempStorageDir();
    const storage = await getStorage();
    await storage.save("p1", "storyboard/cards/s1.hook-2/sketches/sk_12.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    const res = await GET(new Request("http://x"), ctx("p1", "s1.hook-2", "sk_12"));
    expect(res.status).toBe(200);
  });

  it.each([
    ["pieceId", "p1.x"], ["pieceId", "p 1"], ["cardId", "c1."], ["cardId", ".c1"], ["cardId", "c1:x"],
    ["slotId", "sk_...50%"], ["slotId", "sk 1"], ["slotId", "sk_1:x"],
  ])("refuses a %s that is not id-shaped (%j)", async (which, value) => {
    createTempStorageDir();
    const ids = { pieceId: "p1", cardId: "c1", slotId: "sk_1", [which]: value };
    const res = await GET(new Request("http://x"), ctx(ids.pieceId, ids.cardId, ids.slotId));
    expect(res.status).toBe(400);
  });

  it.each(["..", "a/b", "a\\b", "..%2fx", "%2e%2e", "..%2fx%", "%2e%2e%"])("refuses the traversal-shaped slot id %j", async (slotId) => {
    createTempStorageDir();
    const res = await GET(new Request("http://x"), ctx("p1", "c1", slotId));
    expect(res.status).toBe(400);
  });

  // Fix round 2: served through realPathForRead, so a symlink planted in the
  // piece dir is not followed out of it.
  it("does not follow a symlinked slot PNG out of the piece dir", async () => {
    const dir = createTempStorageDir();
    const outside = path.join(dir, "..", `outside-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(outside, Buffer.from("SECRET"));
    try {
      const storage = await getStorage();
      await storage.save("p1", "storyboard/cards/c1/sketches/keep.png", Buffer.from([0x89]), "image/png");
      const link = storage.localPath("p1", "storyboard/cards/c1/sketches/sk_1.png");
      fs.symlinkSync(outside, link);
      const res = await GET(new Request("http://x"), ctx("p1", "c1", "sk_1"));
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects a path-traversal slot id", async () => {
    createTempStorageDir();
    const res = await GET(new Request("http://x"), ctx("p1", "c1", "../../etc"));
    expect(res.status).toBe(400);
  });

  it("lazy-renders a slot PNG on demand when card + unit file present but PNG absent", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", {
      version: 2, cardOrder: ["c1"], updatedAt: "t",
      cards: [{
        id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video", title: "t",
        sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
        camera: { shot: "medium" }, promptFragment: "p", stage: "schematic", approvals: {},
      }],
    });
    const storage = await getStorage();
    await storage.save("p1", "storyboard/cards/c1/sketches/sk_1/unit.jsx",
      Buffer.from('return h("div", { style: { width: "100%", height: "100%", display: "flex", background: "#fff" } }, "x");'),
      "text/plain");
    // do NOT write the PNG — we want the lazy-render path to fire
    const res = await GET(new Request("http://x"), ctx("p1", "c1", "sk_1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});
