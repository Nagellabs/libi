import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import { pieces } from "@/lib/db/schema/sqlite";
import { saveManifest, loadManifest } from "@/lib/composition/persistence";
import { commitDraft, discardDraft, restoreSnapshot, getPieceState } from "@/lib/composition/lifecycle";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { eq } from "drizzle-orm";

describe("snapshot/draft end-to-end", () => {
  beforeEach(() => { createTestDb(); createTempStorageDir(); });
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("creates piece, edits, commits, edits more, discards, restores", async () => {
    const db = createTestDb();
    const [piece] = await db.insert(pieces).values({ name: "e2e" }).returning();

    // Initial state: no snapshot, no draft
    let state = await getPieceState(piece.id);
    expect(state.hasDraft).toBe(false);

    // Edit 1 → creates draft
    await saveManifest(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v1", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
    });
    state = await getPieceState(piece.id);
    expect(state.hasDraft).toBe(true);

    // Commit → draft becomes snapshot
    await commitDraft(piece.id, { summary: "v1", actor: "agent" });
    state = await getPieceState(piece.id);
    expect(state.hasDraft).toBe(false);
    expect((await loadCurrentSnapshot(piece.id))?.overlays?.[0].displayName).toBe("v1");

    // Edit 2 → new draft on top
    await saveManifest(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v2", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
    });
    state = await getPieceState(piece.id);
    expect(state.hasDraft).toBe(true);
    expect((await loadManifest(piece.id)).overlays?.[0].displayName).toBe("v2");
    expect((await loadCurrentSnapshot(piece.id))?.overlays?.[0].displayName).toBe("v1");

    // Discard → back to snapshot
    await discardDraft(piece.id);
    state = await getPieceState(piece.id);
    expect(state.hasDraft).toBe(false);
    expect((await loadManifest(piece.id)).overlays?.[0].displayName).toBe("v1");

    // Edit 3 + commit (so history has 2 entries: original v1 + this one)
    await saveManifest(piece.id, {
      width: 1920, height: 1080, fps: 30,
      overlays: [{ id: "code-s1", kind: "code" as const, displayName: "v3", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
    });
    const commit2 = await commitDraft(piece.id, { summary: "v3", actor: "agent" });
    expect(commit2.snapshotId).toBeTruthy();

    // Restore the old "v1" snapshot from history
    state = await getPieceState(piece.id);
    expect(state.recentSnapshots.length).toBeGreaterThanOrEqual(1);
    const oldSnapId = state.recentSnapshots[state.recentSnapshots.length - 1].id; // oldest
    await restoreSnapshot(piece.id, oldSnapId);
    expect((await loadCurrentSnapshot(piece.id))?.overlays?.[0].displayName).toBe("v1");
  });
});
