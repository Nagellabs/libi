import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const match = vi.hoisted(() => vi.fn());
vi.mock("@/lib/social/music-match", () => ({ matchSongOnPlatforms: match }));

import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { navigationEmitter } from "@/lib/navigation-events";
import { POST } from "@/app/api/files/by-id/[fileId]/music-match/route";

const req = (headers: Record<string, string> = { host: "127.0.0.1:3461" }) => new Request("http://127.0.0.1:3461/api/files/by-id/f1/music-match", { method: "POST", headers });
const params = (fileId = "f1") => ({ params: Promise.resolve({ fileId }) });
const events: unknown[] = [];
navigationEmitter.on("refresh_query", (p) => events.push(p));

beforeEach(() => {
  const db = createTestDb();
  seedPiece(db);
  db.insert(files).values({ id: "f1", pieceId: "test-piece-1", filename: "a.mp3", name: "a", description: "", type: "audio", storagePath: "test-piece-1/a.mp3", hasAudio: true }).run();
  match.mockReset().mockResolvedValue({ platforms: { tiktok: { status: "not_found", accountId: "tt", fallback: "draft" } }, summary: ["x"] });
  events.length = 0;
});
afterEach(() => resetTestDb());

describe("POST /api/files/by-id/:fileId/music-match", () => {
  it("answers a header-less loopback caller (the MCP child) with the match, and refreshes the file and the plans", async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ platforms: { tiktok: { status: "not_found", accountId: "tt", fallback: "draft" } }, summary: ["x"] });
    expect(events).toContainEqual({ queryKey: "files", pieceId: "test-piece-1", fileId: "f1" });
    expect(events).toContainEqual({ queryKey: "social", pieceId: "test-piece-1" });
  });

  it("refuses another site (it spends the user's grant), and 404s an unknown file", async () => {
    expect((await POST(req({ host: "127.0.0.1:3461", "sec-fetch-site": "cross-site" }), params())).status).toBe(403);
    expect((await POST(req(), params("nope"))).status).toBe(404);
    expect(match).not.toHaveBeenCalled();
  });
});
