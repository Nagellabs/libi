import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { files, pieces } from "@/lib/db/schema/sqlite";
import { initSegmentedTrack, upsertSegment } from "@/lib/tracking/segment-store";
import { readTrack, writeTrack } from "@/lib/tracking/storage";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";

vi.mock("@/lib/db/client", async () => {
  return { getDb: () => globalThis.__libi_test_db };
});

beforeEach(() => {
  createTempStorageDir();
  createTestDb();
});

afterEach(() => {
  resetTestDb();
  cleanupTempDir();
});

async function seed() {
  const { getDb } = await import("@/lib/db/client");
  const db = getDb();
  db.insert(pieces).values({ id: "p1", name: "p", createdAt: new Date() }).run();
  db.insert(files).values({
    id: "f1", pieceId: "p1", filename: "v.mp4", name: "v.mp4", description: "",
    type: "video", storagePath: "p1/v.mp4", contentType: "video/mp4",
    size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 20,
  }).run();
  await initSegmentedTrack({ trackId: "trk1", fileId: "f1", framerate: 30, method: "yoloe+botsort" });
  await upsertSegment("trk1", { id: "seg-0-10000", startTime: 0, endTime: 10,
    method: "yoloe+botsort", status: "ok", samples: [{ t: 0, x: 1, y: 1, w: 1, h: 1, confidence: 1, visible: true }] });
}

