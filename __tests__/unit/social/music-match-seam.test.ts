import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const logSpies = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: logSpies, mcpLogger: logSpies }));

import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { fakeZernioMcp } from "@/__tests__/helpers/zernio-fake";
import { ZernioAdapter } from "@/lib/social/providers/zernio/adapter";
import { __setSocialServiceForTests } from "@/lib/social/service";
import { serializeAudioRights } from "@/lib/audio-rights/types";
import { matchSongOnPlatforms } from "@/lib/social/music-match";
import accountFixture from "@/lib/social/providers/zernio/fixtures/account.json";
import cml from "@/lib/social/providers/zernio/fixtures/tiktok-commercial-music.json";
import igAudio from "@/lib/social/providers/zernio/fixtures/instagram-audio.json";

beforeEach(() => {
  createTestDb();
  seedPiece(getDb() as never, { id: "p1" });
  getDb().insert(files).values({
    id: "s", pieceId: "p1", filename: "s.mp3", name: "s.mp3", description: "", type: "audio", storagePath: "p1/s.mp3", hasAudio: true,
    audioRights: serializeAudioRights({ class: "copyrighted", track: { title: "Self Aware", artist: "Mark Allan Wolfe" }, decidedBy: "agent", decidedAt: "x" }),
  }).run();
  const { mcp } = fakeZernioMcp({
    accounts_list_accounts: { accounts: [{ ...accountFixture.account, _id: "tt1", platform: "tiktok" }, { ...accountFixture.account, _id: "ig1" }] },
    accounts_list_tik_tok_commercial_music: cml,
    instagram_search_instagram_audio: igAudio,
  });
  const adapter = new ZernioAdapter(mcp, { aiLabelDefault: true });
  __setSocialServiceForTests({
    async status() { return { providerId: "zernio", connected: true, needsReconnect: false, scopes: [] }; },
    async adapter() { return adapter; },
    markUnauthorized() {}, reset() {}, disconnect() {},
  });
});
afterEach(() => {
  __setSocialServiceForTests(null);
  resetTestDb();
});

describe("matching through the real adapter", () => {
  it("TikTok's recorded trending list matches the song by the track id; Instagram's recorded search does not have it", async () => {
    const r = await matchSongOnPlatforms("s");
    expect(r).toMatchObject({
      platforms: {
        tiktok: { status: "picked", accountId: "tt1", track: { id: "7521888697513396241", title: "Self Aware", artist: "Mark Allan Wolfe" } },
        instagram: { status: "not_found", accountId: "ig1" },
      },
    });
  });
});
