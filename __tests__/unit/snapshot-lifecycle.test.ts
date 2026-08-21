import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { compareStates, commitDraft, discardDraft, restoreSnapshot, getPieceState } from "@/lib/composition/lifecycle";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";
import { saveManifest, loadManifest } from "@/lib/composition/persistence";
import { saveCurrentSnapshot, listSnapshotHistory } from "@/lib/composition/snapshots";
import { pieces } from "@/lib/db/schema/sqlite";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";

const baseManifest = (): CompositionManifest => ({
  width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [],
});

/** A full-frame background layer — what the retired canvas scenes became. */
const scene = (id: string, name: string, duration = 2): PersistedOverlay => ({
  id, kind: "code", displayName: name, startTime: 0, duration, z: 0,
  rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "// noop",
} as PersistedOverlay);

describe("compareStates", () => {
  it("zero diff for identical manifests", () => {
    const m = baseManifest();
    const diff = compareStates(m, m);
    expect(diff.totalChanges).toBe(0);
    expect(diff.overlays).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("counts overlay add/remove/change", () => {
    const o = (id: string, content: string) => ({
      id, kind: "text" as const, startTime: 0, duration: 1,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      z: 0, opacity: 1, content, font: "Arial", color: "#fff", align: "left" as const,
    });
    const snap: CompositionManifest = { ...baseManifest(), overlays: [o("1", "hi")] };
    const draft: CompositionManifest = { ...baseManifest(), overlays: [o("1", "bye"), o("2", "new")] };
    const diff = compareStates(snap, draft);
    expect(diff.overlays).toEqual({ added: 1, removed: 0, changed: 1 });
  });
});

describe("commitDraft", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("promotes draft to snapshot, clears hasDraft, stores new summary, pushes OLD summary to history", async () => {
    const db = createTestDb();
    // Seed piece with an existing committed snapshot summary
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: true, snapshotSummary: "v1 baseline" }).returning();

    // Seed snapshot (v1) + draft (v2) on disk
    await saveCurrentSnapshot(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v1", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] });
    await saveManifest(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v2", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] });

    const result = await commitDraft(piece.id, { summary: "promoted v2", actor: "user" });
    expect(result.snapshotId).toMatch(/^snap-/);
    expect(result.summary).toBe("promoted v2");

    const [after] = await db.select().from(pieces).where(eq(pieces.id, piece.id));
    expect(after.hasDraft).toBe(false);
    expect(after.snapshotSummary).toBe("promoted v2"); // new summary persisted
    expect(after.snapshotCommittedAt).not.toBeNull(); // dedicated commit timestamp set

    const snap = await loadManifest(piece.id);
    expect(snap.overlays?.[0].displayName).toBe("v2");

    // OLD snapshot (v1) now lives in history WITH its original summary preserved
    const history = await listSnapshotHistory(piece.id);
    expect(history).toHaveLength(1);
    expect(history[0].summary).toBe("v1 baseline");
  });

  it("first commit of a brand-new piece does NOT archive the empty placeholder snapshot", async () => {
    const db = createTestDb();
    // Brand-new piece: never committed (no summary, no committedAt).
    const [piece] = await db.insert(pieces).values({ name: "fresh" }).returning();

    // loadManifest lazy-inits current.json = EMPTY_MANIFEST (the live path that
    // every agent tool hits before the first edit), THEN the user adds scenes.
    await loadManifest(piece.id);
    await saveManifest(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [{ id: "code-s1", kind: "code" as const, displayName: "first", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
    });

    await commitDraft(piece.id, { summary: "first save", actor: "user" });

    // No phantom "Previous snapshot" — the empty placeholder is suppressed.
    expect(await listSnapshotHistory(piece.id)).toHaveLength(0);

    // A SECOND commit archives the real first snapshot — and only that one.
    await saveManifest(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [
        { id: "code-s1", kind: "code" as const, displayName: "first", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" },
        { id: "code-s2", kind: "code" as const, displayName: "second", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" },
      ],
    });
    await commitDraft(piece.id, { summary: "second save", actor: "user" });

    const history = await listSnapshotHistory(piece.id);
    expect(history).toHaveLength(1);
    expect(history[0].summary).toBe("first save");
  });

  it("first commit of a NON-empty backfilled snapshot (legacy piece) still archives it", async () => {
    const db = createTestDb();
    // Legacy piece: never went through commitDraft (committedAt null) but has a
    // real backfilled current snapshot. That content must NOT be suppressed.
    const [piece] = await db.insert(pieces).values({ name: "legacy" }).returning();
    await saveCurrentSnapshot(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [{ id: "code-s0", kind: "code" as const, displayName: "legacy content", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
    });
    await saveManifest(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [
        { id: "code-s0", kind: "code" as const, displayName: "legacy content", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" },
        { id: "code-s1", kind: "code" as const, displayName: "new edit", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" },
      ],
    });

    await commitDraft(piece.id, { summary: "first post-feature save", actor: "user" });

    const history = await listSnapshotHistory(piece.id);
    expect(history).toHaveLength(1);
  });
});

describe("discardDraft", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("copies snapshot to composition, clears hasDraft", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: true }).returning();
    await saveCurrentSnapshot(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v1", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] });
    await saveManifest(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v2", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] });

    await discardDraft(piece.id);

    const restored = await loadManifest(piece.id);
    expect(restored.overlays?.[0].displayName).toBe("v1");
    const [after] = await db.select().from(pieces).where(eq(pieces.id, piece.id));
    expect(after.hasDraft).toBe(false);
  });
});

describe("restoreSnapshot", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("promotes a history snapshot to current and archives the old current", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: false }).returning();
    await saveCurrentSnapshot(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "current", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] });
    await saveManifest(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "current", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] });
    const { pushSnapshotToHistory } = await import("@/lib/composition/snapshots");
    const oldId = await pushSnapshotToHistory(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "code-s1", kind: "code" as const, displayName: "older", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }] }, { summary: "older", actor: "user" });

    await restoreSnapshot(piece.id, oldId);

    const live = await loadManifest(piece.id);
    expect(live.overlays?.[0].displayName).toBe("older");
    const history = await listSnapshotHistory(piece.id);
    expect(history.find((h) => h.id === oldId)).toBeUndefined(); // removed from history
    expect(history.some((h) => h.summary === "Pre-restore snapshot")).toBe(true); // old current archived

    const [after] = await db.select().from(pieces).where(eq(pieces.id, piece.id));
    expect(after.snapshotSummary).toBe("older");
    expect(after.hasDraft).toBe(false);
  });
});

