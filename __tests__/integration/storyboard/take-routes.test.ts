import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { addStoryboardCard, appendClipTake, loadCard } from "@/lib/storyboard/repo";
import { POST, DELETE } from "@/app/api/pieces/[pieceId]/storyboard/cards/[cardId]/take/route";

describe("take routes", () => {
  // A real piece id is a `crypto.randomUUID()` (safe under the RC-D pieceId
  // guard). `createTempStorageDir()` sets LIBI_HOME so storage writes land in a
  // throwaway dir; its return value is the temp dir for cleanup, NOT a pieceId.
  const pieceId = "sb-piece-1";
  beforeEach(async () => { createTestDb(); createTempStorageDir(); });
  afterEach(async () => { cleanupTempDir(); resetTestDb(); });

  it("POST selects a take, DELETE hides it", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const t1 = await appendClipTake(pieceId, card.id, "f1");
    const t2 = await appendClipTake(pieceId, card.id, "f2");
    const params = Promise.resolve({ pieceId, cardId: card.id });
    const sel = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ takeId: t2!.id }) }), { params });
    expect(sel.status).toBe(200);
    expect((await loadCard(pieceId, card.id))?.selectedClipId).toBe(t2!.id);
    const hid = await DELETE(new Request("http://x", { method: "DELETE", body: JSON.stringify({ takeId: t2!.id }) }), { params });
    expect(hid.status).toBe(200);
    const out = await loadCard(pieceId, card.id);
    expect(out?.clips?.find((c) => c.id === t2!.id)?.hidden).toBe(true);
    expect(out?.selectedClipId).toBe(t1!.id);
  });

  it("404s when the card/take is missing", async () => {
    const params = Promise.resolve({ pieceId, cardId: "nope" });
    const r = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ takeId: "x" }) }), { params });
    expect(r.status).toBe(404);
  });

  it("400s when takeId is missing", async () => {
    const card = await addStoryboardCard(pieceId, { title: "c" });
    const params = Promise.resolve({ pieceId, cardId: card.id });
    const r = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({}) }), { params });
    expect(r.status).toBe(400);
  });
});
