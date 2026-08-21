import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getVersionHistory, getVersionDiff, commitDraft } from "@/lib/composition/lifecycle";
import { saveManifest } from "@/lib/composition/persistence";
import type { CompositionManifest, PersistedOverlay } from "@/lib/composition/persistence";
import { pieces } from "@/lib/db/schema/sqlite";
import { createTestDb, resetTestDb } from "../../helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";

const base = (): CompositionManifest => ({
  width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [],
});
/** A full-frame background layer — what the retired canvas scenes became. */
const canvas = (id: string, name: string): PersistedOverlay => ({
  id, kind: "code", displayName: name, startTime: 0, duration: 2, z: 0,
  rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "//",
} as PersistedOverlay);

let dir: string;
beforeEach(async () => {
  await createTestDb();
  dir = await createTempStorageDir();
  const db = (await import("@/lib/db/client")).getDb();
  db.insert(pieces).values({ id: "p1", name: "P", description: "" }).run();
});
afterEach(async () => { resetTestDb(); await cleanupTempDir(dir); });

describe("getVersionHistory", () => {
  it("orders draft → snapshot → history with per-row change counts", async () => {
    // commit v1, then v2, then leave a dirty draft
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A")] });
    await commitDraft("p1", { summary: "v1", actor: "user" });
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A"), canvas("b", "B")] });
    await commitDraft("p1", { summary: "v2", actor: "agent" });
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A"), canvas("b", "B"), canvas("c", "C")] });

    const history = await getVersionHistory("p1");
    expect(history.map((v) => v.kind)).toEqual(["draft", "snapshot", "history"]);
    expect(history[0]).toMatchObject({ kind: "draft", changeCount: 1 }); // +background c vs snapshot
    // Note: snapshot row actor is always "user" since the pieces table doesn't store actor
    expect(history[1]).toMatchObject({ kind: "snapshot", summary: "v2", actor: "user", changeCount: 1 }); // +b vs v1
    expect(history[2]).toMatchObject({ kind: "history", summary: "v1", changeCount: 1 }); // +a vs empty (initial)
  });

  it("counts DISTINCT missing files, not references (video overlay + its inline audio share one fileId)", async () => {
    // A video overlay + its auto-created inline audio clip both reference the
    // SAME (now-deleted) file. The row must report 1 missing FILE, not 2 references.
    await saveManifest("p1", {
      ...base(),
      overlays: [{
        id: "v", kind: "video", fileId: "ghost-file", displayName: "clip",
        startTime: 0, duration: 5, z: 0, opacity: 1, fit: "cover",
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
      }],
      audioClips: [{
        id: "ac", kind: "inline", fileId: "ghost-file", startTime: 0, duration: 5,
        trimStart: 0, volume: 1, enabled: true, linkedOverlayId: "v",
      }],
    });
    await commitDraft("p1", { summary: "vid", actor: "user" });

    const history = await getVersionHistory("p1");
    const snap = history.find((v) => v.kind === "snapshot")!;
    expect(snap.missingFileCount).toBe(1); // one deleted file, not two references

    // The detail still lists BOTH affected items so the user sees what breaks.
    const diff = await getVersionDiff("p1", snap.id);
    expect(diff.missingFiles).toHaveLength(2);
    expect(diff.missingFiles.map((m) => m.refKind).sort()).toEqual(["audio", "overlay"]);
    expect(new Set(diff.missingFiles.map((m) => m.fileId)).size).toBe(1);
  });
});

describe("getVersionDiff", () => {
  it("diffs a version against the next-older one and reports a restore impact for history rows", async () => {
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A")] });
    await commitDraft("p1", { summary: "v1", actor: "user" });
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A"), canvas("b", "B")] });
    await commitDraft("p1", { summary: "v2", actor: "agent" });

    const history = await getVersionHistory("p1");
    const v1 = history.find((v) => v.summary === "v1")!;
    const diff = await getVersionDiff("p1", v1.id);
    expect(diff.diff.overlays.added.map((o) => o.id)).toEqual(["a"]); // v1 vs empty
    // restore impact = v1 vs current snapshot (v2): restoring v1 removes layer b
    expect(diff.restoreImpact?.overlays.removed.map((o) => o.id)).toEqual(["b"]);
    expect(diff.missingFiles).toEqual([]);
  });

  it("diffs the draft sentinel against the current snapshot", async () => {
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A")] });
    await commitDraft("p1", { summary: "v1", actor: "user" });
    await saveManifest("p1", { ...base(), overlays: [canvas("a", "A"), canvas("b", "B")] });
    const diff = await getVersionDiff("p1", "draft");
    expect(diff.diff.overlays.added.map((o) => o.id)).toEqual(["b"]);
    expect(diff.restoreImpact).toBeNull();
  });
});
