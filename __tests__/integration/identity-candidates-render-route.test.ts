import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files, pieces } from "@/lib/db/schema/sqlite";

vi.mock("@/lib/db/client", async () => ({ getDb: () => globalThis.__libi_test_db }));
vi.mock("@/lib/tracking/identity-candidates-render", () => ({
  renderCandidateFrames: vi.fn(async (args: { range: { start: number; end: number } }) => [
    { time: args.range.start, pngBase64: "AAAA" },
    { time: args.range.end, pngBase64: "BBBB" },
  ]),
}));

beforeEach(() => {
  createTempStorageDir();
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  cleanupTempDir();
  vi.clearAllMocks();
});

async function seed() {
  const { getDb } = await import("@/lib/db/client");
  const db = getDb();
  db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
  db.insert(files)
    .values({
      id: "f1",
      pieceId: "p1",
      filename: "v.mp4",
      name: "v.mp4",
      description: "",
      type: "video",
      storagePath: "p1/v.mp4",
      contentType: "video/mp4",
      size: 1,
      createdAt: new Date(),
      mediaWidth: 640,
      mediaHeight: 360,
      mediaDuration: 30,
    })
    .run();
}

describe("POST /api/tracking/identity-candidates-render", () => {
  it("400s on a body missing fileId/range/candidates", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/identity-candidates-render/route");
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  it("404s when the file is missing", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/identity-candidates-render/route");
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          pieceId: "p1",
          fileId: "missing",
          range: { start: 20, end: 25 },
          candidates: [],
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("renders candidate frames and returns { success, frames }", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/identity-candidates-render/route");
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          pieceId: "p1",
          fileId: "f1",
          range: { start: 20, end: 25 },
          candidates: [
            { candidateId: 3, perFrame: [{ t: 22, bbox: [120, 80, 90, 220] }], meanTargetSim: 0.9, frameCount: 1 },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    expect(Array.isArray(j.frames)).toBe(true);
    expect(j.frames.length).toBe(2);
    expect(j.frames[0].pngBase64).toBe("AAAA");
  });
});
