import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { loadManifest, saveManifest, type PersistedCanvasScene } from "@/lib/composition/persistence";
import { loadCurrentSnapshot } from "@/lib/composition/snapshots";
import { getLibiStorageDir } from "@/lib/libi-home";
import { pieces as piecesTable } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

describe("loadManifest — inlined scenes", () => {
  afterEach(() => cleanupTempDir());

  it("returns scenes when stored inline in composition.json", async () => {
    vi.resetModules();
    createTempStorageDir();

    // Re-import after module reset to pick up fresh singleton
    const { loadManifest: lm } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");

    const pieceId = "p1";
    const dir = path.join(gsd(), pieceId);
    fs.mkdirSync(dir, { recursive: true });

    const scene: PersistedCanvasScene = {
      id: "s1",
      type: "canvas",
      name: "Hello",
      duration: 3,
      drawFunction: "// noop",
    };
    const manifest = {
      sceneOrder: ["s1"],
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [scene],
    };
    fs.writeFileSync(path.join(dir, "composition.json"), JSON.stringify(manifest));

    const loaded = await lm(pieceId);
    expect(loaded.scenes).toEqual([scene]);
    expect(loaded.sceneOrder).toEqual(["s1"]);
  });

  it("falls back to sharded scene files when scenes absent (legacy format)", async () => {
    vi.resetModules();
    createTempStorageDir();

    // Re-import after module reset to pick up fresh singleton
    const { loadManifest: lm } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");

    const pieceId = "p2";
    const dir = path.join(gsd(), pieceId);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(
      path.join(dir, "composition.json"),
      JSON.stringify({ sceneOrder: ["s1"], width: 1920, height: 1080, fps: 30 }),
    );
    fs.writeFileSync(
      path.join(dir, "scene-s1.json"),
      JSON.stringify({
        id: "s1",
        type: "canvas",
        name: "Legacy",
        duration: 2,
        drawFunction: "// l",
      }),
    );

    const loaded = await lm(pieceId);
    expect(loaded.scenes?.length).toBe(1);
    expect(loaded.scenes?.[0]).toMatchObject({ id: "s1", name: "Legacy" });
  });
});

describe("saveManifest — writes inlined + cleans up shards", () => {
  afterEach(() => cleanupTempDir());

  it("writes scenes inline and deletes orphaned shard files", async () => {
    vi.resetModules();
    createTempStorageDir();

    const { saveManifest: sm } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");

    const pieceId = "p3";
    const dir = path.join(gsd(), pieceId);
    fs.mkdirSync(dir, { recursive: true });

    // Pre-existing orphan shard (legacy)
    fs.writeFileSync(
      path.join(dir, "scene-old.json"),
      JSON.stringify({ id: "old", type: "canvas", name: "Old", duration: 1, drawFunction: "" }),
    );

    const scene: PersistedCanvasScene = {
      id: "s1",
      type: "canvas",
      name: "Hello",
      duration: 3,
      drawFunction: "// noop",
    };
    await sm(pieceId, {
      sceneOrder: ["s1"],
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [scene],
    });

    const written = JSON.parse(fs.readFileSync(path.join(dir, "composition.json"), "utf-8"));
    expect(written.scenes).toEqual([scene]);
    expect(fs.existsSync(path.join(dir, "scene-old.json"))).toBe(false);
  });

  it("preserves shard files that match current sceneOrder", async () => {
    vi.resetModules();
    createTempStorageDir();

    const { saveManifest: sm } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir: gsd } = await import("@/lib/libi-home");

    const pieceId = "p4";
    const dir = path.join(gsd(), pieceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "scene-s1.json"),
      JSON.stringify({ id: "s1", type: "canvas", name: "x", duration: 1, drawFunction: "" }),
    );

    await sm(pieceId, {
      sceneOrder: ["s1"],
      width: 1920,
      height: 1080,
      fps: 30,
      scenes: [{ id: "s1", type: "canvas", name: "x", duration: 1, drawFunction: "" }],
    });

    expect(fs.existsSync(path.join(dir, "scene-s1.json"))).toBe(true); // matched, kept
  });
});

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
      JSON.stringify({ sceneOrder: [], width: 1920, height: 1080, fps: 30 }),
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
        sceneOrder: [],
        width: 1920,
        height: 1080,
        fps: 30,
        scenes: [{ id: "s", type: "canvas", name: "draft", duration: 1, drawFunction: "" }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "snapshots/current.json"),
      JSON.stringify({
        sceneOrder: [],
        width: 1920,
        height: 1080,
        fps: 30,
        scenes: [{ id: "s", type: "canvas", name: "snapshot", duration: 1, drawFunction: "" }],
      }),
    );

    await lm(piece.id);

    const snap = await lcs(piece.id);
    expect(snap?.scenes?.[0].name).toBe("snapshot");
  });
});