describe("getPieceState", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("returns hasDraft + recent snapshots", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: true }).returning();
    const { pushSnapshotToHistory } = await import("@/lib/composition/snapshots");
    await pushSnapshotToHistory(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [] }, { summary: "h1", actor: "agent" });

    const state = await getPieceState(piece.id);
    expect(state.hasDraft).toBe(true);
    expect(state.recentSnapshots).toHaveLength(1);
    expect(state.recentSnapshots[0].summary).toBe("h1");
  });
});

describe("saveManifest — has_draft flag", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("flips hasDraft to true when manifest is saved", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: false }).returning();
    await saveManifest(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [] });
    const [after] = await db.select().from(pieces).where(eq(pieces.id, piece.id));
    expect(after.hasDraft).toBe(true);
  });

  it("is a no-op when hasDraft is already true", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "p", hasDraft: true }).returning();
    const originalUpdate = piece.updatedAt;
    await new Promise((r) => setTimeout(r, 1100)); // updatedAt resolution = 1 second
    await saveManifest(piece.id, { width: 1920, height: 1080, fps: 30, overlays: [] });
    const [after] = await db.select().from(pieces).where(eq(pieces.id, piece.id));
    expect(after.hasDraft).toBe(true);
    // updatedAt should not have changed because we skipped the UPDATE
    expect(after.updatedAt.getTime()).toBe(originalUpdate.getTime());
  });
});
