import { it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { GET } from "@/app/api/pieces/[pieceId]/audio-rights/route";

beforeEach(() => {
  createTestDb();
  createTempStorageDir();
  seedPiece(getDb() as never, { id: "p1" });
});
afterEach(() => {
  resetTestDb();
  cleanupTempDir();
});

// Stamped explicitly: an unstamped file reads as the user's own (owner decision 2026-09-28).
it("lists the piece's copyrighted songs", async () => {
  getDb().insert(files).values({ id: "s", pieceId: "p1", filename: "s.mp3", name: "Song", description: "", type: "audio", storagePath: "p1/s.mp3", hasAudio: true, audioRights: JSON.stringify({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" }) }).run();
  const m = await loadManifest("p1");
  m.audioClips = [{ id: "c", kind: "standalone", fileId: "s", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true }];
  await saveManifest("p1", m);
  const res = await GET(new Request("http://x/api/pieces/p1/audio-rights"), { params: Promise.resolve({ pieceId: "p1" }) });
  expect(await res.json()).toEqual({ copyrighted: [{ fileId: "s", name: "Song", fileType: "audio", clipSeconds: 4 }], ownMusic: [] });
});

it("does not list a song that lives only on a hidden layer — the export never plays it", async () => {
  getDb().insert(files).values({ id: "v", pieceId: "p1", filename: "v.mp4", name: "Clip", description: "", type: "video", storagePath: "p1/v.mp4", hasAudio: true, audioRights: JSON.stringify({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" }) }).run();
  const m = await loadManifest("p1");
  m.overlays = [
    { id: "vid", kind: "video", fileId: "v", z: 0, startTime: 0, duration: 4, trimStart: 0, rect: { x: 0, y: 0, width: 1080, height: 1920 }, hidden: true },
  ] as unknown as typeof m.overlays;
  m.audioClips = [{ id: "c", kind: "inline", linkedOverlayId: "vid", fileId: "v", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true }];
  await saveManifest("p1", m);
  const res = await GET(new Request("http://x/api/pieces/p1/audio-rights"), { params: Promise.resolve({ pieceId: "p1" }) });
  expect(await res.json()).toEqual({ copyrighted: [], ownMusic: [] });
});

it("lists every track the piece plays: the song with its picks, and the user's own and libi's with their class", async () => {
  const picks = { tiktok: { status: "not_found", decidedBy: "auto", decidedAt: "x" } };
  getDb().insert(files).values({ id: "s", pieceId: "p1", filename: "s.mp3", name: "Song", description: "", type: "audio", storagePath: "p1/s.mp3", hasAudio: true, audioRights: JSON.stringify({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "x", platformPicks: picks }) }).run();
  getDb().insert(files).values({ id: "v", pieceId: "p1", filename: "v.mp4", name: "Clip", description: "", type: "video", storagePath: "p1/v.mp4", hasAudio: true }).run();
  getDb().insert(files).values({ id: "g", pieceId: "p1", filename: "g.wav", name: "Bed", description: "", type: "audio", storagePath: "p1/g.wav", hasAudio: true, audioRights: JSON.stringify({ class: "generated", decidedBy: "provenance", decidedAt: "x" }) }).run();
  const m = await loadManifest("p1");
  m.audioClips = [
    { id: "c1", kind: "standalone", fileId: "s", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true },
    { id: "c2", kind: "standalone", fileId: "v", startTime: 0, duration: 3, trimStart: 0, volume: 1, enabled: true },
    { id: "c3", kind: "standalone", fileId: "g", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true },
  ];
  await saveManifest("p1", m);
  const res = await GET(new Request("http://x/api/pieces/p1/audio-rights"), { params: Promise.resolve({ pieceId: "p1" }) });
  expect(await res.json()).toEqual({
    copyrighted: [{ fileId: "s", name: "Song", fileType: "audio", track: { title: "Espresso", artist: "Sabrina Carpenter" }, clipSeconds: 4, platformPicks: picks }],
    ownMusic: [
      { fileId: "v", name: "Clip", fileType: "video", class: "owned" },
      { fileId: "g", name: "Bed", fileType: "audio", class: "generated" },
    ],
  });
});
