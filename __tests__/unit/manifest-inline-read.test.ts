import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { getLibiStorageDir } from "@/lib/libi-home";
import { pieces as piecesTable } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

describe("loadManifest — lazy snapshot init", () => {
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("creates snapshots/current.json on first load if missing, leaves hasDraft=false", async () => {
    vi.resetModules();
    createTestDb();
    createTempStorageDir();

    const db = createTestDb();
    const { loadManifest: lm } = await import("@/lib/composition/persistence");
    const { loadCurrentSnapshot: lcs } = await import("@/lib/composition/snapshots");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");
    const { pieces: pt } = await import("@/lib/db/schema/sqlite");

    const [piece] = await db.insert(pt).values({ name: "legacy", hasDraft: false }).returning();
    const dir = path.join(gsd(), piece.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "composition.json"),
      JSON.stringify({ width: 1920, height: 1080, fps: 30 }),
    );

    await lm(piece.id);

    expect(await lcs(piece.id)).not.toBeNull();
    const [after] = await db.select().from(pt).where(eq(pt.id, piece.id));
    expect(after.hasDraft).toBe(false);
  });

  it("does not overwrite existing snapshot on subsequent loads", async () => {
    vi.resetModules();
    createTestDb();
    createTempStorageDir();

    const db = createTestDb();
    const { loadManifest: lm } = await import("@/lib/composition/persistence");
    const { loadCurrentSnapshot: lcs } = await import("@/lib/composition/snapshots");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");
    const { pieces: pt } = await import("@/lib/db/schema/sqlite");

    const [piece] = await db.insert(pt).values({ name: "p", hasDraft: true }).returning();
    const dir = path.join(gsd(), piece.id);
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "composition.json"),
      JSON.stringify({
        width: 1920,
        height: 1080,
        fps: 30,
        overlays: [{ id: "code-s", kind: "code" as const, displayName: "draft", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "snapshots/current.json"),
      JSON.stringify({
        width: 1920,
        height: 1080,
        fps: 30,
        overlays: [{ id: "code-s", kind: "code" as const, displayName: "snapshot", startTime: 0, duration: 1, z: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 }, opacity: 1, drawFunction: "" }],
      }),
    );

    await lm(piece.id);

    const snap = await lcs(piece.id);
    expect(snap?.overlays?.[0].displayName).toBe("snapshot");
  });
});

// Final review P3: an editor still open on a piece the user just deleted asks for its
// composition once more, and the lazy init used to write `snapshots/current.json` — re-creating
// the storage folder the piece DELETE had just removed.
describe("loadManifest — a deleted piece", () => {
  afterEach(() => { resetTestDb(); cleanupTempDir(); });

  it("writes no snapshot and re-creates no folder once the piece row is gone", async () => {
    vi.resetModules();
    createTempStorageDir();
    const db = createTestDb();
    const { loadManifest: lm } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");
    const { pieces: pt } = await import("@/lib/db/schema/sqlite");

    const [piece] = await db.insert(pt).values({ name: "doomed" }).returning();
    await lm(piece.id); // open: the lazy init writes the first snapshot
    const dir = path.join(gsd(), piece.id);
    expect(fs.existsSync(path.join(dir, "snapshots/current.json"))).toBe(true);

    // What the piece DELETE route does: row, then folder.
    await db.delete(pt).where(eq(pt.id, piece.id));
    fs.rmSync(dir, { recursive: true, force: true });

    const m = await lm(piece.id);
    expect(m.overlays ?? []).toEqual([]);
    expect(m.width).toBe(1920);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("still initialises the snapshot of a brand-new piece that has no folder yet", async () => {
    vi.resetModules();
    createTempStorageDir();
    const db = createTestDb();
    const { loadManifest: lm } = await import("@/lib/composition/persistence");
    const { loadCurrentSnapshot: lcs } = await import("@/lib/composition/snapshots");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");
    const { pieces: pt } = await import("@/lib/db/schema/sqlite");

    const [piece] = await db.insert(pt).values({ name: "fresh" }).returning();
    expect(fs.existsSync(path.join(gsd(), piece.id))).toBe(false);
    await lm(piece.id);
    expect(await lcs(piece.id)).not.toBeNull();
  });
});
