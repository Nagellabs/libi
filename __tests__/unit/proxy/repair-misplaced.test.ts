/**
 * The startup repair for files assign_file moved before it carried their
 * derived artifacts (lib/proxy/repair-misplaced.ts): the state the bug left on
 * existing installs, rebuilt on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

import { sweepMisplacedFileArtifacts } from "@/lib/proxy/repair-misplaced";
import { listEvictedProxies } from "@/lib/proxy/evicted";

let tmp: string;
let storage: string;

function insert(id: string, pieceId: string | null, filename: string, proxyFilename: string | null) {
  testDb
    .insert(files)
    .values({
      id, pieceId, filename, name: filename, description: "", type: "video",
      storagePath: `${pieceId ?? "_global"}/${filename}`, contentType: "video/mp4", size: 1,
      proxyFilename, proxyStatus: proxyFilename ? "ready" : "idle",
      proxyGeneratedAt: proxyFilename ? new Date() : null,
    })
    .run();
}
function write(rel: string, body = "x") {
  const p = path.join(storage, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const row = (id: string) => testDb.select().from(files).where(eq(files.id, id)).all()[0];

describe("sweepMisplacedFileArtifacts", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-repair-misplaced-"));
    process.env.LIBI_HOME = tmp;
    storage = path.join(tmp, "storage");
    testDb = createTestDb();
    seedPiece(testDb, { id: "p" });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("resets a 'ready' proxy left in the library folder, queues its re-make, and deletes the stray copy", async () => {
    // What the bug left: the row in piece p, its proxy and analysis in _global.
    insert("f1", "p", "clip.mp4", "clip-proxy.mp4");
    write("p/clip.mp4");
    write("_global/clip-proxy.mp4");
    write("_global/_analysis/f1/frames/frame-0001.png");

    const res = sweepMisplacedFileArtifacts();

    expect(res).toEqual({ proxiesReset: 1, analysisMoved: 1 });
    expect(row("f1").proxyStatus).toBe("idle");
    expect(row("f1").proxyFilename).toBeNull();
    expect(listEvictedProxies().f1).toBeDefined();
    expect(fs.existsSync(path.join(storage, "_global", "clip-proxy.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(storage, "p", "_analysis", "f1", "frames", "frame-0001.png"))).toBe(true);
  });

  it("leaves a library file's own proxy alone when a piece row's proxy shares its name", async () => {
    insert("f1", "p", "clip.mp4", "clip-proxy.mp4");
    write("p/clip.mp4");
    insert("g1", null, "clip.mp4", "clip-proxy.mp4");
    write("_global/clip.mp4");
    write("_global/clip-proxy.mp4", "g1's proxy");

    sweepMisplacedFileArtifacts();

    expect(row("f1").proxyStatus).toBe("idle");
    expect(row("g1").proxyStatus).toBe("ready");
    expect(fs.readFileSync(path.join(storage, "_global", "clip-proxy.mp4"), "utf8")).toBe("g1's proxy");
  });

  it("is a no-op on healthy rows and analysis folders already in place", async () => {
    insert("f1", "p", "clip.mp4", "clip-proxy.mp4");
    write("p/clip.mp4");
    write("p/clip-proxy.mp4");
    write("p/_analysis/f1/frames/frame-0001.png");

    expect(sweepMisplacedFileArtifacts()).toEqual({ proxiesReset: 0, analysisMoved: 0 });
    expect(row("f1").proxyStatus).toBe("ready");
    expect(listEvictedProxies().f1).toBeUndefined();
  });

  it("never moves an analysis folder over one already in the right scope, nor one with no row", async () => {
    insert("f1", "p", "clip.mp4", null);
    write("_global/_analysis/f1/old.txt", "old");
    write("p/_analysis/f1/new.txt", "new");
    write("_global/_analysis/ghost/x.txt");

    expect(sweepMisplacedFileArtifacts().analysisMoved).toBe(0);
    expect(fs.existsSync(path.join(storage, "p", "_analysis", "f1", "new.txt"))).toBe(true);
    expect(fs.existsSync(path.join(storage, "_global", "_analysis", "ghost", "x.txt"))).toBe(true);
  });
});
