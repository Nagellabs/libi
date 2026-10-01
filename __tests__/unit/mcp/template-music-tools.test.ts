import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { serializeAudioRights } from "@/lib/audio-rights/types";
import { effectiveRights } from "@/lib/audio-rights/read";

const downloadVideo = vi.hoisted(() => vi.fn());
vi.mock("@/mcp/tools/video-download-tools", () => ({ downloadVideo }));
const logSpies = vi.hoisted(() => {
  const spies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() };
  spies.child.mockImplementation(() => spies);
  return spies;
});
vi.mock("@/lib/logger", async (orig) => ({ ...(await orig<object>()), serverLogger: logSpies, mcpLogger: logSpies }));
vi.mock("@/mcp/notify", () => ({ notify: { refreshQuery: vi.fn() } }));

import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { fetchTemplateMusic } from "@/mcp/tools/template-music-tools";

const PENDING = {
  assetId: "tpl-abcd1234-espresso", templateId: "abcd1234-xxxx",
  track: { title: "Espresso", artist: "Sabrina Carpenter" }, sourceUrl: "https://www.youtube.com/watch?v=abc",
  clips: [{ startTime: 0, duration: 3, trimStart: 12, volume: 0.8 }, { startTime: 4, duration: 2, trimStart: 30, volume: 0.8 }],
};

beforeEach(async () => {
  createTestDb();
  createTempStorageDir();
  seedPiece(getDb() as never, { id: "p1" });
  const m = await loadManifest("p1");
  m.pendingMusic = [PENDING];
  await saveManifest("p1", m);
  downloadVideo.mockReset();
  for (const spy of [logSpies.info, logSpies.warn, logSpies.error]) spy.mockClear();
});
afterEach(() => {
  resetTestDb();
  cleanupTempDir();
});

describe("libi.fetch_template_music", () => {
  it("downloads the song, names it, places it at the template's timing and clears the pending entry", async () => {
    downloadVideo.mockImplementation(async () => {
      getDb().insert(files).values({ id: "dl", pieceId: "p1", filename: "Espresso.mp3", name: "Espresso.mp3", description: "", type: "audio", storagePath: "p1/Espresso.mp3", hasAudio: true,
        audioRights: serializeAudioRights({ class: "copyrighted", source: { url: "https://www.youtube.com/watch?v=abc", site: "youtube" }, decidedBy: "provenance", decidedAt: "x" }) }).run();
      return { success: true, data: { fileId: "dl", filename: "Espresso.mp3", title: "Espresso", bytes: 3 } };
    });
    const r = await fetchTemplateMusic({ pieceId: "p1", assetId: PENDING.assetId });
    expect(downloadVideo).toHaveBeenCalledWith({ url: PENDING.sourceUrl, pieceId: "p1", audioOnly: true }, undefined);
    expect(r).toMatchObject({ success: true, data: { fileId: "dl", track: PENDING.track } });
    const m = await loadManifest("p1");
    expect(m.pendingMusic).toBeUndefined();
    expect((m.audioClips ?? []).map((c) => [c.fileId, c.kind, c.startTime, c.duration, c.trimStart, c.volume, c.enabled])).toEqual([
      ["dl", "standalone", 0, 3, 12, 0.8, true],
      ["dl", "standalone", 4, 2, 30, 0.8, true],
    ]);
    const row = getDb().select().from(files).where(eq(files.id, "dl")).get()!;
    expect(effectiveRights(row)).toMatchObject({ class: "copyrighted", track: PENDING.track, source: { site: "youtube" } });
  });

  it("places each clip with the template's enabled flag and duck, dropping sidechains the piece no longer has", async () => {
    const DUCK = { thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: -12 };
    const m0 = await loadManifest("p1");
    m0.audioClips = [{ id: "vo1", kind: "standalone", fileId: "vo-file", startTime: 0, duration: 6, trimStart: 0, volume: 1, enabled: true }];
    m0.pendingMusic = [{
      ...PENDING,
      clips: [
        { startTime: 0, duration: 3, trimStart: 12, volume: 0.8, enabled: false, duck: { sidechainClipIds: ["vo1", "deleted-since"], ...DUCK } },
        { startTime: 4, duration: 2, trimStart: 30, volume: 0.8 },
      ],
    }];
    await saveManifest("p1", m0);
    downloadVideo.mockImplementation(async () => {
      getDb().insert(files).values({ id: "dl", pieceId: "p1", filename: "Espresso.mp3", name: "Espresso.mp3", description: "", type: "audio", storagePath: "p1/Espresso.mp3", hasAudio: true }).run();
      return { success: true, data: { fileId: "dl" } };
    });
    const r = await fetchTemplateMusic({ pieceId: "p1", assetId: PENDING.assetId });
    expect(r.success).toBe(true);
    const placed = ((await loadManifest("p1")).audioClips ?? []).filter((c) => c.fileId === "dl");
    expect(placed.map((c) => [c.enabled, c.duck])).toEqual([
      [false, { sidechainClipIds: ["vo1"], ...DUCK }],
      [true, undefined],
    ]);
  });

  /** Task 22 review: the rights write failing must not lose the user's song. */
  it("still places the clips, and logs a warning, when recording the track on the file fails", async () => {
    // The downloader answers a file id that is not in this piece, so updateAudioRights answers ok:false.
    downloadVideo.mockResolvedValue({ success: true, data: { fileId: "not-in-db" } });
    const r = await fetchTemplateMusic({ pieceId: "p1", assetId: PENDING.assetId });
    expect(r).toMatchObject({ success: true, data: { fileId: "not-in-db" } });
    const m = await loadManifest("p1");
    expect((m.audioClips ?? []).map((c) => c.fileId)).toEqual(["not-in-db", "not-in-db"]);
    expect(m.pendingMusic).toBeUndefined();
    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "social-music", op: "template_music_rights_failed", fileId: "not-in-db", code: "not_found" }),
      expect.any(String),
    );
  });

  it("with no source link: asks the user, downloads nothing", async () => {
    const m = await loadManifest("p1");
    m.pendingMusic = [{ ...PENDING, sourceUrl: undefined }];
    await saveManifest("p1", m);
    expect(await fetchTemplateMusic({ pieceId: "p1", assetId: PENDING.assetId })).toEqual({
      success: false, error: "no_source", data: { hint: "ask the user for a file or link for Espresso — Sabrina Carpenter" },
    });
    expect(downloadVideo).not.toHaveBeenCalled();
  });

  it("an unknown entry, and a failed download, change nothing", async () => {
    expect(await fetchTemplateMusic({ pieceId: "p1", assetId: "nope" })).toMatchObject({ success: false, error: "pending_music_not_found" });
    downloadVideo.mockResolvedValue({ success: false, error: "download_failed", data: { message: "offline" } });
    expect(await fetchTemplateMusic({ pieceId: "p1", assetId: PENDING.assetId })).toMatchObject({ success: false, error: "download_failed" });
    expect((await loadManifest("p1")).pendingMusic).toHaveLength(1);
  });
});
