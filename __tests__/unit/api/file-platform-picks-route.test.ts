import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { setSocialSettings } from "@/lib/db/settings";
import { navigationEmitter } from "@/lib/navigation-events";
import { effectiveRights } from "@/lib/audio-rights/read";
import { serializeAudioRights } from "@/lib/audio-rights/types";
import { PATCH } from "@/app/api/files/by-id/[fileId]/platform-picks/route";

const PAGE = { host: "127.0.0.1:3461", origin: "http://127.0.0.1:3461", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const CURL = { host: "127.0.0.1:3461", "content-type": "application/json" };
const req = (body: unknown, headers: Record<string, string>) =>
  new Request("http://127.0.0.1:3461/api/files/by-id/f1/platform-picks", { method: "PATCH", headers, body: JSON.stringify(body) });
const params = (fileId = "f1") => ({ params: Promise.resolve({ fileId }) });
const TRACK = { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175 };
const events: unknown[] = [];
navigationEmitter.on("refresh_query", (p) => events.push(p));

beforeEach(() => {
  const db = createTestDb();
  seedPiece(db);
  setSocialSettings({ providerId: "zernio", timezone: null, defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 });
  db.insert(files).values({ id: "f1", pieceId: "test-piece-1", filename: "a.mp3", name: "a", description: "", type: "audio", storagePath: "test-piece-1/a.mp3", hasAudio: true, audioRights: serializeAudioRights({ class: "copyrighted", decidedBy: "provenance", decidedAt: "x" }) }).run();
  events.length = 0;
});
afterEach(() => resetTestDb());
const row = () => effectiveRights(getDb().select().from(files).where(eq(files.id, "f1")).get()!)!;

describe("PATCH /api/files/by-id/:fileId/platform-picks", () => {
  it("records the user's pick, stamped user with the connected provider, and refreshes the file and the plans", async () => {
    const res = await PATCH(req({ platform: "tiktok", pick: { status: "picked", track: TRACK, accountId: "tt" } }, PAGE), params());
    expect(res.status).toBe(200);
    expect(row().platformPicks?.tiktok).toMatchObject({ status: "picked", track: TRACK, decidedBy: "user", providerId: "zernio", accountId: "tt" });
    expect(events).toContainEqual({ queryKey: "files", pieceId: "test-piece-1", fileId: "f1" });
    expect(events).toContainEqual({ queryKey: "social", pieceId: "test-piece-1" });
  });

  it("is a user choice: a header-less caller (an agent's shell) is refused and nothing is written", async () => {
    const res = await PATCH(req({ platform: "tiktok", pick: { status: "draft" } }, CURL), params());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("browser_only");
    expect(row().platformPicks).toBeUndefined();
  });

  it("a draft where the platform has none is a 422; an unknown file a 404; 'not_found' is not the user's to set", async () => {
    expect((await PATCH(req({ platform: "instagram", pick: { status: "draft" } }, PAGE), params())).status).toBe(422);
    expect((await PATCH(req({ platform: "tiktok", pick: { status: "draft" } }, PAGE), params("nope"))).status).toBe(404);
    expect((await PATCH(req({ platform: "tiktok", pick: { status: "not_found" } }, PAGE), params())).status).toBe(400);
  });

  it("null clears the user's pick", async () => {
    await PATCH(req({ platform: "tiktok", pick: { status: "draft" } }, PAGE), params());
    await PATCH(req({ platform: "tiktok", pick: null }, PAGE), params());
    expect(row().platformPicks).toBeUndefined();
  });
});
