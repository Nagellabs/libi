/**
 * A manifest from libi 0.1.0/0.1.1 may still carry canvas `scenes` /
 * `sceneOrder`. The layer is gone (f0e0a410) and loadManifest drops it — which
 * used to happen without a trace: a user's old layers just vanished, and the
 * Electron export spec failed "nothing to export" for weeks before anyone saw
 * why (docs-local/qa/2026-09-26-e2e-fixes-report.md).
 *
 * Now the load counts them, logs ONCE per piece (tag + op, piece id + count,
 * never a scene's content), and GET /api/pieces/:id/composition returns the
 * count so the editor can tell the user once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  return { ...actual, serverLogger: new Proxy(actual.serverLogger, {
    get: (target, prop, receiver) => (prop === "warn" ? warn : Reflect.get(target, prop, receiver)),
  }) };
});

import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import { createTestDb, resetTestDb } from "../../helpers/test-db";

const DRAW = "const { ctx } = context; ctx.fillStyle = 'SECRET-SCENE-BODY'; ctx.fillRect(0, 0, 10, 10);";

function writeManifest(storageDir: string, pieceId: string, manifest: unknown) {
  const dir = path.join(storageDir, pieceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "composition.json"), JSON.stringify(manifest));
}

const LEGACY = {
  width: 320,
  height: 180,
  fps: 30,
  audioClips: [],
  overlays: [],
  sceneOrder: ["s1", "s2"],
  scenes: [
    { id: "s1", type: "canvas", name: "Intro", duration: 1, drawFunction: DRAW },
    { id: "s2", type: "canvas", name: "Outro", duration: 1, drawFunction: DRAW },
  ],
};

describe("legacy canvas scenes on load", () => {
  beforeEach(() => {
    vi.resetModules();
    warn.mockClear();
    createTestDb();
    createTempStorageDir();
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir();
  });

  async function load() {
    const persistence = await import("@/lib/composition/persistence");
    const { getLibiStorageDir } = await import("@/lib/libi-home");
    return { ...persistence, storageDir: getLibiStorageDir() };
  }

  const scenesWarnings = () =>
    warn.mock.calls.filter(([fields]) => (fields as { op?: string }).op === "legacy_scenes_dropped");

  it("drops them, reports the count, and logs once — tag, op, piece id and count only", async () => {
    const { loadComposition, loadManifest, storageDir } = await load();
    writeManifest(storageDir, "p-legacy", LEGACY);

    const first = await loadComposition("p-legacy");
    expect(first.legacyScenes).toBe(2);
    expect(first.manifest).not.toHaveProperty("scenes");
    expect(first.manifest).not.toHaveProperty("sceneOrder");

    // Every later load still counts them (the file keeps them until a save) but never logs again.
    expect((await loadComposition("p-legacy")).legacyScenes).toBe(2);
    await loadManifest("p-legacy");

    const calls = scenesWarnings();
    expect(calls).toHaveLength(1);
    const [fields] = calls[0];
    expect(fields).toEqual({ tag: "overlay", op: "legacy_scenes_dropped", pieceId: "p-legacy", count: 2 });
    expect(JSON.stringify(calls[0])).not.toContain("SECRET-SCENE-BODY");
    expect(JSON.stringify(calls[0])).not.toContain("Intro");
  });

  it("a piece without scenes reports 0 and logs nothing", async () => {
    const { loadComposition, storageDir } = await load();
    writeManifest(storageDir, "p-modern", { ...LEGACY, scenes: undefined, sceneOrder: undefined });
    expect((await loadComposition("p-modern")).legacyScenes).toBe(0);
    expect(scenesWarnings()).toHaveLength(0);
  });

  it("the file keeps the scenes until the piece is saved; after a save there are none", async () => {
    const { loadManifest, saveManifest, loadComposition, storageDir } = await load();
    writeManifest(storageDir, "p-save", LEGACY);
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(storageDir, "p-save", "composition.json"), "utf-8"));

    const manifest = await loadManifest("p-save");
    expect(onDisk().scenes).toHaveLength(2);

    await saveManifest("p-save", manifest);
    expect(onDisk()).not.toHaveProperty("scenes");
    expect((await loadComposition("p-save")).legacyScenes).toBe(0);
  });

  it("a pre-0.1.0 manifest with only `sceneOrder` (scenes in shards) is counted too", async () => {
    const { loadComposition, storageDir } = await load();
    writeManifest(storageDir, "p-shards", { ...LEGACY, scenes: undefined, sceneOrder: ["a", "b", "c"] });
    expect((await loadComposition("p-shards")).legacyScenes).toBe(3);
    expect(scenesWarnings()).toHaveLength(1);
  });

  async function getComposition(pieceId: string) {
    const { GET } = await import("@/app/api/pieces/[pieceId]/composition/route");
    const res = await GET(new Request(`http://127.0.0.1/api/pieces/${pieceId}/composition`), {
      params: Promise.resolve({ pieceId }),
    });
    return (await res.json()) as { legacyScenes: number; legacyScenesNoticed: boolean; manifest: Record<string, unknown> };
  }

  async function acknowledge(pieceId: string) {
    const { POST } = await import("@/app/api/pieces/[pieceId]/composition/legacy-scenes-notice/route");
    const res = await POST(new Request(`http://127.0.0.1/api/pieces/${pieceId}/composition/legacy-scenes-notice`, { method: "POST" }), {
      params: Promise.resolve({ pieceId }),
    });
    expect(res.status).toBe(200);
  }

  it("GET /api/pieces/:id/composition carries the count and whether the user was told", async () => {
    const { storageDir } = await load();
    writeManifest(storageDir, "p-route", LEGACY);
    const body = await getComposition("p-route");
    expect(body.legacyScenes).toBe(2);
    expect(body.legacyScenesNoticed).toBe(false);
    expect(body.manifest).not.toHaveProperty("scenes");
  });

  it("'told' is kept in the settings row, so it holds on the next launch (a fresh process, a new origin)", async () => {
    const { storageDir } = await load();
    writeManifest(storageDir, "p-told", LEGACY);
    writeManifest(storageDir, "p-other", LEGACY);
    await acknowledge("p-told");
    await acknowledge("p-told"); // idempotent

    // Next launch: every module fresh; only the database carries over.
    vi.resetModules();
    expect((await getComposition("p-told")).legacyScenesNoticed).toBe(true);
    expect((await getComposition("p-other")).legacyScenesNoticed).toBe(false);

    const { getDb } = await import("@/lib/db/client");
    const { settings } = await import("@/lib/db/schema/sqlite");
    const [row] = getDb().select({ ids: settings.legacyScenesNoticed }).from(settings).all();
    expect(JSON.parse(row.ids ?? "[]")).toEqual(["p-told"]);
  });

  it("acknowledging a piece without legacy scenes, or an unknown id, answers 404 and records nothing", async () => {
    const { storageDir } = await load();
    writeManifest(storageDir, "p-modern", { ...LEGACY, scenes: undefined, sceneOrder: undefined });
    const { POST } = await import("@/app/api/pieces/[pieceId]/composition/legacy-scenes-notice/route");
    for (const pieceId of ["p-modern", "p-missing"]) {
      const res = await POST(new Request(`http://127.0.0.1/api/pieces/${pieceId}/composition/legacy-scenes-notice`, { method: "POST" }), {
        params: Promise.resolve({ pieceId }),
      });
      expect(res.status).toBe(404);
    }
    const { getDb } = await import("@/lib/db/client");
    const { settings } = await import("@/lib/db/schema/sqlite");
    const [row] = getDb().select({ ids: settings.legacyScenesNoticed }).from(settings).all();
    expect(JSON.parse(row?.ids ?? "[]")).toEqual([]);
  });

  it("deleting a piece forgets its id", async () => {
    const { storageDir } = await load();
    const { getDb } = await import("@/lib/db/client");
    const { pieces, settings } = await import("@/lib/db/schema/sqlite");
    const [piece] = await getDb().insert(pieces).values({ name: "legacy" }).returning();
    writeManifest(storageDir, piece.id, LEGACY);
    await acknowledge(piece.id);
    writeManifest(storageDir, "p-keep", LEGACY);
    await acknowledge("p-keep");

    const { deletePieceCompletely } = await import("@/lib/pieces/delete-piece");
    expect(await deletePieceCompletely(piece.id)).toBe(true);
    const [row] = getDb().select({ ids: settings.legacyScenesNoticed }).from(settings).all();
    expect(JSON.parse(row.ids ?? "[]")).toEqual(["p-keep"]);
  });
});
