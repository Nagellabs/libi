/**
 * The draft transaction behind libi.apply_ops: edits made through the ordinary `loadManifest` /
 * `saveManifest` seam land in an in-memory copy, reach the disk in ONE save at commit, and not at all when
 * the transaction is dropped, with any other piece or request still reading the disk meanwhile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
let storage: LocalFileStorage;
vi.mock("@/lib/storage", () => ({ getStorage: async () => storage }));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));

import {
  loadComposition,
  loadManifest,
  manifestFingerprint,
  saveManifest,
  updateOverlayInManifest,
  type CompositionManifest,
} from "@/lib/composition/persistence";
import { beginManifestTransaction, ManifestChangedError } from "@/lib/composition/manifest-transaction";

const text = (id: string, startTime = 0) =>
  ({ id, kind: "text", startTime, duration: 2, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, content: id, font: "20px Inter", color: "#fff", align: "left" }) as never;

const manifest = (): CompositionManifest => ({ width: 1080, height: 1920, fps: 30, overlays: [text("a"), text("b", 5)], audioClips: [] });

async function seed(id: string) {
  seedPiece(testDb, { id });
  await saveManifest(id, manifest());
  testDb.update(pieces).set({ hasDraft: false }).where(eq(pieces.id, id)).run();
}

const hasDraft = (id: string) => testDb.select().from(pieces).where(eq(pieces.id, id)).get()!.hasDraft;

describe("manifest transaction", () => {
  beforeEach(async () => {
    tempDir = createTempStorageDir();
    storage = new LocalFileStorage(tempDir);
    testDb = createTestDb();
    await seed("p1");
    await seed("p2");
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("edits inside it read back inside it and reach nothing else until commit", async () => {
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      expect(await updateOverlayInManifest("p1", "a", { startTime: 3 })).toBe(true);
      expect((await loadManifest("p1")).overlays!.find((o) => o.id === "a")!.startTime).toBe(3);
      expect((await loadComposition("p1")).manifest.overlays!.find((o) => o.id === "a")!.startTime).toBe(3);
    });
    // outside the scope, and on disk, nothing happened
    expect((await loadManifest("p1")).overlays!.find((o) => o.id === "a")!.startTime).toBe(0);
    expect(hasDraft("p1")).toBe(false);
    expect(txn.baseline.overlays!.find((o) => o.id === "a")!.startTime).toBe(0);
    expect(txn.changed()).toBe(true);
  });

  it("another request, in the middle of a transaction, still reads the disk", async () => {
    const txn = await beginManifestTransaction("p1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = txn.run(async () => {
      await updateOverlayInManifest("p1", "a", { startTime: 4 });
      await gate; // the transaction is open and holding an edit
    });
    await new Promise((r) => setTimeout(r, 5));
    // a request that did not start inside the transaction (the editor's GET, another tool call) sees the disk
    expect((await loadManifest("p1")).overlays!.find((o) => o.id === "a")!.startTime).toBe(0);
    release();
    await running;
    expect(txn.working.overlays!.find((o) => o.id === "a")!.startTime).toBe(4);
  });

  it("another piece inside the same scope still reads and writes the disk", async () => {
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      await updateOverlayInManifest("p2", "a", { startTime: 9 });
    });
    expect((await loadManifest("p2")).overlays!.find((o) => o.id === "a")!.startTime).toBe(9);
    expect(txn.changed()).toBe(false);
  });

  it("commit writes the working copy once and flips hasDraft", async () => {
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      await updateOverlayInManifest("p1", "a", { startTime: 3 });
      await updateOverlayInManifest("p1", "b", { duration: 7 });
    });
    const save = vi.spyOn(storage, "save");
    expect(await txn.commit()).toEqual({ written: true });
    expect(save.mock.calls.filter((c) => c[1] === "composition.json")).toHaveLength(1);
    const m = await loadManifest("p1");
    expect(m.overlays!.find((o) => o.id === "a")!.startTime).toBe(3);
    expect(m.overlays!.find((o) => o.id === "b")!.duration).toBe(7);
    expect(hasDraft("p1")).toBe(true);
  });

  it("dropping a transaction (never committing) leaves the draft byte for byte as it was", async () => {
    const before = await storage.read("p1", "composition.json");
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      await updateOverlayInManifest("p1", "a", { startTime: 3 });
      await updateOverlayInManifest("p1", "b", { duration: 7 });
    });
    expect((await storage.read("p1", "composition.json")).equals(before)).toBe(true);
    expect(hasDraft("p1")).toBe(false);
  });

  it("a save that leaves the manifest as it was is not a change, and commit writes nothing", async () => {
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      await saveManifest("p1", await loadManifest("p1"));
    });
    expect(txn.changed()).toBe(false);
    expect(await txn.commit()).toEqual({ written: false });
    expect(hasDraft("p1")).toBe(false);
  });

  it("commit refuses, writing nothing, when the piece changed on disk while the transaction ran", async () => {
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      await updateOverlayInManifest("p1", "a", { startTime: 3 });
    });
    // the user edits the piece meanwhile
    await updateOverlayInManifest("p1", "b", { startTime: 6 });
    const theirs = await storage.read("p1", "composition.json");
    await expect(txn.commit()).rejects.toBeInstanceOf(ManifestChangedError);
    expect((await storage.read("p1", "composition.json")).equals(theirs)).toBe(true);
    expect((await loadManifest("p1")).overlays!.find((o) => o.id === "a")!.startTime).toBe(0);
  });

  it("two transactions on one piece: the second commit finds the first's write and refuses", async () => {
    const first = await beginManifestTransaction("p1");
    const second = await beginManifestTransaction("p1");
    await first.run(() => updateOverlayInManifest("p1", "a", { startTime: 1 }));
    await second.run(() => updateOverlayInManifest("p1", "b", { startTime: 2 }));
    const results = await Promise.allSettled([first.commit(), second.commit()]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    const m = await loadManifest("p1");
    expect(m.overlays!.find((o) => o.id === "a")!.startTime).toBe(1);
    expect(m.overlays!.find((o) => o.id === "b")!.startTime).toBe(5);
  });

  it("a code overlay's body is written to its file at commit, not before", async () => {
    const code = { id: "c1", kind: "code", startTime: 0, duration: 2, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, drawFunction: "ctx.fillRect(0, 0, 1, 1);" } as never;
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      const m = await loadManifest("p1");
      m.overlays!.push(code);
      await saveManifest("p1", m);
    });
    expect(await storage.exists("p1", "overlays/c1/draw.jsx")).toBe(false);
    await txn.commit();
    expect((await storage.read("p1", "overlays/c1/draw.jsx")).toString()).toContain("fillRect");
    expect((await loadManifest("p1")).overlays!.some((o) => o.id === "c1")).toBe(true);
  });

  it("saves inside it are normalized the way a disk save normalizes them", async () => {
    const txn = await beginManifestTransaction("p1");
    await txn.run(async () => {
      const m = await loadManifest("p1");
      // a point-text overlay's rect is DERIVED on every save from its anchor + position
      Object.assign(m.overlays![0], { anchor: "top-left", position: { x: 40, y: 60 }, rect: { x: 0, y: 0, width: 1, height: 1 } });
      await saveManifest("p1", m);
      const rect = (await loadManifest("p1")).overlays![0].rect;
      expect(rect.x).toBe(40);
      expect(rect.y).toBe(60);
    });
  });

  it("fingerprints composition.json bytes, and an absent one as the empty string", async () => {
    expect(await manifestFingerprint("p1")).toMatch(/^[0-9a-f]{40}$/);
    seedPiece(testDb, { id: "empty" });
    expect(await manifestFingerprint("empty")).toBe("");
  });
});