describe("manual-anchors route", () => {
  it("POST persists the anchor and lists it; DELETE removes it", async () => {
    await seed();
    const { POST, GET, DELETE } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    const post = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 5, bbox: [10, 20, 30, 40] }) }),
      ctx,
    );
    expect(post.status).toBe(200);
    const body = await post.json();
    expect(body.anchor).toMatchObject({ id: "man-5000", time: 5, bbox: [10, 20, 30, 40] });

    const t = await readTrack("p1", "trk1");
    expect(t?.manualAnchors).toHaveLength(1);
    expect(t?.manualAnchors?.[0]).toMatchObject({ id: "man-5000", time: 5, bbox: [10, 20, 30, 40] });
    // createdAt drives render-stamp consumption (isManualAnchorConsumed).
    expect(typeof t?.manualAnchors?.[0]?.createdAt).toBe("number");

    const list = await (await GET(new Request("http://x"), ctx)).json();
    expect(list.anchors).toHaveLength(1);

    const del = await DELETE(new Request("http://x", { method: "DELETE" }), ctx);
    expect(del.status).toBe(200);
    expect((await readTrack("p1", "trk1"))?.manualAnchors).toEqual([]);
  });

  it("POST 400 on non-finite time (Infinity) — no corruption persisted", async () => {
    await seed();
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    // 1e309 parses as Infinity in JSON
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 1e309, bbox: [1, 2, 3, 4] }) }),
      ctx,
    );
    expect(res.status).toBe(400);

    // bbox element is a non-number string
    const res2 = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 1, bbox: [1, 2, "x", 4] }) }),
      ctx,
    );
    expect(res2.status).toBe(400);

    // Confirm nothing was persisted
    const t = await readTrack("p1", "trk1");
    expect(t?.manualAnchors == null || t.manualAnchors.length === 0).toBe(true);
  });

  it("POST 400 on malformed JSON body", async () => {
    await seed();
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    const res = await POST(
      new Request("http://x", { method: "POST", body: "not json" }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid JSON body");
  });

  it("POST 409 on empty (no-duration) track", async () => {
    await seed();
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    // Insert a second file for the empty track
    db.insert(files).values({
      id: "f2", pieceId: "p1", filename: "v2.mp4", name: "v2.mp4", description: "",
      type: "video", storagePath: "p1/v2.mp4", contentType: "video/mp4",
      size: 1, createdAt: new Date(), mediaWidth: 1920, mediaHeight: 1080, mediaDuration: 20,
    }).run();
    await initSegmentedTrack({ trackId: "trkEmpty", fileId: "f2", framerate: 30, method: "yoloe+botsort" });

    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trkEmpty" }) };

    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 1, bbox: [1, 2, 3, 4] }) }),
      ctx,
    );
    expect(res.status).toBe(409);
  });

  it("GET and POST 404 on missing track", async () => {
    await seed();
    const { GET, POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "nope" }) };

    const getRes = await GET(new Request("http://x"), ctx);
    expect(getRes.status).toBe(404);

    const postRes = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 1, bbox: [1, 2, 3, 4] }) }),
      ctx,
    );
    expect(postRes.status).toBe(404);
  });

  it("DELETE-one removes a single anchor; deleting non-existent anchorId is a no-op", async () => {
    await seed();
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const { DELETE: DELETE_ONE } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/[anchorId]/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    // Post two anchors
    await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 5, bbox: [1, 2, 3, 4] }) }),
      ctx,
    );
    await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ time: 8, bbox: [5, 6, 7, 8] }) }),
      ctx,
    );

    // Delete the first one (man-5000)
    const del1 = await DELETE_ONE(
      new Request("http://x", { method: "DELETE" }),
      { params: Promise.resolve({ pieceId: "p1", trackId: "trk1", anchorId: "man-5000" }) },
    );
    expect(del1.status).toBe(200);

    const t1 = await readTrack("p1", "trk1");
    expect(t1?.manualAnchors).toHaveLength(1);
    expect(t1?.manualAnchors?.[0].id).toBe("man-8000");

    // Delete non-existent anchor — no-op, still 200
    const del2 = await DELETE_ONE(
      new Request("http://x", { method: "DELETE" }),
      { params: Promise.resolve({ pieceId: "p1", trackId: "trk1", anchorId: "nope" }) },
    );
    expect(del2.status).toBe(200);

    const t2 = await readTrack("p1", "trk1");
    expect(t2?.manualAnchors).toHaveLength(1);
    expect(t2?.manualAnchors?.[0].id).toBe("man-8000");
  });

  it("POST {retrack:true} re-tracks one job per DISTINCT bounded window (not per segment)", async () => {
    await seed();
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    // Two anchors in the SAME OK segment [0,10] but in different ±3 windows:
    //   t=2 → reanchorWindow {0,5};  t=8 → {5,10}.
    // The OLD (buggy) dedup keyed on the whole segment {0,10} → would collapse
    // these to ONE re-track and silently drop the t=8 correction. The fix
    // dedups by the bounded window → TWO distinct re-tracks.
    const t = await readTrack("p1", "trk1");
    await writeTrack("p1", {
      ...t!,
      manualAnchors: [
        { id: "man-2000", time: 2, bbox: [1, 2, 3, 4] },
        { id: "man-8000", time: 8, bbox: [5, 6, 7, 8] },
      ],
    });

    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ retrack: true }) }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retracking: 2 });
  });

  it("POST {retrack:true} short-circuits to retracking:0 when there are no manual anchors", async () => {
    await seed();
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ retrack: true }) }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, retracking: 0 });
  });

  it("apply-deletes removes the listed anchors, keeps the rest, and re-tracks one job per DISTINCT freed window", async () => {
    await seed();
    const t = await readTrack("p1", "trk1");
    // Small OK segment [0,4]: ±3 windows of t=1 and t=3 BOTH clamp to {0,4}
    // (max(0,t-3)=0, min(4,t+3)=4) — a genuine dedup case. t=3.5 survives.
    await writeTrack("p1", {
      ...t!,
      durationSec: 4,
      segments: [
        { id: "seg-0-4000", startTime: 0, endTime: 4, method: "yoloe+botsort", status: "ok", samples: [] },
      ],
      manualAnchors: [
        { id: "man-1000", time: 1, bbox: [1, 1, 1, 1] }, // window {0,4}
        { id: "man-3000", time: 3, bbox: [2, 2, 2, 2] }, // window {0,4} (dup)
        { id: "man-3500", time: 3.5, bbox: [3, 3, 3, 3] }, // survivor
      ],
    });

    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/apply-deletes/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    // Delete the two anchors that share the {0,4} window → 1 distinct re-track.
    const res = await POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ anchorIds: ["man-1000", "man-3000"] }),
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 2, retracking: 1 });

    // man-3500 survives; the two deleted ones are gone.
    const after = await readTrack("p1", "trk1");
    expect(after?.manualAnchors).toEqual([{ id: "man-3500", time: 3.5, bbox: [3, 3, 3, 3] }]);
  });

  it("apply-deletes is a no-op (removed:0) when none of the ids exist", async () => {
    await seed();
    const t = await readTrack("p1", "trk1");
    await writeTrack("p1", {
      ...t!,
      manualAnchors: [{ id: "man-2000", time: 2, bbox: [1, 2, 3, 4] }],
    });
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/apply-deletes/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };
    const res = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ anchorIds: ["nope"] }) }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 0, retracking: 0 });
    const after = await readTrack("p1", "trk1");
    expect(after?.manualAnchors).toEqual([{ id: "man-2000", time: 2, bbox: [1, 2, 3, 4] }]);
  });

  it("apply-deletes 400 on missing/empty anchorIds, 404 on missing track", async () => {
    await seed();
    const { POST } = await import(
      "@/app/api/pieces/[pieceId]/tracks/[trackId]/manual-anchors/apply-deletes/route"
    );
    const ctx = { params: Promise.resolve({ pieceId: "p1", trackId: "trk1" }) };

    const empty = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ anchorIds: [] }) }),
      ctx,
    );
    expect(empty.status).toBe(400);

    const missing = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({}) }),
      ctx,
    );
    expect(missing.status).toBe(400);

    const noTrack = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ anchorIds: ["x"] }) }),
      { params: Promise.resolve({ pieceId: "p1", trackId: "nope" }) },
    );
    expect(noTrack.status).toBe(404);
  });
});
