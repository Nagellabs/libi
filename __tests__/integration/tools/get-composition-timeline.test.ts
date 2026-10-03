/**
 * libi.get_composition `view: "timeline"` and libi.get_piece_state `pieceIds` (agent-speed B9): the compact
 * multi-piece reads, against a real fs-backed manifest and an in-memory database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { LocalFileStorage } from "@/lib/storage/local";
import { files, folders, pieces } from "@/lib/db/schema/sqlite";
import { getCompositionTool } from "@/mcp/tools/composition-tools";
import { getPiecesSweepTool } from "@/mcp/tools/snapshot-tools";
import { serializeAudioRights } from "@/lib/audio-rights/types";
import { eq } from "drizzle-orm";

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const rect = { x: 0, y: 0, width: 1080, height: 1920 };
let db: ReturnType<typeof createTestDb>;

function manifestFor(pieceId: string, endCardDuration: number) {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays: [
      { id: `${pieceId}-v`, kind: "video", fileId: `${pieceId}-fv`, startTime: 0, duration: 12, z: 0, opacity: 1, rect },
      { id: `${pieceId}-c`, kind: "code", displayName: "End card", startTime: 9, duration: endCardDuration, z: 2, opacity: 1, rect },
    ],
    audioClips: [
      { id: `${pieceId}-a`, kind: "standalone", fileId: `${pieceId}-fm`, startTime: 0, duration: 12, trimStart: 0, volume: 0.4, enabled: true },
    ],
  };
}

function seed(id: string, name: string, endCard: number, folderId: string | null = null) {
  seedPiece(db, { id, name });
  if (folderId) db.update(pieces).set({ folderId }).where(eq(pieces.id, id)).run();
  fs.mkdirSync(path.join(tempDir, id), { recursive: true });
  fs.writeFileSync(path.join(tempDir, id, "composition.json"), JSON.stringify(manifestFor(id, endCard)));
  db.insert(files).values({ id: `${id}-fv`, pieceId: id, filename: "clip.mp4", name: "clip.mp4", description: "", type: "video", storagePath: `${id}/clip.mp4`, contentType: "video/mp4", size: 1, mediaDuration: 16 }).run();
  db.insert(files).values({
    id: `${id}-fm`, pieceId: id, filename: "bed.mp3", name: "bed.mp3", description: "", type: "audio", storagePath: `${id}/bed.mp3`, contentType: "audio/mpeg", size: 1,
    hasAudio: true, mediaDuration: 30, audioRights: serializeAudioRights({ class: "copyrighted", track: { title: "Dreams" }, decidedBy: "user", decidedAt: "2026-10-01T00:00:00.000Z" }),
  }).run();
}

beforeEach(() => {
  tempDir = createTempStorageDir();
  db = createTestDb();
});
afterEach(() => {
  cleanupTempDir(tempDir);
  resetTestDb();
});

const timeline = (r: { data?: unknown }) => (r.data as { timeline: string }).timeline;

describe("get_composition view timeline", () => {
  it("one piece: a compact text with a line per layer, rights from the files table", async () => {
    seed("p1", "Piece 1", 3);
    const r = await getCompositionTool({ pieceId: "p1", view: "timeline" });
    expect(r.success).toBe(true);
    const t = timeline(r);
    expect(t).toContain("piece Piece 1 [p1] 12s 1080x1920 30fps no draft, 2 overlays, 1 audio");
    expect(t).toContain("p1-c code 9–12 z2 End card");
    expect(t).toContain("p1-v video 0–12 z0 clip.mp4 src 16s, 4s left");
    expect(t).toContain("p1-a bed.mp3 0–12 src 30s, 18s left vol0.4 copyrighted(Dreams)");
    expect(JSON.stringify(r).length).toBeLessThan(JSON.stringify(manifestFor("p1", 3)).length * 3);
  });

  it("pieceIds: groups by piece and marks what differs from the first", async () => {
    seed("p1", "01", 3);
    seed("p2", "02", 3);
    seed("p3", "03", 5);
    const r = await getCompositionTool({ pieceIds: ["p1", "p2", "p3"] });
    expect(r.success).toBe(true);
    const t = timeline(r);
    expect(t.split("\n")[0]).toContain("3 pieces.");
    expect(t.split("\n")[0]).toContain("Match the first: 02.");
    expect(t.split("\n")[0]).toContain("Differ: 03 (1 line)");
    expect(t).toContain("  p2-c =");
    expect(t).toContain("  p3-c code 9–14 z2 End card ≠time");
  });

  it("folderId: the folder's direct pieces in name order (02 before 10), with a note saying so", async () => {
    db.insert(folders).values({ id: "f1", name: "Dreams" }).run();
    seed("pa", "10 ten", 3, "f1");
    seed("pb", "02 two", 3, "f1");
    seed("pc", "outside", 3);
    const r = await getCompositionTool({ folderId: "f1", view: "timeline" });
    expect(r.success).toBe(true);
    const t = timeline(r);
    expect(t.indexOf("02 two")).toBeLessThan(t.indexOf("10 ten"));
    expect(t).not.toContain("outside");
    expect((r.data as { note: string }).note).toMatch(/direct pieces in name order/);
  });

  it("names a piece that does not exist and still reads the rest; refuses when none exist", async () => {
    seed("p1", "01", 3);
    const some = await getCompositionTool({ pieceIds: ["p1", "ghost"] });
    expect(some.success).toBe(true);
    expect((some.data as { notFound: string[] }).notFound).toEqual(["ghost"]);
    const none = await getCompositionTool({ pieceIds: ["ghost"] });
    expect(none).toEqual({ success: false, error: "piece_not_found: ghost" });
  });

  it("refuses ambiguous or unusable targets with a sentence that says what to send", async () => {
    seed("p1", "01", 3);
    expect(await getCompositionTool({})).toMatchObject({ success: false, error: expect.stringMatching(/Give pieceId/) });
    expect(await getCompositionTool({ pieceId: "p1", pieceIds: ["p1"], view: "timeline" })).toMatchObject({ success: false, error: expect.stringMatching(/exactly one/) });
    expect(await getCompositionTool({ pieceIds: ["p1"], view: "full" })).toMatchObject({ success: false, error: expect.stringMatching(/view: "timeline"/) });
    expect(await getCompositionTool({ folderId: "nope" })).toEqual({ success: false, error: "folder_not_found" });
  });

  it("the default view is still the full manifest of one piece", async () => {
    seed("p1", "01", 3);
    const r = await getCompositionTool({ pieceId: "p1" });
    expect((r.data as { manifest: { width: number } }).manifest.width).toBe(1080);
    expect(r.data).not.toHaveProperty("timeline");
  });
});

describe("get_piece_state pieceIds (the diagnostics sweep)", () => {
  it("returns name, hasDraft, duration and the render diagnostics of each piece, and a one-line summary", async () => {
    seed("p1", "01", 3);
    seed("p2", "02", 3);
    db.update(pieces).set({ hasDraft: true }).where(eq(pieces.id, "p2")).run();
    const fetchDiagnostics = async (id: string) =>
      id === "p2"
        ? { diagnostics: [{ overlayId: "p2-c", kind: "code", phase: "render", message: "heart is not defined", sourceHash: "h", at: 1 } as never], unattributed: [] }
        : { diagnostics: [], unattributed: [] };
    const r = await getPiecesSweepTool(["p1", "p2", "ghost"], { fetchDiagnostics });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.pieces[0]).toMatchObject({ pieceId: "p1", name: "01", hasDraft: false, duration: 12, renderDiagnostics: [] });
    expect(r.data.pieces[1]).toMatchObject({ pieceId: "p2", hasDraft: true });
    expect(r.data.pieces[1].renderDiagnostics).toHaveLength(1);
    expect(r.data.pieces[1].renderDiagnostics![0]).toMatchObject({ overlayId: "p2-c", message: expect.stringContaining("heart is not defined"), messageSource: "overlay body (untrusted)" });
    expect(r.data.pieces[2]).toEqual({ pieceId: "ghost", error: "piece_not_found" });
    expect(r.data.summary).toBe("3 pieces: 1 clean, 1 with render diagnostics, 1 unreadable (02).");
  });
});
