/**
 * agent-speed C1: discard and restore are recoverable. The draft a discard
 * drops, or a restore replaces, is kept as a hidden recoverable draft
 * (`snapshots/recoverable/`), 7 days, never in the user's history, brought back
 * by `restoreSnapshot` with its `rec-` id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { discardDraft, restoreSnapshot, commitDraft, getPieceState } from "@/lib/composition/lifecycle";
import {
  listRecoverableDrafts,
  keepDraft,
  RECOVERABLE_DAYS,
  RECOVERABLE_MAX,
} from "@/lib/composition/recoverable";
import { saveManifest, loadManifest, type PersistedOverlay } from "@/lib/composition/persistence";
import { saveCurrentSnapshot, listSnapshotHistory, pushSnapshotToHistory } from "@/lib/composition/snapshots";
import { getVersionHistory } from "@/lib/composition/lifecycle";
import { pieces } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { loadStoryboard, saveStoryboard } from "@/lib/storyboard/repo";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";

const layer = (id: string, name: string): PersistedOverlay =>
  ({ id, kind: "code", displayName: name, startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "// body" }) as PersistedOverlay;
const manifest = (...overlays: PersistedOverlay[]) => ({ width: 1920, height: 1080, fps: 30, overlays });

let db: ReturnType<typeof createTestDb>;
beforeEach(() => {
  db = createTestDb();
  createTempStorageDir();
});
afterEach(() => {
  vi.useRealTimers();
  resetTestDb();
  cleanupTempDir();
});

async function pieceWithDraft(hasDraft = true) {
  const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: false }).returning();
  await saveCurrentSnapshot(piece.id, manifest(layer("a", "snapshot version")));
  await saveManifest(piece.id, manifest(layer("a", "draft version"), layer("b", "extra")));
  if (!hasDraft) await db.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, piece.id));
  return piece.id;
}

describe("discardDraft keeps the draft", () => {
  it("returns the kept draft, resets to the snapshot, and the draft comes back with its rec- id", async () => {
    const id = await pieceWithDraft();
    const kept = await discardDraft(id);
    expect(kept).toMatchObject({ kind: "discarded", overlays: 2, audioClips: 0 });
    expect(kept!.id).toMatch(/^rec-/);
    expect((await loadManifest(id)).overlays?.map((o) => o.displayName)).toEqual(["snapshot version"]);

    const back = await restoreSnapshot(id, kept!.id);
    expect(back).toMatchObject({ recoveredDraft: true, draftKept: null });
    expect((await loadManifest(id)).overlays?.map((o) => o.displayName)).toEqual(["draft version", "extra"]);
    const [row] = await db.select().from(pieces).where(eq(pieces.id, id));
    expect(row.hasDraft).toBe(true);
    // The committed snapshot was never touched.
    expect((await getPieceState(id)).snapshotSummary).toBeNull();
    // Recovered: the entry is gone.
    expect(await listRecoverableDrafts(id)).toEqual([]);
  });

  it("the storyboard comes back with the composition", async () => {
    const id = await pieceWithDraft();
    const sb = { version: 2, cardOrder: [], cards: [], overview: "the draft's board", updatedAt: "2026-10-03T00:00:00.000Z" } as never;
    await saveStoryboard(id, sb);
    const kept = await discardDraft(id);
    expect(await loadStoryboard(id)).toBeNull();
    await restoreSnapshot(id, kept!.id);
    expect((await loadStoryboard(id))?.overview).toBe("the draft's board");
  });

  it("keeps nothing when there is no draft", async () => {
    const id = await pieceWithDraft(false);
    expect(await discardDraft(id)).toBeNull();
    expect(await listRecoverableDrafts(id)).toEqual([]);
  });

  it("never shows in the user's history or the version timeline", async () => {
    const id = await pieceWithDraft();
    await discardDraft(id);
    expect(await listSnapshotHistory(id)).toEqual([]);
    expect((await getPieceState(id)).recentSnapshots).toEqual([]);
    expect((await getVersionHistory(id)).map((v) => v.kind)).toEqual(["snapshot"]);
  });
});

describe("restoreSnapshot keeps the draft it replaces", () => {
  async function pieceWithHistory(withDraft: boolean) {
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: false }).returning();
    await saveCurrentSnapshot(piece.id, manifest(layer("a", "current")));
    await saveManifest(piece.id, manifest(layer("a", "current")));
    const oldId = await pushSnapshotToHistory(piece.id, manifest(layer("a", "older")), { summary: "older", actor: "user" });
    if (withDraft) await saveManifest(piece.id, manifest(layer("a", "current"), layer("draft-only", "unsaved work")));
    else await db.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, piece.id));
    return { id: piece.id, oldId };
  }

  it("a restore with a draft keeps the draft, and recovering it puts the restore back as the draft", async () => {
    const { id, oldId } = await pieceWithHistory(true);
    const r = await restoreSnapshot(id, oldId);
    expect(r).toMatchObject({ recoveredDraft: false, draftKept: { kind: "before-restore", overlays: 2 } });
    expect((await loadManifest(id)).overlays?.map((o) => o.displayName)).toEqual(["older"]);

    // Undo it: the unsaved work returns as the draft.
    const undo = await restoreSnapshot(id, r.draftKept!.id);
    expect(undo.recoveredDraft).toBe(true);
    expect((await loadManifest(id)).overlays?.map((o) => o.displayName)).toEqual(["current", "unsaved work"]);
  });

  it("a restore with no draft keeps no draft (the committed snapshot is archived to history, as before)", async () => {
    const { id, oldId } = await pieceWithHistory(false);
    const r = await restoreSnapshot(id, oldId);
    expect(r.draftKept).toBeNull();
    expect((await listSnapshotHistory(id)).some((h) => h.summary === "Pre-restore snapshot")).toBe(true);
  });

  it("recovering a draft keeps the draft it replaces too, so recovering is undoable", async () => {
    const id = await pieceWithDraft();
    const kept = await discardDraft(id);
    await saveManifest(id, manifest(layer("z", "newer work")));
    const r = await restoreSnapshot(id, kept!.id);
    expect(r.draftKept).toMatchObject({ kind: "before-recover" });
    const again = await restoreSnapshot(id, r.draftKept!.id);
    expect(again.recoveredDraft).toBe(true);
    expect((await loadManifest(id)).overlays?.map((o) => o.displayName)).toEqual(["newer work"]);
  });

  it("an unknown or malformed rec- id is refused and nothing changes", async () => {
    const id = await pieceWithDraft();
    await expect(restoreSnapshot(id, "rec-nope")).rejects.toThrow(/No recoverable draft/);
    await expect(restoreSnapshot(id, "rec-../../x")).rejects.toThrow(/No recoverable draft/);
    expect((await loadManifest(id)).overlays).toHaveLength(2);
  });
});

describe("kept drafts expire", () => {
  it("are gone after the days, and not before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    const id = await pieceWithDraft();
    const kept = await discardDraft(id);
    vi.setSystemTime(new Date(Date.now() + (RECOVERABLE_DAYS - 1) * 86_400_000));
    expect((await listRecoverableDrafts(id)).map((e) => e.id)).toEqual([kept!.id]);
    vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
    expect(await listRecoverableDrafts(id)).toEqual([]);
    await expect(restoreSnapshot(id, kept!.id)).rejects.toThrow(/older than 7 days/);
    // The file went with the entry.
    const dir = path.join(getLibiStorageDir(), id, "snapshots", "recoverable");
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("rec-"))).toEqual([]);
  });

  it("at most RECOVERABLE_MAX are kept, the oldest out", async () => {
    const id = await pieceWithDraft();
    const m = await loadManifest(id);
    const ids: string[] = [];
    for (let i = 0; i < RECOVERABLE_MAX + 2; i++) ids.push((await keepDraft(id, "discarded", m)).id);
    const live = (await listRecoverableDrafts(id)).map((e) => e.id);
    expect(live).toHaveLength(RECOVERABLE_MAX);
    expect(live).toEqual(ids.slice(2).reverse());
  });
});

describe("a commit leaves kept drafts alone", () => {
  it("a draft kept before a commit is still recoverable after it", async () => {
    const id = await pieceWithDraft();
    const kept = await discardDraft(id);
    await saveManifest(id, manifest(layer("a", "new draft")));
    await commitDraft(id, { summary: "saved", actor: "user" });
    expect((await listRecoverableDrafts(id)).map((e) => e.id)).toEqual([kept!.id]);
  });
});
