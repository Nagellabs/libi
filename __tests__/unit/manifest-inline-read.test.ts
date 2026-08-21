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
