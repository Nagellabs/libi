import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rematch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/social/music-match", () => ({ scheduleSongRematch: rematch }));

import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { navigationEmitter } from "@/lib/navigation-events";
import { PATCH } from "@/app/api/files/by-id/[fileId]/audio-rights/route";
import { effectiveRights } from "@/lib/audio-rights/read";

const PAGE = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const CURL = { host: "127.0.0.1:3461", "content-type": "application/json" };
const req = (body: unknown, headers: Record<string, string>) =>
  new Request("http://127.0.0.1:3461/api/files/by-id/f1/audio-rights", { method: "PATCH", headers, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ fileId: "f1" }) };

const events: unknown[] = [];
navigationEmitter.on("refresh_query", (p) => events.push(p));

beforeEach(() => {
  const db = createTestDb();
  seedPiece(db);
  db.insert(files).values({ id: "f1", pieceId: "test-piece-1", filename: "a.mp3", name: "a", description: "", type: "audio", storagePath: "test-piece-1/a.mp3", hasAudio: true }).run();
  db.insert(files).values({ id: "img", pieceId: "test-piece-1", filename: "p.png", name: "p", description: "", type: "image", storagePath: "test-piece-1/p.png" }).run();
  events.length = 0;
});
afterEach(() => resetTestDb());

const row = () => getDb().select().from(files).where(eq(files.id, "f1")).get()!;

describe("PATCH /api/files/by-id/:fileId/audio-rights", () => {
  it("marks a track owned from libi's own page", async () => {
    const res = await PATCH(req({ class: "owned" }, PAGE), params);
    expect(res.status).toBe(200);
    expect(effectiveRights(row())).toMatchObject({ class: "owned", decidedBy: "user" });
    expect(events).toContainEqual({ queryKey: "piece", pieceId: "test-piece-1" });
  });

  it("refuses 'owned' from a header-less caller (an agent's shell)", async () => {
    const res = await PATCH(req({ class: "owned" }, CURL), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "browser_only" });
    expect(row().audioRights).toBeNull();
  });

  it("lets a track edit through without the browser checks, keeping the class", async () => {
    getDb().update(files).set({ audioRights: JSON.stringify({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" }) }).where(eq(files.id, "f1")).run();
    const res = await PATCH(req({ track: { title: "Espresso", artist: "Sabrina Carpenter" } }, CURL), params);
    expect(res.status).toBe(200);
    expect(effectiveRights(row())).toMatchObject({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "user" });
  });

  it("404s an unknown file and 422s a file without audio", async () => {
    expect((await PATCH(req({ class: "generated" }, PAGE), { params: Promise.resolve({ fileId: "nope" }) })).status).toBe(404);
    expect((await PATCH(req({ class: "generated" }, PAGE), { params: Promise.resolve({ fileId: "img" }) })).status).toBe(422);
  });

  it("400s an invalid body", async () => {
    expect((await PATCH(req({ class: "mine" }, PAGE), params)).status).toBe(400);
  });
});

describe("PATCH audio-rights — a renamed song is matched again", () => {
  it("a track change schedules a re-match; a class-only change does not", async () => {
    rematch.mockReset();
    await PATCH(req({ track: { title: "Espresso", artist: "Sabrina Carpenter" } }, CURL), params);
    expect(rematch).toHaveBeenCalledWith("f1", "test-piece-1");
    rematch.mockReset();
    await PATCH(req({ class: "copyrighted" }, CURL), params);
    expect(rematch).not.toHaveBeenCalled();
  });
});
