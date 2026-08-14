/**
 * Integration: evictProxiesIfOverBudget
 *
 * Verifies that the LRU sweep correctly evicts the oldest ready proxies
 * (oldest-first by proxyGeneratedAt) when total disk usage exceeds the
 * configured budget, and leaves proxies under budget untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb, seedPiece } from "../../helpers/test-db";

// Mock DB client and libi-home BEFORE importing modules that use them.
// dropProxyFile calls getLibiStorageDir() directly, so we must redirect it.
let storageBaseDir: string;

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return {
    ...actual,
    getLibiStorageDir: () => storageBaseDir,
  };
});
// navigationEmitter.emit is a side-effect we don't need in these tests.
vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));

import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

describe("evictProxiesIfOverBudget — integration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-lru-test-"));
    storageBaseDir = path.join(tmp, "storage");
    fs.mkdirSync(storageBaseDir, { recursive: true });
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  });

  afterEach(() => {
    vi.resetModules();
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Create a proxy file on disk AND insert a matching DB row.
   * `generatedAtMs` controls eviction order — older timestamps evicted first.
   */
  function makeProxy(
    pieceId: string,
    fileId: string,
    sizeBytes: number,
    generatedAtMs: number,
  ): void {
    const dir = path.join(storageBaseDir, pieceId);
    fs.mkdirSync(dir, { recursive: true });
    const proxyName = `${fileId}-proxy.mp4`;
    const proxyPath = path.join(dir, proxyName);
    fs.writeFileSync(proxyPath, Buffer.alloc(sizeBytes));

    const db = vi.mocked(getDb)();
    try {
      seedPiece(db, { id: pieceId, name: pieceId });
    } catch {
      /* piece may already exist */
    }
    db.insert(files)
      .values({
        id: fileId,
        pieceId,
        filename: `${fileId}.mp4`,
        name: fileId,
        description: "",
        storagePath: `${pieceId}/${fileId}.mp4`,
        type: "video",
        contentType: "video/mp4",
        size: sizeBytes * 5,
        proxyFilename: proxyName,
        proxyStatus: "ready",
        proxyGeneratedAt: new Date(generatedAtMs),
      })
      .run();
  }

  it("evicts oldest-first when over budget", async () => {
    // Budget = 100 bytes. Three proxies at 50 bytes each = 150 total.
    // Need to drop ≥ 50 bytes → oldest ("old") is evicted first.
    makeProxy("p", "old", 50, Date.now() - 30_000);
    makeProxy("p", "middle", 50, Date.now() - 20_000);
    makeProxy("p", "new", 50, Date.now() - 10_000);

    const { evictProxiesIfOverBudget } = await import("@/lib/proxy/lru");
    evictProxiesIfOverBudget({
      byteBudget: 100,
      storageBaseDir,
      inUseFileIds: new Set(),
    });

    const db = vi.mocked(getDb)();
    const oldRow = db.select().from(files).where(eq(files.id, "old")).all()[0];
    const middleRow = db.select().from(files).where(eq(files.id, "middle")).all()[0];
    const newRow = db.select().from(files).where(eq(files.id, "new")).all()[0];

    // "old" should be evicted: DB cleared, file gone from disk.
    expect(oldRow.proxyFilename).toBeNull();
    expect(oldRow.proxyStatus).toBe("idle");
    expect(fs.existsSync(path.join(storageBaseDir, "p", "old-proxy.mp4"))).toBe(false);

    // "middle" and "new" should survive.
    expect(middleRow.proxyFilename).toBe("middle-proxy.mp4");
    expect(newRow.proxyFilename).toBe("new-proxy.mp4");
    expect(fs.existsSync(path.join(storageBaseDir, "p", "middle-proxy.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(storageBaseDir, "p", "new-proxy.mp4"))).toBe(true);
  });

  it("no-op when under budget", async () => {
    makeProxy("p", "a", 30, Date.now() - 1_000);
    makeProxy("p", "b", 30, Date.now());

    const { evictProxiesIfOverBudget } = await import("@/lib/proxy/lru");
    evictProxiesIfOverBudget({
      byteBudget: 200,
      storageBaseDir,
      inUseFileIds: new Set(),
    });

    const db = vi.mocked(getDb)();
    const aRow = db.select().from(files).where(eq(files.id, "a")).all()[0];
    const bRow = db.select().from(files).where(eq(files.id, "b")).all()[0];

    expect(aRow.proxyFilename).toBe("a-proxy.mp4");
    expect(bRow.proxyFilename).toBe("b-proxy.mp4");
    expect(fs.existsSync(path.join(storageBaseDir, "p", "a-proxy.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(storageBaseDir, "p", "b-proxy.mp4"))).toBe(true);
  });
});
