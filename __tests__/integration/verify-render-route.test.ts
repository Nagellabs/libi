import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { initSegmentedTrack, upsertSegment } from "@/lib/tracking/segment-store";

vi.mock("@/lib/db/client", async () => ({ getDb: () => globalThis.__libi_test_db }));
vi.mock("@/lib/tracking/verify-render", () => ({
  renderVerifyFrames: vi.fn(async (input: { times: number[] }) => ({
    frames: input.times.map((t) => ({
      time: t, pngBase64: "AAAA", segmentId: "seg-0-10000",
      method: "yoloe+botsort", status: "ok", objectKind: "object",
      isAnchorFrame: false, sampledRect: { x: 1, y: 1, w: 2, h: 2 },
      trackBbox: { x: 1, y: 1, w: 2, h: 2 }, visible: true,
    })),
  })),
}));

beforeEach(() => { createTempStorageDir(); createTestDb(); });
afterEach(() => { resetTestDb(); cleanupTempDir(); vi.clearAllMocks(); });

async function seed() {
  const { getDb } = await import("@/lib/db/client");
  const db = getDb();
  db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
  db.insert(files).values({
    id: "f1", pieceId: "p1", filename: "v.mp4", name: "v.mp4", description: "",
    type: "video", storagePath: "p1/v.mp4", contentType: "video/mp4",
    size: 1, createdAt: new Date(), mediaWidth: 640, mediaHeight: 360, mediaDuration: 30,
  }).run();
  await initSegmentedTrack({ trackId: "t1", fileId: "f1", framerate: 30, method: "yoloe+botsort" });
  await upsertSegment("t1", {
    id: "seg-0-10000", startTime: 0, endTime: 10, method: "yoloe+botsort",
    status: "ok", samples: [{ t: 0, x: 1, y: 1, w: 2, h: 2, confidence: 1, visible: true }],
  });
}

describe("POST /api/tracking/verify-render", () => {
  it("400s on a body that is neither pre- nor post-attach", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/verify-render/route");
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  it("400s on a traversal pieceId before any read (RC-D)", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/verify-render/route");
    const res = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ pieceId: "../foo", overlayId: "ov1" }),
    }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe("invalid pieceId");
  });

  it("404s when the track is missing", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/verify-render/route");
    const res = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ fileId: "f1", trackId: "missing", content: { kind: "emoji", char: "x" }, fit: "tight" }),
    }));
    expect(res.status).toBe(404);
  });

  it("renders pre-attach frames + returns summary/segments", async () => {
    await seed();
    const { POST } = await import("@/app/api/tracking/verify-render/route");
    const res = await POST(new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        fileId: "f1", trackId: "t1",
        content: { kind: "emoji", char: "😀" }, fit: "tight",
      }),
    }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.success).toBe(true);
    expect(Array.isArray(j.frames)).toBe(true);
    expect(j.frames.length).toBeGreaterThan(0);
    expect(j.summary).toBeTruthy();
    expect(Array.isArray(j.segments)).toBe(true);
  });
});
