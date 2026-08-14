import { describe, it, expect, afterEach } from "vitest";
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
